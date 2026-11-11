import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { field, lastSegment } from '../spec.js';
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

function shortReceiver(node: Node | null): string | null {
  if (!node || node.endIndex - node.startIndex > 40) return null;
  const t = node.text;
  return /[\s(]/.test(t) ? null : t;
}

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

const propertyLike = (nameOf: (node: Node) => string | undefined): Visitor => (node, ctx) => {
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
};

/** Fields and field-like events: one symbol per declarator. Locals are ignored. */
const variableDeclarator: Visitor = (node, ctx) => {
  const decl = node.parent?.parent;
  if (!decl || (decl.type !== 'field_declaration' && decl.type !== 'event_field_declaration')) return;
  const nameNode = field(node, 'name') ?? node.namedChild(0);
  if (!nameNode || nameNode.type !== 'identifier') return;

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
        // `x?.Foo.Bar()` parses with a member_binding_expression receiver.
        ctx.call(simpleName(field(fn, 'name')), node, recv && recv.type !== 'member_binding_expression' ? shortReceiver(recv) : null);
        return;
      }
      case 'member_binding_expression':
        ctx.call(simpleName(field(fn, 'name')), node, shortReceiver(field(fn.parent, 'condition')));
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
    property_declaration: propertyLike(fieldName),
    event_declaration: propertyLike(fieldName),
    indexer_declaration: propertyLike(() => 'this[]'),
    variable_declarator: variableDeclarator,
    invocation_expression: invocation,
    object_creation_expression: objectCreation,
    constructor_initializer: constructorInitializer,
    using_directive: usingDirective,
  },
};
