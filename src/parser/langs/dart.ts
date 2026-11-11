import type { Node } from 'web-tree-sitter';
import type { SymbolKind } from '../../types.js';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { childOfType, field, stripQuotes } from '../spec.js';

const MAX_SIG_SLICE = 400;
const MAX_TYPE_TEXT = 120;
const MAX_INLINE_VALUE = 80;
const MAX_RECEIVER = 48;

/** Bodies whose direct children are members of a type. */
const MEMBER_BODIES = new Set(['class_body', 'extension_body', 'enum_body']);

/** Tokens / nodes that make up the head of a top-level variable declaration (flat siblings in this grammar). */
const HEAD_PARTS = new Set([
  'type_identifier', 'type_arguments', 'nullable_type', '.', 'final_builtin', 'const_builtin', 'inferred_type',
  'late', 'external', 'static', 'covariant', 'function_type', 'void_type', 'record_type',
]);

/**
 * The grammar is flat: a method is a `method_signature` followed by a sibling
 * `function_body`, a call is an `identifier` followed by sibling `selector`s.
 * No single node covers such a construct, so line ranges and call extents
 * are passed to the framework as a span between two real nodes. The object
 * carries exactly the positional members the extractor reads from a node.
 */
function span(start: Node, end: Node, line: Node = start): Node {
  return {
    type: 'span',
    startIndex: start.startIndex,
    endIndex: end.endIndex,
    startPosition: line.startPosition,
    endPosition: line === start ? end.endPosition : line.startPosition,
    previousSibling: start.previousSibling,
    parent: line === start ? start.parent : null,
    childForFieldName: () => null,
  } as unknown as Node;
}

function sliceSig(ctx: Ctx, start: number, end: number): string {
  if (end - start > MAX_SIG_SLICE) end = start + MAX_SIG_SLICE;
  return ctx.src.slice(start, end).replace(/\s*(=>|[{;=])\s*$/, '');
}

function isPublic(name: string): boolean {
  return name.charCodeAt(0) !== 95; // '_'
}

function isUpper(name: string): boolean {
  const c = name.charCodeAt(0);
  return c >= 65 && c <= 90;
}

/** Text of a type that starts at `first`: `Foo`, `prefix.Foo`, `Future<Foo>` (flat siblings). */
function typeText(first: Node, ctx: Ctx): string {
  let end = first;
  let n = first.nextSibling;
  for (let i = 0; n && i < 6; i++, n = n.nextSibling) {
    if (n.type === '.' || n.type === 'type_identifier' || n.type === 'type_arguments') end = n;
    else break;
  }
  if (end === first || end.endIndex - first.startIndex > MAX_TYPE_TEXT) return first.text;
  return ctx.src.slice(first.startIndex, end.endIndex);
}

/** Declared type among the direct children of `node`, before its name. */
function declaredType(node: Node, ctx: Ctx): string | null {
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'type_identifier') return typeText(c, ctx);
    if (c.type === 'identifier') break;
  }
  return null;
}

/** Class of `new Foo()`, `const Foo()`, `new Foo.named()`, `new prefix.Foo()`. */
function newType(node: Node): string | null {
  let type: string | null = null;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'type_identifier') type = c.text;
    else if (c.type === 'identifier') {
      const name = c.text;
      if (isUpper(name)) type = name;
    } else if (c.type === 'arguments') break;
  }
  return type;
}

function hasArguments(selector: Node | null): boolean {
  return !!selector && selector.type === 'selector' && selector.firstChild?.type === 'argument_part';
}

/** Member name of a `.name` / `?.name` selector, or null. */
function memberOf(selector: Node | null): string | null {
  if (!selector || selector.type !== 'selector') return null;
  const inner = selector.firstChild;
  if (!inner || (inner.type !== 'unconditional_assignable_selector' && inner.type !== 'conditional_assignable_selector')) return null;
  const id = inner.lastChild;
  return id && id.type === 'identifier' ? id.text : null;
}

/**
 * Class constructed by an initialiser that starts at `value`: `Foo()`,
 * `Foo.named()`, `prefix.Foo()`, `new Foo()`, `const Foo()`.
 */
function constructedType(value: Node | null | undefined): string | null {
  if (!value) return null;
  if (value.type === 'new_expression' || value.type === 'const_object_expression') {
    return value.nextSibling?.type === 'selector' ? null : newType(value);
  }
  if (value.type !== 'identifier') return null;
  const s1 = value.nextSibling;
  if (hasArguments(s1)) {
    if (s1!.nextSibling?.type === 'selector') return null;
    const name = value.text;
    return isUpper(name) ? name : null;
  }
  const member = memberOf(s1);
  if (!member) return null;
  const s2 = s1!.nextSibling;
  if (!hasArguments(s2) || s2!.nextSibling?.type === 'selector') return null;
  const head = value.text;
  if (isUpper(head)) return head;
  return isUpper(member) ? member : null;
}

/** Names in a flat type list (`extends A`, `implements a.B<T>, C`), qualified names joined with '.'. */
function typeNames(list: Node | null | undefined, from = 0): string[] {
  const out: string[] = [];
  if (!list) return out;
  let dotted = false;
  const count = list.childCount;
  for (let i = from; i < count; i++) {
    const c = list.child(i);
    if (!c) continue;
    if (c.type === 'type_identifier') {
      if (dotted && out.length) out[out.length - 1] += '.' + c.text;
      else out.push(c.text);
      dotted = false;
    } else if (c.type === '.') dotted = true;
    else if (c.type === 'mixins' || c.type === 'interfaces' || c.type === 'class_body') break;
  }
  return out;
}

function inheritAll(sym: number, names: string[], kind: 'extends' | 'implements', ctx: Ctx): void {
  for (const n of names) ctx.inherit(sym, n, kind);
}

/** Start offset of a declaration: after leading annotations (children in this grammar for classes). */
function afterAnnotations(node: Node): number {
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'annotation' || c.type === 'comment' || c.type === 'documentation_comment') continue;
    return c.startIndex;
  }
  return node.startIndex;
}

const classDefinition: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const body = field(node, 'body');
  const start = afterAnnotations(node);
  const sym = ctx.def(node, {
    name,
    kind: 'class',
    sig: sliceSig(ctx, start, body ? body.startIndex : node.endIndex),
    exported: isPublic(name),
  });
  const superclass = field(node, 'superclass');
  if (superclass) {
    inheritAll(sym, typeNames(superclass), 'extends', ctx);
    inheritAll(sym, typeNames(childOfType(superclass, 'mixins')), 'implements', ctx);
  }
  inheritAll(sym, typeNames(field(node, 'interfaces')), 'implements', ctx);
};

/** `mixin Walker on Animal implements Legs { ... }` (no field names in the grammar). */
const mixinDeclaration: Visitor = (node, ctx) => {
  let nameNode: Node | null = null;
  let onAt = -1;
  let body: Node | null = null;
  let interfaces: Node | null = null;
  const count = node.childCount;
  for (let i = 0; i < count; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'identifier' && !nameNode) nameNode = c;
    else if (c.type === 'on') onAt = i + 1;
    else if (c.type === 'interfaces') interfaces = c;
    else if (c.type === 'class_body') body = c;
  }
  if (!nameNode) return;
  const name = nameNode.text;
  const sym = ctx.def(node, {
    name,
    kind: 'trait',
    sig: sliceSig(ctx, afterAnnotations(node), body ? body.startIndex : node.endIndex),
    exported: isPublic(name),
  });
  if (onAt > 0) inheritAll(sym, typeNames(node, onAt), 'extends', ctx);
  inheritAll(sym, typeNames(interfaces), 'implements', ctx);
};

/**
 * `extension StringX on String { ... }` is not a symbol: its members are
 * named after the extended type (`String.blank`), which is how call sites
 * see them (`s.blank`). Extensions on non-nominal types fall back to the
 * extension's own name.
 */
const extensionDeclaration: Visitor = (node, ctx) => {
  const on = field(node, 'class');
  if (on && on.type === 'type_identifier') {
    // `on prefix.Foo`: the last segment.
    let last = on;
    for (let n = on.nextSibling; n && (n.type === '.' || n.type === 'type_identifier'); n = n.nextSibling) {
      if (n.type === 'type_identifier') last = n;
    }
    ctx.scope(last.text);
    return;
  }
  const name = field(node, 'name');
  if (name) ctx.scope(name.text);
};

const extensionTypeDeclaration: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const body = field(node, 'body');
  const sym = ctx.def(node, {
    name,
    kind: 'class',
    sig: sliceSig(ctx, afterAnnotations(node), body ? body.startIndex : node.endIndex),
    exported: isPublic(name),
  });
  inheritAll(sym, typeNames(childOfType(node, 'interfaces')), 'implements', ctx);
  const rep = field(node, 'representation');
  const repName = field(rep, 'name');
  const repType = field(rep, 'type');
  if (repName && repType && repType.type === 'type_identifier') ctx.typeHint(repName.text, typeText(repType, ctx));
};

const enumDeclaration: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const body = field(node, 'body');
  const sym = ctx.def(node, {
    name,
    kind: 'enum',
    sig: sliceSig(ctx, afterAnnotations(node), body ? body.startIndex : node.endIndex),
    exported: isPublic(name),
  });
  inheritAll(sym, typeNames(childOfType(node, 'mixins')), 'implements', ctx);
  inheritAll(sym, typeNames(childOfType(node, 'interfaces')), 'implements', ctx);
};

const enumConstant: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  ctx.def(node, {
    name,
    kind: 'constant',
    sig: sliceSig(ctx, afterAnnotations(node), Math.min(node.endIndex, node.startIndex + 120)),
    exported: isPublic(name),
  });
};

/** `typedef Callback = void Function(int);` and the old `typedef int Compare(Object a, Object b);`. */
const typeAlias: Visitor = (node, ctx) => {
  let nameNode: Node | null = null;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'type_identifier') nameNode = c;
    else if (c.type === '=' || c.type === 'formal_parameter_list' || c.type === 'type_parameters') break;
  }
  if (!nameNode) return;
  const name = nameNode.text;
  ctx.def(node, { name, kind: 'type', sig: sliceSig(ctx, node.startIndex, node.endIndex), exported: isPublic(name) });
};

interface Callable {
  name: string;
  kind: SymbolKind;
  params: Node | null;
  /** Getter: its type is a field-like hint on the enclosing class. */
  getterType: string | null;
  hintParams: boolean;
}

/** Name and kind of a `*_signature` node; `member` says whether it sits in a class-like body. */
function describe(sig: Node, member: boolean, ctx: Ctx): Callable | null {
  switch (sig.type) {
    case 'function_signature': {
      const name = field(sig, 'name');
      if (!name) return null;
      return {
        name: name.text,
        kind: member ? 'method' : 'function',
        params: childOfType(sig, 'formal_parameter_list'),
        getterType: null,
        hintParams: true,
      };
    }
    case 'getter_signature': {
      const name = field(sig, 'name');
      if (!name) return null;
      return { name: name.text, kind: 'property', params: null, getterType: declaredType(sig, ctx), hintParams: false };
    }
    case 'setter_signature': {
      const name = field(sig, 'name');
      if (!name) return null;
      return { name: name.text, kind: 'property', params: null, getterType: null, hintParams: false };
    }
    case 'operator_signature': {
      let op: Node | null = null;
      for (const c of sig.children) {
        if (c && c.type === 'operator') { op = c.nextSibling; break; }
      }
      if (!op || op.endIndex - op.startIndex > 8) return null;
      return {
        name: op.text,
        kind: 'method',
        params: childOfType(sig, 'formal_parameter_list'),
        getterType: null,
        hintParams: true,
      };
    }
    case 'constructor_signature':
    case 'constant_constructor_signature':
    case 'factory_constructor_signature':
    case 'redirecting_factory_constructor_signature': {
      // `Foo(...)` -> Foo, `Foo.named(...)` -> named.
      let name: Node | null = null;
      let params: Node | null = null;
      for (const c of sig.children) {
        if (!c) continue;
        if (c.type === 'identifier') name = c;
        else if (c.type === 'formal_parameter_list') { params = c; break; }
      }
      if (!name) return null;
      return { name: name.text, kind: 'method', params, getterType: null, hintParams: true };
    }
    default:
      return null;
  }
}

function hintParameter(p: Node, ctx: Ctx): void {
  const name = field(p, 'name');
  if (!name) return;
  const type = declaredType(p, ctx);
  if (type) ctx.typeHint(name.text, type);
}

function hintParameters(list: Node | null, ctx: Ctx): void {
  if (!list) return;
  for (const c of list.namedChildren) {
    if (!c) continue;
    if (c.type === 'formal_parameter') hintParameter(c, ctx);
    else if (c.type === 'optional_formal_parameters') hintParameters(c, ctx);
  }
}

/** Inner `*_signature` of a `method_signature` / `declaration` (after `static`, `external`, ...). */
function innerSignature(node: Node): Node | null {
  for (const c of node.namedChildren) {
    if (c && c.type.endsWith('_signature')) return c;
  }
  return null;
}

/** First of the flat siblings that belong to a top-level declaration ending at `node` (`external`, `final`, type...). */
function headStart(node: Node): Node {
  let first = node;
  let prev = node.previousSibling;
  for (let i = 0; prev && i < 12 && HEAD_PARTS.has(prev.type); i++) {
    first = prev;
    prev = prev.previousSibling;
  }
  return first;
}

function defineCallable(node: Node, range: Node, info: Callable, sigEnd: number, ctx: Ctx): void {
  ctx.def(node, {
    name: info.name,
    kind: info.kind,
    range,
    sig: sliceSig(ctx, range.startIndex, sigEnd),
    exported: isPublic(info.name),
  });
  // Parameters precede the body in the tree; their hints belong to the symbol just opened.
  if (info.hintParams) hintParameters(info.params, ctx);
  if (info.getterType) ctx.typeHint(info.name, info.getterType);
}

/**
 * Functions, methods, getters, setters and constructors WITH a body. The
 * symbol is opened on the body node (the signature is its previous sibling)
 * so calls inside are attributed to it; the range spans signature + body.
 */
const functionBody: Visitor = (node, ctx) => {
  const outer = node.previousSibling;
  if (!outer) return;
  const sig = outer.type === 'method_signature' ? innerSignature(outer) : outer;
  if (!sig) return;
  const container = outer.parent;
  const info = describe(sig, !!container && MEMBER_BODIES.has(container.type), ctx);
  if (!info) return;
  const first = container && container.type === 'program' ? headStart(outer) : outer;
  // Constructor initialisers (`: super(x), a = b`) are not part of the signature.
  const init = outer.type === 'method_signature' ? childOfType(outer, 'initializers', 'redirection') : null;
  defineCallable(node, span(first, node), info, init ? init.startIndex : node.startIndex, ctx);
};

/** Class members without a body: abstract / external methods, getters, constructors with `;`. */
const declaration: Visitor = (node, ctx) => {
  const sig = innerSignature(node);
  if (!sig) return; // fields: see `declarator`
  const container = node.parent;
  const info = describe(sig, !!container && MEMBER_BODIES.has(container.type), ctx);
  if (!info) return;
  const init = childOfType(node, 'initializers', 'redirection');
  defineCallable(node, node, info, init ? init.startIndex : node.endIndex, ctx);
};

/** Top-level `external int f();` and other body-less top-level signatures. */
const bareSignature: Visitor = (node, ctx) => {
  const parent = node.parent;
  if (!parent || parent.type !== 'program') return;
  if (node.nextSibling?.type === 'function_body') return;
  const info = describe(node, false, ctx);
  if (!info) return;
  const first = headStart(node);
  defineCallable(node, first === node ? node : span(first, node), info, node.endIndex, ctx);
};

/**
 * Fields (`final Client _client;`, `static const int max = 10;`) and
 * top-level variables: one symbol per declarator.
 */
const declarator: Visitor = (node, ctx) => {
  const list = node.parent;
  if (!list || (list.type !== 'initialized_identifier_list' && list.type !== 'static_final_declaration_list')) return;
  const owner = list.parent;
  if (!owner) return;
  const nameNode = node.firstChild;
  if (!nameNode || nameNode.type !== 'identifier') return;

  let member: boolean;
  let first: Node;
  if (owner.type === 'declaration') {
    const body = owner.parent;
    if (!body || !MEMBER_BODIES.has(body.type)) return;
    member = true;
    first = owner.firstChild ?? list;
  } else if (owner.type === 'program') {
    member = false;
    first = headStart(list);
  } else {
    return;
  }

  // Modifiers and declared type: the siblings from `first` up to the list.
  let isConst = false;
  let isStatic = false;
  let type: string | null = null;
  let n: Node | null = first;
  for (let i = 0; n && n.startIndex < list.startIndex && i < 16; i++, n = n.nextSibling) {
    if (n.type === 'const_builtin') isConst = true;
    else if (n.type === 'static') isStatic = true;
    else if (n.type === 'type_identifier' && !type) type = typeText(n, ctx);
  }

  const name = nameNode.text;
  const eq = nameNode.nextSibling;
  const value = eq && eq.type === '=' ? eq.nextSibling : null;
  const long = !!value && (node.endIndex - value.startIndex > MAX_INLINE_VALUE || node.endPosition.row !== value.startPosition.row);
  const head = ctx.src.slice(first.startIndex, Math.min(list.startIndex, first.startIndex + MAX_SIG_SLICE));
  const sig = head + sliceSig(ctx, node.startIndex, long ? value!.startIndex : node.endIndex);

  const kind: SymbolKind = member ? (isStatic && isConst ? 'constant' : 'field') : isConst ? 'constant' : 'variable';
  ctx.def(node, {
    name,
    kind,
    range: member ? owner : span(first, list),
    sig,
    exported: isPublic(name),
  });
  // The symbol is not a container, so the hint lands on the enclosing class (or the file).
  const hint = type ?? constructedType(value);
  if (hint) ctx.typeHint(name, hint);
};

/** Typed locals: `final Foo x = ...`, `Foo x;`, `var x = Foo()`, `final x = Foo.named()`. */
const localVariable: Visitor = (node, ctx) => {
  if (!ctx.inCallable()) return;
  const name = field(node, 'name');
  if (!name) return;
  const type = declaredType(node, ctx) ?? constructedType(field(node, 'value'));
  if (type) ctx.typeHint(name.text, type);
};

/** `for (final Item it in items)`. */
const forLoopParts: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || !ctx.inCallable()) return;
  const type = declaredType(node, ctx);
  if (type) ctx.typeHint(name.text, type);
};

/** `on FooException catch (e)`. */
const catchClause: Visitor = (node, ctx) => {
  const type = node.previousSibling;
  if (!type || type.type !== 'type_identifier' || !ctx.inCallable()) return;
  const id = childOfType(node, 'catch_parameters')?.namedChild(0);
  if (id && id.type === 'identifier') ctx.typeHint(id.text, type.text);
};

/** Typed closure parameters: `(Foo f) { f.go(); }`. Parameters of declarations are hinted with their symbol. */
const formalParameter: Visitor = (node, ctx) => {
  let list = node.parent;
  if (list && list.type === 'optional_formal_parameters') list = list.parent;
  if (!list || list.parent?.type !== 'function_expression') return;
  if (ctx.inCallable()) hintParameter(node, ctx);
};

interface Pending {
  name: string;
  /** undefined: bare call; null: complex receiver. */
  recv: string | null | undefined;
  rtype: string | null;
  at: Node;
}

function emit(calls: Pending[], start: Node, ctx: Ctx): void {
  // Outermost first: the framework links a chained call to the call producing its receiver
  // when the inner call is recorded after the outer one.
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    const receiver = c.recv === undefined ? null : c.recv === null || c.recv.length > MAX_RECEIVER ? '?' : c.recv;
    ctx.call(c.name, span(start, c.at, c.at), receiver, receiver === '?' ? c.rtype : null);
  }
}

/** State of a walk along `a.b(c).d`: the pending member name and the receiver text before it. */
interface Chain {
  recv: string | null | undefined;
  name: string | null;
  rtype: string | null;
}

function stepMember(st: Chain, id: Node | null): void {
  if (!id || id.type !== 'identifier') {
    // Index access: whatever follows has a computed receiver.
    st.recv = null;
    st.name = null;
    st.rtype = null;
    return;
  }
  if (st.name === null) st.recv = null;
  else {
    st.recv = st.recv === undefined ? st.name : st.recv === null ? null : st.recv + '.' + st.name;
    st.rtype = null;
  }
  st.name = id.text;
}

function stepCall(st: Chain, at: Node, out: Pending[]): void {
  if (st.name !== null) out.push({ name: st.name, recv: st.recv, rtype: st.rtype, at });
  st.recv = null;
  st.name = null;
  st.rtype = null;
}

/**
 * A run of selectors after a primary expression: `x.a(1).b`, `Foo()`,
 * `this.repo.find()`, `super.m()`, `Foo.named()`. Handled once, from the
 * first selector of the run.
 */
const selector: Visitor = (node, ctx) => {
  const primary = node.previousSibling;
  if (!primary || primary.type === 'selector') return;
  const st: Chain = { recv: undefined, name: null, rtype: null };
  let start = primary;
  switch (primary.type) {
    case 'identifier':
    case 'this':
    case 'super':
      st.name = primary.text;
      break;
    case 'unconditional_assignable_selector': {
      // `super.m()`: the first member access is not wrapped in a selector.
      const sup = primary.previousSibling;
      const id = primary.lastChild;
      if (id && id.type === 'identifier') st.name = id.text;
      st.recv = sup && sup.type === 'super' ? 'super' : null;
      if (sup) start = sup;
      break;
    }
    case 'new_expression':
    case 'const_object_expression':
      st.recv = null;
      st.rtype = newType(primary);
      break;
    default:
      st.recv = null;
  }
  const out: Pending[] = [];
  for (let s: Node | null = node; s && s.type === 'selector'; s = s.nextSibling) {
    const inner = s.firstChild;
    if (!inner) continue;
    switch (inner.type) {
      case 'unconditional_assignable_selector':
      case 'conditional_assignable_selector':
        stepMember(st, inner.lastChild);
        break;
      case 'argument_part':
        stepCall(st, s, out);
        break;
      case '!':
        break;
      default:
        st.recv = null;
        st.name = null;
        st.rtype = null;
    }
  }
  if (out.length) emit(out, start, ctx);
};

/** `target..add(1)..child.remove(2)`: each section is a member access on the cascade target. */
const cascadeSection: Visitor = (node, ctx) => {
  let target = node.previousSibling;
  while (target && target.type === 'cascade_section') target = target.previousSibling;
  const st: Chain = { recv: null, name: null, rtype: null };
  if (target) {
    if (target.type === 'identifier' || target.type === 'this') {
      st.recv = target.text;
    } else if (hasArguments(target)) {
      // `Foo()..init()`: the target is a freshly constructed Foo.
      const callee = target.previousSibling;
      if (callee && callee.type === 'identifier' && callee.previousSibling?.type !== 'selector') {
        const name = callee.text;
        if (isUpper(name)) st.rtype = name;
      }
    } else if (target.type === 'new_expression' || target.type === 'const_object_expression') {
      st.rtype = newType(target);
    }
  }
  const out: Pending[] = [];
  let seen = false;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'cascade_selector') {
      const id = c.firstChild;
      if (!id || id.type !== 'identifier') return;
      st.name = id.text;
      seen = true;
    } else if (!seen) {
      continue;
    } else if (c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector') {
      stepMember(st, c.lastChild);
    } else if (c.type === 'argument_part') {
      stepCall(st, c, out);
    } else if (c.type !== '!') {
      break; // assignment: `..name = value`
    }
  }
  if (out.length) emit(out, node, ctx);
};

/** `new Foo()`, `const Foo()`, `new Foo.named()`, `new prefix.Foo()`. */
const newExpression: Visitor = (node, ctx) => {
  let type: Node | null = null;
  let named: Node | null = null;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'type_identifier') type = c;
    else if (c.type === 'identifier') named = c;
    else if (c.type === 'arguments') break;
  }
  if (!type) return;
  if (!named) ctx.call(type.text, node);
  else {
    const name = named.text;
    if (isUpper(name)) ctx.call(name, node);
    else ctx.call(name, node, type.text);
  }
};

function enclosingClass(node: Node): Node | null {
  let cur = node.parent;
  for (let i = 0; cur && i < 6; i++, cur = cur.parent) {
    if (cur.type === 'class_definition' || cur.type === 'enum_declaration' || cur.type === 'mixin_declaration') return cur;
  }
  return null;
}

/** `: super(x)`, `: super.named(x)` in a constructor's initialiser list, and `: this(x)` / `: this.named(x)`. */
const constructorCall: Visitor = (node, ctx) => {
  const head = node.firstChild?.type === ':' ? node.child(1) : node.firstChild;
  if (!head || (head.type !== 'super' && head.type !== 'this')) return;
  let named: Node | null = null;
  let hasArgs = false;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'identifier') named = c;
    else if (c.type === 'arguments') { hasArgs = true; break; }
  }
  if (!hasArgs) return;
  const cls = enclosingClass(node);
  if (!cls) return;
  let target: string | null;
  if (head.type === 'this') target = field(cls, 'name')?.text ?? null;
  else target = typeNames(field(cls, 'superclass'))[0] ?? null;
  if (!target) return;
  target = target.slice(target.lastIndexOf('.') + 1);
  if (named) ctx.call(named.text, node, target);
  else ctx.call(target, node);
};

/** `factory Foo.make() = Bar;` constructs a Bar. */
const redirectingFactory: Visitor = (node, ctx) => {
  let seenEq = false;
  let type: Node | null = null;
  let named: Node | null = null;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === '=') seenEq = true;
    else if (!seenEq) continue;
    else if (c.type === 'type_identifier') type = c;
    else if (c.type === 'identifier') named = c;
  }
  if (!type) return;
  if (named) ctx.call(named.text, node, type.text);
  else ctx.call(type.text, node);
};

function uriOf(node: Node): string | null {
  let uri = childOfType(node, 'uri');
  if (!uri) uri = childOfType(childOfType(node, 'configurable_uri'), 'uri');
  if (!uri || uri.endIndex - uri.startIndex > 300) return null;
  return stripQuotes(uri.text);
}

/**
 * `import 'x.dart' as p show A, B;` and `export 'x.dart' show A;`. Names
 * bound: the prefix (a namespace) and the shown names; an import without
 * either makes every public name of the library visible ('*').
 */
const importOrExport: Visitor = (node, ctx) => {
  const source = uriOf(node);
  if (!source) return;
  const names: string[] = [];
  let shown = false;
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'identifier') names.push(c.text);
    else if (c.type === 'combinator' && c.firstChild?.type === 'show') {
      shown = true;
      for (const id of c.namedChildren) {
        if (id && id.type === 'identifier') names.push(id.text);
      }
    }
  }
  if (!names.length && !shown) names.push('*');
  ctx.imp(source, node, names);
};

const partDirective: Visitor = (node, ctx) => {
  ctx.imp(uriOf(node), node);
};

export const dart: LangSpec = {
  id: 'dart',
  grammar: 'dart',
  extensions: ['.dart'],
  identifiers: ['identifier', 'type_identifier'],
  comments: ['comment', 'documentation_comment'],
  // Annotations are siblings of the member they annotate.
  docSkip: ['annotation'],
  visit: {
    class_definition: classDefinition,
    mixin_declaration: mixinDeclaration,
    extension_declaration: extensionDeclaration,
    extension_type_declaration: extensionTypeDeclaration,
    enum_declaration: enumDeclaration,
    enum_constant: enumConstant,
    type_alias: typeAlias,
    function_body: functionBody,
    declaration,
    function_signature: bareSignature,
    getter_signature: bareSignature,
    setter_signature: bareSignature,
    initialized_identifier: declarator,
    static_final_declaration: declarator,
    initialized_variable_definition: localVariable,
    for_loop_parts: forLoopParts,
    catch_clause: catchClause,
    formal_parameter: formalParameter,
    selector,
    cascade_section: cascadeSection,
    new_expression: newExpression,
    const_object_expression: newExpression,
    initializer_list_entry: constructorCall,
    redirection: constructorCall,
    redirecting_factory_constructor_signature: redirectingFactory,
    import_specification: importOrExport,
    library_export: importOrExport,
    part_directive: partDirective,
  },
};
