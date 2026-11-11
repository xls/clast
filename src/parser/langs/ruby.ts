import type { Node } from 'web-tree-sitter';
import type { Ctx, LangSpec, Visitor } from '../spec.js';
import { COMPLEX_RECEIVER, field } from '../spec.js';

// ---------------------------------------------------------------------------
// Per-file state. Visitors get no "leave" callback, so class/module visitors
// pre-scan the direct children of their body once and remember which methods
// sit in a `private`/`protected` section. Reset by the `program` visitor.
// ---------------------------------------------------------------------------

/** Ids of `method` nodes that follow a bare `private` / `protected`. */
const privateIds = new Set<number>();
/** `<body id>:<name>` for `private :foo, :bar` / `private_class_method :foo`. */
const privateNames = new Set<string>();
/** `<symbol>:<name>` of heritage entries already recorded (de-duplication). */
const heritageSeen = new Set<string>();

const MIXINS = new Set(['include', 'extend', 'prepend']);
const HIDERS = new Set(['private', 'protected', 'private_class_method']);

function inType(ctx: Ctx): boolean {
  const pk = ctx.parentKind();
  return pk === 'class' || pk === 'namespace';
}

/** `Foo` / `A::Foo` / `Foo[1]` / `Foo.new(...)` -> `Foo`. */
/**
 * Like constName(), but keeps one level of qualification (`ActiveSupport::Callbacks`)
 * so that same-named constants in different namespaces can be told apart.
 */
function qualifiedConstName(node: Node | null | undefined): string | null {
  if (node && node.type === 'scope_resolution') {
    const name = field(node, 'name');
    const scope = constName(field(node, 'scope'));
    if (name && scope) return scope + '::' + name.text;
  }
  return constName(node);
}

function constName(node: Node | null | undefined): string | null {
  for (let i = 0; node && i < 4; i++) {
    switch (node.type) {
      case 'constant': return node.text;
      case 'scope_resolution': node = field(node, 'name'); break;
      case 'element_reference': node = field(node, 'object'); break;
      case 'call': node = field(node, 'receiver'); break;
      default: return null;
    }
  }
  return null;
}

/** Literal value of `:sym`, `'str'` or `"str"` (no interpolation), else null. */
function literal(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'simple_symbol') return node.text.slice(1);
  if (node.type === 'string') {
    if (node.namedChildCount === 0) return null;
    if (node.namedChildCount !== 1) return null;
    const c = node.namedChildren[0];
    return c && c.type === 'string_content' ? c.text : null;
  }
  return null;
}

/**
 * The grammar attaches comments that precede the FIRST statement of a
 * class/module body to the class/module node itself (before `body`), so they
 * are not siblings of the definition and the generic doc lookup misses them.
 */
function firstChildDoc(range: Node): string | undefined {
  const parent = range.parent;
  if (!parent || parent.type !== 'body_statement' || parent.startIndex !== range.startIndex) return undefined;
  const parts: string[] = [];
  let nextRow = range.startPosition.row;
  let prev = parent.previousSibling;
  while (prev && prev.type === 'comment' && parts.length < 60) {
    if (prev.endPosition.row < nextRow - 1) break;
    nextRow = prev.startPosition.row;
    // A comment trailing the `class Foo` line documents nothing below it.
    const before = prev.previousSibling;
    if (before && before.endPosition.row === nextRow) break;
    parts.unshift(prev.text.replace(/^#+!? ?/, '').trimEnd());
    prev = prev.previousSibling;
  }
  while (parts.length && !parts[0]) parts.shift();
  while (parts.length && !parts[parts.length - 1]) parts.pop();
  return parts.length ? parts.join('\n') : undefined;
}

function args(call: Node): Node[] {
  const list = field(call, 'arguments');
  if (!list) return [];
  const out: Node[] = [];
  for (const c of list.namedChildren) if (c) out.push(c);
  return out;
}

function firstLine(ctx: Ctx, node: Node, end = node.endIndex): string {
  const nl = ctx.src.indexOf('\n', node.startIndex);
  return ctx.src.slice(node.startIndex, nl !== -1 && nl < end ? nl : end);
}

/**
 * Record a superclass / mixin once per (symbol, name). A symbol never
 * inherits from its own name (`extend self`-style self-extension,
 * `module ClassMethods; include Foo::ClassMethods`).
 */
function inherit(ctx: Ctx, sym: number, own: string, name: string | null, kind: 'extends' | 'implements'): void {
  // `module Callbacks; include ActiveSupport::Callbacks` is a real mixin: only the bare own name is skipped.
  if (!name || sym < 0 || name === own) return;
  const key = sym + ':' + name;
  if (heritageSeen.has(key)) return;
  heritageSeen.add(key);
  ctx.inherit(sym, name, kind);
}

/**
 * Scan the direct children of a class/module body: record mixins as heritage
 * of `sym` (when >= 0, `own` is its name) and remember which methods are private.
 */
function scanBody(body: Node | null, sym: number, own: string, ctx: Ctx): void {
  if (!body) return;
  let hidden = false;
  for (const c of body.namedChildren) {
    if (!c) continue;
    const t = c.type;
    if (t === 'method') {
      if (hidden) privateIds.add(c.id);
    } else if (t === 'identifier') {
      const w = c.text;
      if (w === 'private' || w === 'protected') hidden = true;
      else if (w === 'public') hidden = false;
    } else if (t === 'call') {
      if (field(c, 'receiver')) continue;
      const m = field(c, 'method');
      if (!m) continue;
      const name = m.text;
      if (MIXINS.has(name)) {
        if (sym < 0) continue;
        for (const a of args(c)) inherit(ctx, sym, own, qualifiedConstName(a), 'implements');
      } else if (HIDERS.has(name)) {
        for (const a of args(c)) {
          const lit = literal(a);
          if (lit) privateNames.add(body.id + ':' + lit);
        }
      }
    }
  }
}

/** Open naming scopes for the `A::B` part of `class A::B::C`. */
function openQualifier(nameNode: Node, ctx: Ctx): string {
  if (nameNode.type !== 'scope_resolution') return nameNode.text;
  const scope = field(nameNode, 'scope');
  if (scope) {
    for (const part of scope.text.split('::')) {
      const p = part.trim();
      if (p) ctx.scope(p);
    }
  }
  return field(nameNode, 'name')?.text ?? nameNode.text;
}

const program: Visitor = () => {
  privateIds.clear();
  privateNames.clear();
  heritageSeen.clear();
};

const classDef: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const superclass = field(node, 'superclass');
  const sig = ctx.src.slice(node.startIndex, (superclass ?? nameNode).endIndex);
  const name = openQualifier(nameNode, ctx);
  const sym = ctx.def(node, { name, kind: 'class', sig, doc: firstChildDoc(node), exported: !name.startsWith('_') });
  if (superclass) inherit(ctx, sym, name, qualifiedConstName(superclass.namedChildren[0]), 'extends');
  scanBody(field(node, 'body'), sym, name, ctx);
};

const moduleDef: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const sig = ctx.src.slice(node.startIndex, nameNode.endIndex);
  const name = openQualifier(nameNode, ctx);
  const sym = ctx.def(node, { name, kind: 'namespace', sig, doc: firstChildDoc(node), exported: !name.startsWith('_') });
  scanBody(field(node, 'body'), sym, name, ctx);
};

/** `class << self`: no symbol and no scope, methods belong to the enclosing class. */
const singletonClass: Visitor = (node, ctx) => {
  scanBody(field(node, 'body'), -1, '', ctx);
};

/** `def foo`, `def self.foo`, `private def foo`. */
const methodDef: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const parent = node.parent;
  let range: Node = node;
  let hidden = privateIds.has(node.id);
  if (parent) {
    if (parent.type === 'argument_list') {
      // `private def foo`, `memoize def foo`, `private_class_method def self.foo`
      const wrapper = parent.parent;
      if (wrapper && wrapper.type === 'call' && !field(wrapper, 'receiver')) {
        range = wrapper;
        const w = field(wrapper, 'method')?.text;
        if (w && HIDERS.has(w)) hidden = true;
      }
    } else if (!hidden && privateNames.size > 0 && privateNames.has(parent.id + ':' + name)) {
      hidden = true;
    }
  }
  const end = field(node, 'parameters') ?? nameNode;
  let sig = ctx.src.slice(range.startIndex, end.endIndex);
  if (node.type === 'method') {
    // Inside `class << self` show the receiver, like `def self.foo`.
    const holder = range.parent?.parent;
    if (holder && holder.type === 'singleton_class' && field(holder, 'value')?.type === 'self') {
      sig = ctx.src.slice(range.startIndex, nameNode.startIndex) + 'self.' + ctx.src.slice(nameNode.startIndex, end.endIndex);
    }
  }
  ctx.def(node, {
    name,
    kind: inType(ctx) ? 'method' : 'function',
    range,
    sig,
    doc: firstChildDoc(range),
    exported: !hidden && !name.startsWith('_'),
  });
};

/** `alias new_name old_name` */
const aliasDef: Visitor = (node, ctx) => {
  const nameNode = field(node, 'name');
  if (!nameNode) return;
  ctx.def(node, {
    name: nameNode.text.replace(/^:/, ''),
    kind: inType(ctx) ? 'method' : 'function',
    body: null,
    doc: firstChildDoc(node),
    exported: true,
  });
};

const CLASS_FACTORIES = new Set(['Struct', 'Class', 'Data', 'Module']);

/** `FOO = 1`, `Point = Struct.new(:x, :y) do ... end` */
const assignment: Visitor = (node, ctx) => {
  const left = field(node, 'left');
  if (!left) return;
  const lt = left.type;
  if (lt === 'identifier' || lt === 'instance_variable') {
    // `x = Foo.new(...)`, `@x ||= Foo::Bar.new`: the only cheaply inferable types.
    const right = field(node, 'right');
    if (!right || right.type !== 'call') return;
    const recv = field(right, 'receiver');
    if (!recv || (recv.type !== 'constant' && recv.type !== 'scope_resolution')) return;
    if (field(right, 'method')?.text !== 'new') return;
    if (lt === 'identifier') ctx.typeHint(left.text, recv.text);
    else ctx.typeHint(left.text.slice(1), recv.text, true);
    return;
  }
  if (lt !== 'constant') return;
  if (ctx.inCallable()) return;
  const name = left.text;
  const right = field(node, 'right');
  if (right && right.type === 'call') {
    const recv = field(right, 'receiver');
    const m = field(right, 'method')?.text;
    if (recv && recv.type === 'constant' && (m === 'new' || m === 'define') && CLASS_FACTORIES.has(recv.text)) {
      const factory = recv.text;
      const block = field(right, 'block');
      const sym = ctx.def(node, {
        name,
        kind: factory === 'Module' ? 'namespace' : 'class',
        sig: firstLine(ctx, node, block ? block.startIndex : node.endIndex),
        doc: firstChildDoc(node),
        exported: true,
      });
      if (factory === 'Class') inherit(ctx, sym, name, constName(args(right)[0]), 'extends');
      else if (factory !== 'Module') inherit(ctx, sym, name, factory, 'extends');
      scanBody(field(block, 'body'), sym, name, ctx);
      return;
    }
  }
  ctx.def(node, {
    name,
    kind: 'constant',
    sig: firstLine(ctx, node),
    doc: firstChildDoc(node),
    exported: !name.startsWith('_'),
  });
};

// ---------------------------------------------------------------------------
// Receiver-less "keyword-like" calls. A handler returns true when the call was
// fully consumed and must not be recorded as a call.
// ---------------------------------------------------------------------------

type Dsl = (node: Node, ctx: Ctx, name: string) => boolean;

const consumed: Dsl = () => true;

const requireCall: Dsl = (node, ctx, name) => {
  const src = literal(args(node)[0]);
  if (src) ctx.imp(name === 'require_relative' && !/^\.\.?\//.test(src) ? './' + src : src, node);
  return true;
};

const autoloadCall: Dsl = (node, ctx) => {
  const a = args(node);
  const path = a[1] && a[1].type === 'string' ? literal(a[1]) : null;
  if (path) {
    const name = literal(a[0]);
    ctx.imp(path, node, name ? [name] : []);
  }
  return true;
};

/** Define one leaf symbol per literal symbol/string argument. */
function defEach(node: Node, ctx: Ctx, kind: 'property' | 'method', all: boolean): boolean {
  if (!inType(ctx) || ctx.inCallable()) return false;
  const list = args(node);
  const names: string[] = [];
  for (const a of list) {
    if (a.type === 'pair') {
      // `delegate :x, to: :y, prefix: true` generates differently named methods.
      if (field(a, 'key')?.text === 'prefix') return false;
      continue;
    }
    const lit = literal(a);
    if (lit) names.push(lit);
    if (!all) break;
  }
  if (names.length === 0) return false;
  const sig = firstLine(ctx, node);
  const doc = firstChildDoc(node);
  for (const name of names) {
    ctx.def(node, { name, kind, sig, doc, exported: !name.startsWith('_'), scope: false });
  }
  return true;
}

const attrCall: Dsl = (node, ctx) => defEach(node, ctx, 'property', true);
/** `has_many :comments, dependent: :destroy`: one association named by the first argument. */
const associationCall: Dsl = (node, ctx) => defEach(node, ctx, 'property', false);
const delegateCall: Dsl = (node, ctx) => defEach(node, ctx, 'method', true);
const aliasMethodCall: Dsl = (node, ctx) => defEach(node, ctx, 'method', false);

/** `define_method(:name) { ... }`, `scope :name, -> { ... }`: the block is the method body. */
const blockMethod: Dsl = (node, ctx, dsl) => {
  if (!inType(ctx) || ctx.inCallable()) return false;
  const list = args(node);
  const first = list[0];
  if (!first) return false;
  if (dsl === 'scope' && (first.type !== 'simple_symbol' || list.length < 2)) return false;
  const name = literal(first);
  if (!name) return false;
  ctx.def(node, {
    name,
    kind: 'method',
    sig: ctx.src.slice(node.startIndex, first.endIndex) + (dsl === 'scope' ? '' : ')'),
    doc: firstChildDoc(node),
    exported: !name.startsWith('_'),
  });
  return true;
};

const DSL = new Map<string, Dsl>([
  ['require', requireCall],
  ['require_relative', requireCall],
  ['load', requireCall],
  ['autoload', autoloadCall],
  ['attr_accessor', attrCall],
  ['attr_reader', attrCall],
  ['attr_writer', attrCall],
  ['attr', attrCall],
  ['attr_internal', attrCall],
  ['mattr_accessor', attrCall],
  ['mattr_reader', attrCall],
  ['mattr_writer', attrCall],
  ['cattr_accessor', attrCall],
  ['cattr_reader', attrCall],
  ['cattr_writer', attrCall],
  ['class_attribute', attrCall],
  ['thread_mattr_accessor', attrCall],
  ['has_many', associationCall],
  ['has_one', associationCall],
  ['belongs_to', associationCall],
  ['has_and_belongs_to_many', associationCall],
  ['has_one_attached', associationCall],
  ['has_many_attached', associationCall],
  ['delegate', delegateCall],
  ['alias_method', aliasMethodCall],
  ['define_method', blockMethod],
  ['scope', blockMethod],
  ['include', consumed],
  ['extend', consumed],
  ['prepend', consumed],
  ['private', consumed],
  ['protected', consumed],
  ['public', consumed],
  ['module_function', consumed],
  ['private_class_method', consumed],
  ['public_class_method', consumed],
  ['private_constant', consumed],
]);

/** Receiver node types whose text is a useful, cheap hint. */
const SIMPLE_RECEIVERS = new Set([
  'identifier', 'self', 'instance_variable', 'class_variable', 'global_variable',
]);

const call: Visitor = (node, ctx) => {
  const m = node.childForFieldName('method');
  if (!m) return;
  const name = m.text;
  const recv = node.childForFieldName('receiver');
  if (!recv) {
    const dsl = DSL.get(name);
    if (dsl && dsl(node, ctx, name)) return;
    ctx.call(name, node);
    return;
  }
  // An explicit receiver is always passed on (COMPLEX_RECEIVER for chains,
  // literals, ...) so the call is never mistaken for an implicit-self call.
  const rt = recv.type;
  let receiver: string = COMPLEX_RECEIVER;
  if (rt === 'constant') {
    receiver = recv.text;
    // Instantiation is how classes get used: `Foo.new` is also a call to `Foo`.
    if (name === 'new') ctx.call(receiver, node);
  } else if (rt === 'scope_resolution') {
    if (recv.endIndex - recv.startIndex <= 40) receiver = recv.text.replace(/\s+/g, '');
    if (name === 'new') ctx.call(field(recv, 'name')?.text, node);
  } else if (SIMPLE_RECEIVERS.has(rt)) {
    if (recv.endIndex - recv.startIndex <= 40) receiver = recv.text;
  }
  ctx.call(name, node, receiver);
};

export const ruby: LangSpec = {
  id: 'ruby',
  grammar: 'ruby',
  extensions: ['.rb', '.rake', '.gemspec'],
  identifiers: ['identifier', 'constant'],
  comments: ['comment'],
  visit: {
    program,
    class: classDef,
    module: moduleDef,
    singleton_class: singletonClass,
    method: methodDef,
    singleton_method: methodDef,
    alias: aliasDef,
    assignment,
    operator_assignment: assignment,
    call,
  },
};
