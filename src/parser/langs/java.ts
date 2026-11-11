import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { field, isConstName, lastSegment } from '../spec.js';

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

function shortReceiver(node: Node | null): string | null {
  if (!node || node.endIndex - node.startIndex > 40) return null;
  const t = node.text;
  return /[\s(]/.test(t) ? null : t;
}

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

/** Fields and interface constants: one symbol per declarator. Locals are ignored. */
const variableDeclarator: Visitor = (node, ctx) => {
  const decl = node.parent;
  if (!decl) return;
  const isInterfaceConst = decl.type === 'constant_declaration';
  if (!isInterfaceConst && decl.type !== 'field_declaration') return;
  if (inAnonymousClass(decl)) return;
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const name = nameNode.text;
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
};

const methodInvocation: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.call(name.text, node, shortReceiver(field(node, 'object')));
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
  if (member.type === 'identifier') ctx.call(member.text, node, shortReceiver(target));
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
    method_invocation: methodInvocation,
    object_creation_expression: objectCreation,
    explicit_constructor_invocation: explicitConstructorInvocation,
    method_reference: methodReference,
    import_declaration: importDeclaration,
  },
};
