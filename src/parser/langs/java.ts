import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { field, isConstName, lastSegment, simpleReceiver } from '../spec.js';

const MAX_SIG_SLICE = 400;
const TYPE_DECLS = [
  'class_declaration', 'interface_declaration', 'enum_declaration',
  'record_declaration', 'annotation_type_declaration',
];

function modifiersOf(node: Node): Node | null {
  const first = node.firstChild;
  if (first && first.type === 'modifiers') return first;
  // A leading comment inside the declaration is possible but rare.
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'modifiers') return c;
    if (c.type !== 'line_comment' && c.type !== 'block_comment') break;
  }
  return null;
}

function hasModifier(mods: Node | null, keyword: string): boolean {
  if (!mods) return false;
  for (const c of mods.children) if (c && c.type === keyword) return true;
  return false;
}

/**
 * Offset where the signature starts: after leading annotations, so that
 * `@Override @SuppressWarnings("x") public void foo()` yields `public void foo()`.
 */
function sigStart(node: Node, mods: Node | null): number {
  if (!mods) return node.startIndex;
  for (const c of mods.children) {
    if (!c) continue;
    if (c.type === 'annotation' || c.type === 'marker_annotation') continue;
    if (c.type === 'line_comment' || c.type === 'block_comment') continue;
    return c.startIndex;
  }
  const next = mods.nextSibling;
  return next ? next.startIndex : node.startIndex;
}

function sliceSig(ctx: Ctx, start: number, end: number): string {
  if (end - start > MAX_SIG_SLICE) end = start + MAX_SIG_SLICE;
  return ctx.src.slice(start, end).replace(/\s*[{;]\s*$/, '');
}

/** Signature from after the annotations up to the body (or the node end). */
function signature(node: Node, mods: Node | null, ctx: Ctx, body: Node | null = field(node, 'body')): string {
  const start = sigStart(node, mods);
  return sliceSig(ctx, start, body && body.startIndex > start ? body.startIndex : node.endIndex);
}

/** Simple name of a type node: strips generics, package qualifiers, annotations and array dims. */
function typeName(node: Node | null | undefined): string | null {
  let n = node ?? null;
  for (let i = 0; n && i < 4; i++) {
    switch (n.type) {
      case 'type_identifier':
      case 'identifier':
        return n.text;
      case 'generic_type':
        n = n.namedChild(0);
        break;
      case 'scoped_type_identifier':
        n = n.namedChild(n.namedChildCount - 1);
        break;
      case 'array_type':
        n = field(n, 'element');
        break;
      default:
        if (n.endIndex - n.startIndex > 200) return null;
        return lastSegment(n.text.replace(/<.*$/s, '').replace(/[\[\]\s]+$/, ''));
    }
  }
  return null;
}

const MAX_TYPE_TEXT = 120;

/**
 * Raw text of a declared type for ctx.typeHint (which normalises it), or null
 * for types that never name the class of the variable: arrays, primitives.
 */
function hintType(type: Node | null | undefined): string | null {
  let n = type ?? null;
  if (n && n.type === 'annotated_type') n = n.namedChild(n.namedChildCount - 1);
  if (!n) return null;
  switch (n.type) {
    case 'type_identifier':
    case 'scoped_type_identifier':
      return n.endIndex - n.startIndex > MAX_TYPE_TEXT ? null : n.text;
    case 'generic_type':
      // Long generic types: the outer name is enough (wrappers are not unwrapped then).
      return n.endIndex - n.startIndex > MAX_TYPE_TEXT ? typeName(n) : n.text;
    default:
      return null; // array_type, integral_type, boolean_type, void_type, ...
  }
}

/** Declared type of a declarator: the written type, or the constructed class for `var x = new Foo()`. */
function declaredType(type: Node | null, value: Node | null): string | null {
  if (!type) return null;
  if (type.type === 'type_identifier' && type.endIndex - type.startIndex === 3 && type.text === 'var') {
    return value && value.type === 'object_creation_expression' ? hintType(field(value, 'type')) : null;
  }
  return hintType(type);
}

/** Parameters, lambda parameters with explicit types and record components. */
const formalParameter: Visitor = (node, ctx) => {
  if (field(node, 'dimensions')) return;
  ctx.typeHint(field(node, 'name')?.text, hintType(field(node, 'type')));
};

/** Varargs `Foo... rest`: the type is the first non-modifier child, the name sits in a variable_declarator. */
const spreadParameter: Visitor = (node, ctx) => {
  let type: Node | null = null;
  let name: Node | null = null;
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'variable_declarator') name = field(c, 'name');
    else if (c.type !== 'modifiers' && !type) type = c;
  }
  if (name) ctx.typeHint(name.text, hintType(type));
};

/** `catch (IOException e)`; multi-catch `A | B e` has no single type. */
const catchParameter: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  for (const c of node.namedChildren) {
    if (!c || c.type !== 'catch_type') continue;
    if (c.namedChildCount === 1) ctx.typeHint(name.text, hintType(c.namedChild(0)));
    return;
  }
};

/** `for (Item it : items)` and try-with-resources `Reader r = open()`. */
const typedName: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (name && name.type === 'identifier') ctx.typeHint(name.text, declaredType(field(node, 'type'), field(node, 'value')));
};

/** Pattern variable: `o instanceof Foo f`. */
const instanceofExpression: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (name) ctx.typeHint(name.text, hintType(field(node, 'right')));
};

/** True when a member sits in an anonymous class body (`new Foo() { ... }`). */
function inAnonymousClass(member: Node): boolean {
  const body = member.parent;
  return !!body && body.type === 'class_body' && body.parent?.type === 'object_creation_expression';
}

function memberExported(mods: Node | null, ctx: Ctx): boolean {
  if (hasModifier(mods, 'public')) return true;
  return ctx.parentKind() === 'interface' && !hasModifier(mods, 'private');
}

function typeList(sym: number, list: Node | null, kind: 'extends' | 'implements', ctx: Ctx): void {
  if (!list) return;
  for (const c of list.namedChildren) {
    if (!c) continue;
    if (c.type === 'type_list') typeList(sym, c, kind, ctx);
    else ctx.inherit(sym, typeName(c), kind);
  }
}

const typeDecl = (kind: 'class' | 'interface' | 'enum'): Visitor => (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const mods = modifiersOf(node);
  const exported = hasModifier(mods, 'public');
  const sym = ctx.def(node, { name: name.text, kind, sig: signature(node, mods, ctx), exported });

  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'superclass') typeList(sym, c, 'extends', ctx);
    else if (c.type === 'super_interfaces') typeList(sym, c, 'implements', ctx);
    else if (c.type === 'extends_interfaces') typeList(sym, c, 'extends', ctx);
  }

  if (node.type === 'record_declaration') {
    // Record components are implicit private fields with public accessors.
    for (const p of field(node, 'parameters')?.namedChildren ?? []) {
      if (!p || p.type !== 'formal_parameter') continue;
      const pName = field(p, 'name');
      if (pName) ctx.def(p, { name: pName.text, kind: 'field', sig: signature(p, modifiersOf(p), ctx, null), scope: false, exported });
    }
  }
};

const method: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  // Methods of anonymous classes are not symbols; calls inside them are
  // attributed to the enclosing method / field.
  if (inAnonymousClass(node)) return;
  const mods = modifiersOf(node);
  ctx.def(node, {
    name: name.text,
    kind: 'method',
    sig: signature(node, mods, ctx),
    exported: memberExported(mods, ctx),
  });
};

const annotationElement: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.def(node, { name: name.text, kind: 'method', sig: signature(node, modifiersOf(node), ctx, null), exported: true });
};

const enumConstant: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const enumDecl = node.parent?.parent;
  const mods = modifiersOf(node);
  ctx.def(node, {
    name: name.text,
    kind: 'constant',
    sig: signature(node, mods, ctx),
    exported: !!enumDecl && hasModifier(modifiersOf(enumDecl), 'public'),
  });
};

/**
 * Fields and interface constants: one symbol per declarator. Locals are not
 * symbols; they only contribute a receiver type hint.
 */
const variableDeclarator: Visitor = (node, ctx) => {
  const decl = node.parent;
  if (!decl) return;
  const isInterfaceConst = decl.type === 'constant_declaration';
  const isField = isInterfaceConst || decl.type === 'field_declaration';
  if (!isField && decl.type !== 'local_variable_declaration') return;
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const type = field(node, 'dimensions') ? null : declaredType(field(decl, 'type'), field(node, 'value'));
  if (!isField || inAnonymousClass(decl)) {
    if (type) ctx.typeHint(name, type);
    return;
  }
  const mods = modifiersOf(decl);

  // Signature: modifiers + type + this declarator (with a short initializer).
  const start = sigStart(decl, mods);
  const value = field(node, 'value');
  const declEnd = value && node.endIndex - node.startIndex > 100 ? value.startIndex : node.endIndex;
  let sig: string;
  if (start <= node.startIndex) {
    const first = decl.childForFieldName('declarator');
    const head = ctx.src.slice(start, Math.min(first ? first.startIndex : node.startIndex, start + MAX_SIG_SLICE));
    sig = head + ctx.src.slice(node.startIndex, declEnd);
  } else {
    sig = ctx.src.slice(node.startIndex, declEnd);
  }
  sig = sig.replace(/\s*=\s*$/, '');

  const isConst = isInterfaceConst || (hasModifier(mods, 'static') && hasModifier(mods, 'final') && isConstName(name));
  ctx.def(node, {
    name,
    kind: isConst ? 'constant' : 'field',
    range: decl,
    sig,
    exported: memberExported(mods, ctx),
  });
  // The field symbol is not a container, so the hint lands on the enclosing class.
  if (type) ctx.typeHint(name, type);
};

const methodInvocation: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const object = field(node, 'object');
  if (!object) {
    ctx.call(name.text, node);
    return;
  }
  // `Outer.super.foo()`: object is `Outer`, followed by `.` and `super`.
  const qualifiedSuper = object.nextSibling?.nextSibling?.type === 'super';
  ctx.call(name.text, node, qualifiedSuper ? 'super' : simpleReceiver(object));
};

const objectCreation: Visitor = (node, ctx) => {
  ctx.call(typeName(field(node, 'type')), node);
};

/** `this(...)` / `super(...)` inside a constructor. */
const explicitConstructorInvocation: Visitor = (node, ctx) => {
  const target = field(node, 'constructor');
  if (!target) return;
  let cls: Node | null = node.parent;
  for (let i = 0; cls && i < 6 && !TYPE_DECLS.includes(cls.type); i++) cls = cls.parent;
  if (!cls || !TYPE_DECLS.includes(cls.type)) return;
  if (target.type === 'this') {
    ctx.call(field(cls, 'name')?.text, node);
  } else if (target.type === 'super') {
    const sup = field(cls, 'superclass');
    if (sup) ctx.call(typeName(sup.namedChild(0)), node);
  }
};

/** `Foo::bar` counts as a call to `bar`; `Foo::new` as a call to `Foo`. */
const methodReference: Visitor = (node, ctx) => {
  const target = node.child(0);
  const member = node.child(node.childCount - 1);
  if (!target || !member) return;
  if (member.type === 'identifier') ctx.call(member.text, node, simpleReceiver(target));
  else if (member.type === 'new') ctx.call(typeName(target), node);
};

const importDeclaration: Visitor = (node, ctx) => {
  let name: Node | null = null;
  let wildcard = false;
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'scoped_identifier' || c.type === 'identifier') name = c;
    else if (c.type === 'asterisk') wildcard = true;
  }
  if (!name) return;
  const source = name.text.replace(/\s+/g, '');
  if (wildcard) ctx.imp(source + '.*', node, ['*']);
  else ctx.imp(source, node, [lastSegment(source)]);
};

export const java: LangSpec = {
  id: 'java',
  grammar: 'java',
  extensions: ['.java'],
  identifiers: ['identifier', 'type_identifier'],
  visit: {
    class_declaration: typeDecl('class'),
    record_declaration: typeDecl('class'),
    interface_declaration: typeDecl('interface'),
    annotation_type_declaration: typeDecl('interface'),
    enum_declaration: typeDecl('enum'),
    enum_constant: enumConstant,
    method_declaration: method,
    constructor_declaration: method,
    compact_constructor_declaration: method,
    annotation_type_element_declaration: annotationElement,
    variable_declarator: variableDeclarator,
    formal_parameter: formalParameter,
    spread_parameter: spreadParameter,
    catch_formal_parameter: catchParameter,
    enhanced_for_statement: typedName,
    resource: typedName,
    instanceof_expression: instanceofExpression,
    method_invocation: methodInvocation,
    object_creation_expression: objectCreation,
    explicit_constructor_invocation: explicitConstructorInvocation,
    method_reference: methodReference,
    import_declaration: importDeclaration,
  },
};
