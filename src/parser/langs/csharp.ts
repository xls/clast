import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { COMPLEX_RECEIVER, field, lastSegment, simpleReceiver } from '../spec.js';
import type { SymbolKind } from '../../types.js';

const MAX_SIG_SLICE = 400;
const TYPE_DECLS = ['class_declaration', 'struct_declaration', 'record_declaration', 'record_struct_declaration'];

function hasModifier(node: Node, keyword: string): boolean {
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'modifier') {
      // `modifier` is a tiny leaf-like node: its text is the keyword.
      if (c.text === keyword) return true;
    } else if (c.type !== 'attribute_list' && c.type !== 'comment') {
      break; // modifiers only appear at the start of a declaration
    }
  }
  return false;
}

/** Offset where the signature starts: after leading `[Attribute]` lists. */
function sigStart(node: Node): number {
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'attribute_list' || c.type === 'comment' || c.type.startsWith('preproc_')) continue;
    return c.startIndex;
  }
  return node.startIndex;
}

/** Signature from after the attributes up to `end` (body start or node end). */
function signature(node: Node, ctx: Ctx, bodyNode: Node | null = field(node, 'body')): string {
  const start = sigStart(node);
  let end = bodyNode && bodyNode.startIndex > start ? bodyNode.startIndex : node.endIndex;
  if (end - start > MAX_SIG_SLICE) end = start + MAX_SIG_SLICE;
  return ctx.src.slice(start, end).replace(/\s*[{;]\s*$/, '');
}

/**
 * `///` XML documentation directly above `range`, with the XML markup removed.
 * Returns undefined when there is none so that the default comment lookup applies.
 */
function xmlDoc(range: Node): string | undefined {
  const lines: string[] = [];
  let nextRow = range.startPosition.row;
  let prev = range.previousSibling;
  while (prev && prev.type === 'comment' && lines.length < 60) {
    if (prev.endPosition.row < nextRow - 1) break;
    const t = prev.text;
    if (!t.startsWith('///')) break;
    lines.unshift(t.replace(/^\/\/\/ ?/, ''));
    nextRow = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  if (lines.length === 0) return undefined;
  const doc = lines
    .join('\n')
    .replace(/<(?:see|seealso|paramref|typeparamref)\s+(?:cref|name|langword|href)\s*=\s*"(?:[A-Z]:)?([^"]*)"\s*\/>/g, '$1')
    .replace(/<param(?:ref)?\s+name\s*=\s*"([^"]*)"\s*>/g, '$1: ')
    .replace(/<typeparam\s+name\s*=\s*"([^"]*)"\s*>/g, '$1: ')
    .replace(/<returns>/g, 'Returns: ')
    .replace(/<\/?[A-Za-z][^<>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');
  return doc || undefined;
}

/** Simple name of a type / name node: strips generics, namespaces, `?` and array ranks. */
function simpleName(node: Node | null | undefined): string | null {
  let n = node ?? null;
  for (let i = 0; n && i < 5; i++) {
    switch (n.type) {
      case 'identifier':
        return n.text;
      case 'generic_name':
        n = n.namedChild(0);
        break;
      case 'qualified_name':
      case 'alias_qualified_name':
        n = field(n, 'name');
        break;
      case 'nullable_type':
      case 'array_type':
        n = field(n, 'type') ?? n.namedChild(0);
        break;
      case 'predefined_type':
        return null;
      default:
        if (n.endIndex - n.startIndex > 200) return null;
        return lastSegment(n.text.replace(/<.*$/s, '').replace(/[\[\]?\s]+$/, ''));
    }
  }
  return null;
}

/**
 * Receiver text of a member call: `_next`, `this._next`, `base`, `app.Services`.
 * Null-conditional and null-forgiving operators are dropped (`x?.Inner` ->
 * `x.Inner`, `x!` -> `x`); call chains and other expressions yield '?'.
 * Never null: a member call always has a receiver.
 */
function receiverOf(node: Node | null): string {
  if (!node) return COMPLEX_RECEIVER;
  if (node.type === 'generic_name') return node.namedChild(0)?.text ?? COMPLEX_RECEIVER; // `Foo<int>.Create()`
  const r = simpleReceiver(node);
  if (!r || r === COMPLEX_RECEIVER) return COMPLEX_RECEIVER;
  return r.includes('?') || r.includes('!') ? r.replace(/[?!]/g, '') || COMPLEX_RECEIVER : r;
}

const MAX_TYPE_TEXT = 120;

/**
 * Raw text of a declared type for ctx.typeHint (which normalises it), or null
 * for types that never name the class of the variable: `var`, arrays, tuples,
 * predefined types.
 */
function hintType(type: Node | null | undefined): string | null {
  let n = type ?? null;
  if (n && n.type === 'nullable_type') n = field(n, 'type') ?? n.namedChild(0);
  if (!n) return null;
  switch (n.type) {
    case 'identifier':
    case 'qualified_name':
    case 'alias_qualified_name':
      return n.endIndex - n.startIndex > MAX_TYPE_TEXT ? null : n.text;
    case 'generic_name':
      // Long generic types: the outer name is enough (wrappers are not unwrapped then).
      return n.endIndex - n.startIndex > MAX_TYPE_TEXT ? simpleName(n) : n.text;
    default:
      return null; // implicit_type, predefined_type, array_type, tuple_type, pointer_type, ...
  }
}

/**
 * Declared type of a declarator: the written type, or for `var` the class
 * named by the initializer: `new Foo(...)`, `(Foo)x`, `x as Foo`.
 */
function declaredType(type: Node | null, declarator: Node): string | null {
  if (!type) return null;
  if (type.type !== 'implicit_type') return hintType(type);
  if (declarator.namedChildCount < 2) return null;
  const value = declarator.namedChild(declarator.namedChildCount - 1);
  if (!value) return null;
  switch (value.type) {
    case 'object_creation_expression':
    case 'cast_expression':
      return hintType(field(value, 'type'));
    case 'as_expression':
      return hintType(field(value, 'right'));
    default:
      return null;
  }
}

/** Node types that declare one typed name through `type` and `name` fields. */
const typedName: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (name && name.type === 'identifier') ctx.typeHint(name.text, hintType(field(node, 'type')));
};

/**
 * Method, lambda and local function parameters (incl. `this Foo x`, `out`,
 * `ref`, `in`). Primary-constructor parameters of classes, structs and records
 * act like fields and are attached to the type.
 */
const parameter: Visitor = (node, ctx) => {
  const type = field(node, 'type');
  const name = field(node, 'name');
  if (!type || !name) return;
  const owner = node.parent?.parent;
  if (!owner || owner.type === 'delegate_declaration') return;
  ctx.typeHint(name.text, hintType(type), TYPE_DECLS.includes(owner.type));
};

/** `foreach (Item it in items)`. */
const foreachStatement: Visitor = (node, ctx) => {
  const left = field(node, 'left');
  if (left && left.type === 'identifier') ctx.typeHint(left.text, hintType(field(node, 'type')));
};

/** `[Authorize]` refers to the class `AuthorizeAttribute`. */
const attribute: Visitor = (node, ctx) => {
  const name = simpleName(field(node, 'name'));
  if (name && !name.endsWith('Attribute')) ctx.ref(name + 'Attribute', node);
};

function memberExported(node: Node, ctx: Ctx): boolean {
  if (hasModifier(node, 'public')) return true;
  if (ctx.parentKind() !== 'interface') return false;
  return !hasModifier(node, 'private') && !hasModifier(node, 'protected') && !hasModifier(node, 'internal');
}

function isRecordStruct(node: Node): boolean {
  if (node.type === 'record_struct_declaration') return true;
  if (node.type !== 'record_declaration') return false;
  const name = field(node, 'name');
  for (const c of node.children) {
    if (!c || c === name || (name && c.startIndex >= name.startIndex)) break;
    if (c.type === 'struct') return true;
  }
  return false;
}

function baseList(node: Node, sym: number, kind: SymbolKind, ctx: Ctx): void {
  let list: Node | null = null;
  for (const c of node.namedChildren) {
    if (c && c.type === 'base_list') { list = c; break; }
  }
  if (!list) return;
  for (const b of list.namedChildren) {
    if (!b || b.type === 'argument_list' || b.type === 'comment') continue;
    // `record R(int X) : Base(X)` wraps the base in primary_constructor_base_type.
    const target = b.type === 'primary_constructor_base_type' ? (field(b, 'type') ?? b.namedChild(0)) : b;
    const name = simpleName(target);
    if (!name) continue;
    let rel: 'extends' | 'implements';
    if (kind === 'interface') rel = 'extends';
    else if (kind === 'struct') rel = 'implements';
    else rel = /^I[A-Z]/.test(name) ? 'implements' : 'extends';
    ctx.inherit(sym, name, rel);
  }
}

const typeDecl = (declKind: 'class' | 'struct' | 'interface'): Visitor => (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const kind: SymbolKind = declKind === 'class' && isRecordStruct(node) ? 'struct' : declKind;
  const exported = hasModifier(node, 'public');
  const sym = ctx.def(node, {
    name: name.text,
    kind,
    sig: signature(node, ctx),
    doc: xmlDoc(node),
    exported,
  });
  baseList(node, sym, kind, ctx);

  if (node.type === 'record_declaration' || node.type === 'record_struct_declaration') {
    // Positional record parameters become public properties.
    for (const c of node.namedChildren) {
      if (!c || c.type !== 'parameter_list') continue;
      for (const p of c.namedChildren) {
        if (!p || p.type !== 'parameter') continue;
        const pName = field(p, 'name');
        if (pName) ctx.def(p, { name: pName.text, kind: 'property', body: null, scope: false, exported });
      }
    }
  }
};

const enumDecl: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.def(node, {
    name: name.text,
    kind: 'enum',
    sig: signature(node, ctx),
    doc: xmlDoc(node),
    exported: hasModifier(node, 'public'),
  });
};

const enumMember: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const decl = node.parent?.parent;
  ctx.def(node, {
    name: name.text,
    kind: 'constant',
    sig: signature(node, ctx, null),
    doc: xmlDoc(node),
    exported: !!decl && hasModifier(decl, 'public'),
  });
};

const delegateDecl: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.def(node, {
    name: name.text,
    kind: 'type',
    sig: signature(node, ctx, null),
    doc: xmlDoc(node),
    exported: hasModifier(node, 'public'),
  });
};

const callable = (nameOf: (node: Node, ctx: Ctx) => string | null | undefined, kind: SymbolKind = 'method'): Visitor =>
  (node, ctx) => {
    const name = nameOf(node, ctx);
    if (!name) return;
    ctx.def(node, {
      name,
      kind,
      sig: signature(node, ctx),
      doc: xmlDoc(node),
      exported: memberExported(node, ctx),
    });
  };

const fieldName = (node: Node): string | undefined => field(node, 'name')?.text;

const operatorName = (node: Node, ctx: Ctx): string | null => {
  const op = field(node, 'operator');
  if (op) return 'operator ' + op.text;
  // Fallback: text between the `operator` keyword and the parameter list.
  const params = field(node, 'parameters');
  if (!params) return null;
  const head = ctx.src.slice(Math.max(node.startIndex, params.startIndex - 40), params.startIndex);
  const m = /operator\s*(\S+)\s*$/.exec(head);
  return m ? 'operator ' + m[1] : null;
};

const conversionOperatorName = (node: Node): string | null => {
  const type = field(node, 'type');
  if (!type || type.endIndex - type.startIndex > 80) return null;
  return 'operator ' + type.text.replace(/\s+/g, ' ');
};

const localFunction: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  ctx.def(node, { name: name.text, kind: 'function', sig: signature(node, ctx), doc: xmlDoc(node) });
};

/** True if every accessor is of the bodiless `get; set; init;` form. */
function autoAccessors(accessors: Node): boolean {
  if (accessors.endIndex - accessors.startIndex > 60) return false;
  for (const a of accessors.namedChildren) {
    if (!a) continue;
    if (a.type !== 'accessor_declaration' || field(a, 'body')) return false;
  }
  return true;
}

const propertyLike = (nameOf: (node: Node) => string | undefined, typed = false): Visitor => (node, ctx) => {
  const name = nameOf(node);
  if (!name) return;
  const accessors = field(node, 'accessors');
  const value = field(node, 'value');
  let sig: string;
  if (accessors) {
    sig = signature(node, ctx, accessors);
    if (autoAccessors(accessors)) sig += ' ' + accessors.text.replace(/\s+/g, ' ');
  } else {
    sig = signature(node, ctx, value);
  }
  ctx.def(node, {
    name,
    kind: 'property',
    sig,
    doc: xmlDoc(node),
    exported: memberExported(node, ctx),
  });
  // The property symbol is not a container, so the hint lands on the enclosing type.
  if (typed) ctx.typeHint(name, hintType(field(node, 'type')));
};

/**
 * Fields and field-like events: one symbol per declarator. Locals (also in
 * `using` / `for` / `fixed` statements) are not symbols; they only contribute
 * a receiver type hint.
 */
const variableDeclarator: Visitor = (node, ctx) => {
  const declaration = node.parent;
  const decl = declaration?.parent;
  if (!declaration || !decl || declaration.type !== 'variable_declaration') return;
  const nameNode = field(node, 'name') ?? node.namedChild(0);
  if (!nameNode || nameNode.type !== 'identifier') return;
  if (decl.type !== 'field_declaration' && decl.type !== 'event_field_declaration') {
    ctx.typeHint(nameNode.text, declaredType(field(declaration, 'type'), node));
    return;
  }

  // Signature: modifiers + type + this declarator (with a short initializer).
  const start = sigStart(decl);
  const first = node.parent!.namedChildren.find(c => c && c.type === 'variable_declarator');
  const headEnd = Math.min(first ? first.startIndex : node.startIndex, start + MAX_SIG_SLICE);
  const declEnd = node.endIndex - node.startIndex > 100 ? nameNode.endIndex : node.endIndex;
  const sig = ctx.src.slice(start, Math.max(start, headEnd)) + ctx.src.slice(node.startIndex, declEnd);

  ctx.def(node, {
    name: nameNode.text,
    kind: decl.type === 'field_declaration' && hasModifier(decl, 'const') ? 'constant' : 'field',
    range: decl,
    sig,
    doc: xmlDoc(decl),
    exported: memberExported(decl, ctx),
  });
  // The field symbol is not a container, so the hint lands on the enclosing type.
  if (decl.type === 'field_declaration') ctx.typeHint(nameNode.text, declaredType(field(declaration, 'type'), node));
};

/** Name and receiver of the callee expression of an invocation. */
function callee(fn: Node | null, ctx: Ctx, node: Node): void {
  for (let i = 0; fn && i < 4; i++) {
    switch (fn.type) {
      case 'identifier':
        ctx.call(fn.text, node);
        return;
      case 'generic_name':
        ctx.call(fn.namedChild(0)?.text, node);
        return;
      case 'member_access_expression': {
        const recv = field(fn, 'expression');
        // `x?.Foo.Bar()` may parse with a member_binding_expression receiver (`.Foo`).
        ctx.call(
          simpleName(field(fn, 'name')),
          node,
          recv && recv.type === 'member_binding_expression' ? COMPLEX_RECEIVER : receiverOf(recv)
        );
        return;
      }
      case 'member_binding_expression':
        // `x?.Foo()`: the receiver is the condition of the conditional access.
        ctx.call(simpleName(field(fn, 'name')), node, receiverOf(field(fn.parent, 'condition')));
        return;
      case 'conditional_access_expression':
        fn = fn.namedChild(fn.namedChildCount - 1);
        break;
      case 'parenthesized_expression':
        fn = fn.namedChild(0);
        break;
      default:
        return;
    }
  }
}

const invocation: Visitor = (node, ctx) => {
  callee(field(node, 'function'), ctx, node);
};

const objectCreation: Visitor = (node, ctx) => {
  ctx.call(simpleName(field(node, 'type')), node);
};

/** `: base(...)` / `: this(...)` after a constructor's parameter list. */
const constructorInitializer: Visitor = (node, ctx) => {
  let cls: Node | null = node.parent;
  for (let i = 0; cls && i < 4 && !TYPE_DECLS.includes(cls.type); i++) cls = cls.parent;
  if (!cls || !TYPE_DECLS.includes(cls.type)) return;
  let isThis = false;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'this') { isThis = true; break; }
    if (c.type === 'base' || c.type === 'argument_list') break;
  }
  if (isThis) {
    ctx.call(field(cls, 'name')?.text, node);
    return;
  }
  for (const c of cls.namedChildren) {
    if (!c || c.type !== 'base_list') continue;
    const name = simpleName(c.namedChild(0));
    if (name && !/^I[A-Z]/.test(name)) ctx.call(name, node);
    return;
  }
};

const usingDirective: Visitor = (node, ctx) => {
  const alias = field(node, 'name');
  let target: Node | null = null;
  let isStatic = false;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'static') isStatic = true;
    else if (c.isNamed && c !== alias && c.id !== alias?.id && c.type !== 'comment') target = c;
  }
  if (!target || target.endIndex - target.startIndex > 300) return;
  const source = target.text.replace(/\s+/g, '').replace(/^global::/, '');
  const names = alias ? [alias.text] : isStatic ? [lastSegment(source)] : [];
  ctx.imp(source, node, names);
};

export const csharp: LangSpec = {
  id: 'csharp',
  grammar: 'c_sharp',
  extensions: ['.cs'],
  identifiers: ['identifier'],
  visit: {
    class_declaration: typeDecl('class'),
    record_declaration: typeDecl('class'),
    struct_declaration: typeDecl('struct'),
    interface_declaration: typeDecl('interface'),
    enum_declaration: enumDecl,
    enum_member_declaration: enumMember,
    delegate_declaration: delegateDecl,
    method_declaration: callable(fieldName),
    constructor_declaration: callable(fieldName),
    destructor_declaration: callable(node => {
      const n = fieldName(node);
      return n ? '~' + n : null;
    }),
    operator_declaration: callable(operatorName),
    conversion_operator_declaration: callable(conversionOperatorName),
    local_function_statement: localFunction,
    property_declaration: propertyLike(fieldName, true),
    event_declaration: propertyLike(fieldName),
    indexer_declaration: propertyLike(() => 'this[]'),
    variable_declarator: variableDeclarator,
    parameter,
    foreach_statement: foreachStatement,
    catch_declaration: typedName,
    declaration_pattern: typedName, // `o is Foo f`, `case Foo f:`
    recursive_pattern: typedName, // `o is Foo { X: 1 } f`
    declaration_expression: typedName, // `TryGet(out Foo f)`
    attribute,
    invocation_expression: invocation,
    object_creation_expression: objectCreation,
    constructor_initializer: constructorInitializer,
    using_directive: usingDirective,
  },
};
