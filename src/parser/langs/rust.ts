import type { Node } from 'web-tree-sitter';
import { cleanComment } from '../extractor.js';
import type { Ctx, DefOpts, LangSpec, Visitor } from '../spec.js';
import { field, simpleReceiver } from '../spec.js';

const MAX_SIG_SLICE = 600;
const MAX_DOC = 600;
const MAX_DOC_LINES = 40;
const MAX_TYPE_TEXT = 80;

/** Prelude enum constructors: never user symbols, extremely frequent. */
const NOISE_CALLS = new Set(['Some', 'Ok', 'Err']);

/** Smart pointers / cells: `Arc::new(Foo::new())` is used like a `Foo`. */
const VALUE_WRAPPERS = new Set(['Arc', 'Rc', 'Box', 'Mutex', 'RwLock', 'RefCell', 'Cell', 'Pin']);

/** An item found in macro arguments, applied when the walker reaches its body token tree. */
interface Pending {
  /** Symbol to open on the body tree ... */
  def?: DefOpts;
  /** ... or a naming-only scope (`impl` blocks). */
  scope?: string;
  /** Trait implemented by the `impl` block. */
  trait?: string | null;
  /** Functions directly inside are methods (trait / impl body). */
  member?: boolean;
  /** Register the symbol as a type for `impl Trait for Type` heritage. */
  isType?: boolean;
  /** `macro_rules!` definition: its body is a template that defines nothing. */
  macroDef?: boolean;
  /** Declared types of parameters / fields: [name, type text]. */
  hints?: Array<[string, string]>;
}

/**
 * Per-file state. A fresh `Ctx` is created for every extraction, so keying on
 * it gives file-local state without touching the framework.
 */
interface FileState {
  /** Type name -> symbol index, for `impl Trait for Type` heritage. */
  types: Map<string, number>;
  /** End offset of the attribute being walked (token trees inside are not code). */
  attrEnd: number;
  /** End offset of the `macro_rules!` definition being walked (templates define nothing). */
  macroDefEnd: number;
  /** Keyed by the start offset of the body token tree. */
  pending: Map<number, Pending>;
  /** Type of the `impl` block being walked (what `Self` means) and its end offset. */
  implName: string | null;
  implEnd: number;
}
const states = new WeakMap<Ctx, FileState>();
function state(ctx: Ctx): FileState {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { types: new Map(), attrEnd: -1, macroDefEnd: -1, pending: new Map(), implName: null, implEnd: -1 }));
  return s;
}

function isComment(node: Node): boolean {
  return node.type === 'line_comment' || node.type === 'block_comment';
}

function isPub(node: Node): boolean {
  return node.firstChild?.type === 'visibility_modifier';
}

function joinDoc(parts: Node[]): string | undefined {
  if (parts.length === 0) return undefined;
  // Long docs: the beginning is the summary, keep that.
  const doc = parts.slice(0, MAX_DOC_LINES).map(c => cleanComment(c.text)).join('\n').trim();
  return doc.length > MAX_DOC ? doc.slice(0, MAX_DOC - 3) + '...' : doc;
}

/**
 * Doc comment of an item. The framework only looks at comment siblings
 * directly in front of the item, so attributes between doc and item
 * (`/// doc` + `#[derive(..)]` + item) hide it, and for long `///` blocks
 * (one node per line) it keeps the end instead of the beginning. Returns
 * undefined when there is no comment.
 */
function leadDoc(node: Node): string | undefined {
  let prev = node.previousSibling;
  if (!prev || (prev.type !== 'attribute_item' && !isComment(prev))) return undefined;
  const parts: Node[] = [];
  let nextRow = node.startPosition.row;
  for (let i = 0; prev && i < 400; i++) {
    if (prev.type === 'attribute_item') {
      nextRow = prev.startPosition.row;
    } else if (isComment(prev)) {
      // Line doc comments include their newline: they end at column 0 of the next row.
      const end = prev.endPosition;
      if ((end.column === 0 ? end.row - 1 : end.row) < nextRow - 1) break;
      const before = prev.previousSibling;
      if (before && !isComment(before) && before.endPosition.row === prev.startPosition.row) break;
      parts.unshift(prev);
      nextRow = prev.startPosition.row;
    } else {
      break;
    }
    prev = prev.previousSibling;
  }
  return joinDoc(parts);
}

/** True if the item is preceded by an attribute whose name is `name` (e.g. `macro_export`). */
function hasAttr(node: Node, name: string): boolean {
  let prev = node.previousSibling;
  for (let i = 0; prev && i < 20; i++) {
    if (prev.type === 'attribute_item') {
      if (prev.namedChildren[0]?.namedChildren[0]?.text === name) return true;
    } else if (!isComment(prev)) {
      return false;
    }
    prev = prev.previousSibling;
  }
  return false;
}

/** Source text of an item up to `end`, without trailing `;` / `,` / whitespace. */
function itemText(node: Node, ctx: Ctx, end = node.endIndex): string {
  const start = node.startIndex;
  return ctx.src.slice(start, Math.min(end, start + MAX_SIG_SLICE)).replace(/[;,\s]+$/, '');
}

/** Bare name of a type / path node: `S<T>` -> S, `a::b::C` -> C, `&'a mut Foo` -> Foo. */
function typeName(node: Node | null | undefined): string | null {
  for (let i = 0; node && i < 6; i++) {
    switch (node.type) {
      case 'type_identifier':
      case 'identifier':
      case 'primitive_type':
        return node.text;
      case 'scoped_type_identifier':
      case 'scoped_identifier':
        node = field(node, 'name');
        break;
      case 'generic_type':
      case 'generic_type_with_turbofish':
      case 'reference_type':
      case 'pointer_type':
        node = field(node, 'type');
        break;
      case 'array_type':
        node = field(node, 'element');
        break;
      case 'dynamic_type':
      case 'abstract_type':
        node = field(node, 'trait');
        break;
      default:
        return null;
    }
  }
  return null;
}

/**
 * Raw type text prepared for ctx.typeHint: references, raw pointers and
 * `mut` / `dyn` / `impl` are dropped (`&'a mut Foo` -> Foo); `Self` becomes
 * the type of the enclosing `impl` block.
 */
function cleanType(raw: string, at: number, st: FileState): string | null {
  const t = raw.replace(/[&*]\s*(?:'\w+\s*)?/g, '').replace(/\b(?:mut|dyn|impl|const)\s+/g, '').trim();
  if (t === 'Self') return at < st.implEnd ? st.implName : null;
  return t || null;
}

function typeText(node: Node | null | undefined, st: FileState): string | null {
  if (!node || node.endIndex - node.startIndex > MAX_TYPE_TEXT) return null;
  return cleanType(node.text, node.startIndex, st);
}

function isTypeName(name: string | null): name is string {
  return !!name && name.length > 1 && name[0]! >= 'A' && name[0]! <= 'Z';
}

/**
 * Type of the value an expression obviously constructs: `Foo { .. }`,
 * `Foo::new(..)` / `Foo::default()` / `m::Foo::with_capacity(..)` (a path
 * whose type segment is capitalised; enum variants `E::V(..)` yield the enum),
 * tuple structs `Foo(..)`, also behind `?`, `.await`, `&` and smart pointer
 * constructors (`Arc::new(Foo::new())`). Other calls are not guessed.
 */
function valueType(v: Node | null | undefined, st: FileState): string | null {
  for (let i = 0; v && i < 6; i++) {
    switch (v.type) {
      case 'try_expression':
      case 'await_expression':
      case 'parenthesized_expression':
        v = v.namedChildren[0];
        break;
      case 'reference_expression':
        v = field(v, 'value');
        break;
      case 'struct_expression': {
        const name = typeName(field(v, 'name'));
        if (name === 'Self') return v.startIndex < st.implEnd ? st.implName : null;
        return isTypeName(name) ? name : null;
      }
      case 'call_expression': {
        let fn = field(v, 'function');
        if (fn && fn.type === 'generic_function') fn = field(fn, 'function');
        if (!fn) return null;
        if (fn.type === 'identifier') {
          const name = fn.text;
          return isTypeName(name) && !NOISE_CALLS.has(name) ? name : null;
        }
        if (fn.type !== 'scoped_identifier') return null;
        const type = typeName(field(fn, 'path'));
        if (type === 'Self') return v.startIndex < st.implEnd ? st.implName : null;
        if (!isTypeName(type)) {
          // `module::Foo(..)`: tuple struct behind a module path.
          const name = field(fn, 'name')?.text ?? null;
          return type && isTypeName(name) && !NOISE_CALLS.has(name) ? name : null;
        }
        if (!VALUE_WRAPPERS.has(type)) return type;
        const ctor = field(fn, 'name')?.text;
        if (ctor !== 'new' && ctor !== 'pin') return null;
        v = field(v, 'arguments')?.namedChildren[0];
        break;
      }
      default:
        return null;
    }
  }
  return null;
}

/** `impl_item` / `trait_item` that directly contains the member, if any. */
function container(node: Node): Node | null {
  const list = node.parent;
  if (!list || list.type !== 'declaration_list') return null;
  const owner = list.parent;
  return owner && (owner.type === 'impl_item' || owner.type === 'trait_item') ? owner : null;
}

/** Visibility of a member: own `pub`, or the visibility of the trait that declares it. */
function memberExported(node: Node, owner: Node | null): boolean {
  if (isPub(node)) return true;
  return !!owner && owner.type === 'trait_item' && isPub(owner);
}

function define(node: Node, ctx: Ctx, opts: DefOpts): number {
  const doc = leadDoc(node);
  if (doc !== undefined) opts.doc = doc;
  return ctx.def(node, opts);
}

const functionItem: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const owner = container(node);
  // Without a body (trait methods, extern functions) the signature is the whole item.
  define(node, ctx, {
    name: name.text,
    kind: owner ? 'method' : 'function',
    sig: itemText(node, ctx, field(node, 'body')?.startIndex),
    exported: memberExported(node, owner),
  });
};

function fields(list: Node | null, ctx: Ctx): void {
  if (!list || list.type !== 'field_declaration_list') return;
  for (const f of list.namedChildren) {
    if (!f || f.type !== 'field_declaration') continue;
    const name = field(f, 'name');
    if (!name) continue;
    define(f, ctx, { name: name.text, kind: 'field', body: null, scope: false, exported: isPub(f) });
    ctx.typeHint(name.text, typeText(field(f, 'type'), state(ctx)));
  }
}

const structItem: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const body = field(node, 'body');
  const opts: DefOpts = { name: name.text, kind: 'struct', exported: isPub(node) };
  // Unit and tuple structs: keep the whole declaration (`pub struct Id(pub u32)`).
  if (!body || body.type !== 'field_declaration_list') opts.sig = itemText(node, ctx);
  const sym = define(node, ctx, opts);
  state(ctx).types.set(name.text, sym);
  fields(body, ctx);
};

const enumItem: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const exported = isPub(node);
  const sym = define(node, ctx, { name: name.text, kind: 'enum', exported });
  state(ctx).types.set(name.text, sym);
  for (const v of field(node, 'body')?.namedChildren ?? []) {
    if (!v || v.type !== 'enum_variant') continue;
    const vName = field(v, 'name');
    if (!vName) continue;
    // Struct-like variants: cut at the field list (it may contain doc comments).
    const vBody = field(v, 'body');
    const end = vBody && vBody.type === 'field_declaration_list' ? vBody.startIndex : v.endIndex;
    define(v, ctx, { name: vName.text, kind: 'constant', sig: itemText(v, ctx, end), scope: false, exported });
  }
};

const traitItem: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const sym = define(node, ctx, { name: name.text, kind: 'trait', exported: isPub(node) });
  for (const b of field(node, 'bounds')?.namedChildren ?? []) {
    if (!b || b.type === 'lifetime') continue;
    ctx.inherit(sym, heritageName(b), 'extends');
  }
};

const SMART_POINTERS = new Set(['Arc', 'Rc', 'Box', 'Pin']);

/** Supertype name with its module path (`futures_io::AsyncRead`), so that it is not taken for a local trait. */
function heritageName(node: Node | null | undefined): string | null {
  for (let i = 0; node && i < 3 && (node.type === 'generic_type' || node.type === 'higher_ranked_trait_bound'); i++) {
    node = field(node, 'type');
  }
  if (node && node.type === 'scoped_type_identifier') return node.text.replace(/\s+/g, '');
  return typeName(node);
}

/**
 * The type an impl block is for. `impl Schedule for Arc<Handle>` adds methods
 * that are called on handles, so the wrapper is looked through; a blanket
 * `impl<T: Read> Read for Box<T>` stays with the wrapper.
 */
function implTarget(node: Node): string | null {
  let type = field(node, 'type');
  const params = new Set<string>();
  for (const p of field(node, 'type_parameters')?.namedChildren ?? []) {
    const n = p ? (field(p, 'name') ?? (p.type === 'type_identifier' ? p : p.namedChildren[0])) : null;
    if (n) params.add(n.text);
  }
  for (let i = 0; type && i < 4; i++) {
    if (type.type === 'reference_type') {
      type = field(type, 'type');
      continue;
    }
    if (type.type !== 'generic_type') break;
    const base = typeName(field(type, 'type'));
    if (!base || !SMART_POINTERS.has(base)) break;
    const inner = field(type, 'type_arguments')?.namedChildren.find(c => c && c.type !== 'lifetime') ?? null;
    const innerName = typeName(inner);
    if (!inner || !innerName || params.has(innerName) || innerName === 'Self') break;
    type = inner;
  }
  return typeName(type);
}

/** `impl Type` / `impl Trait for Type`: naming scope only, never a symbol. */
const implItem: Visitor = (node, ctx) => {
  const name = implTarget(node);
  if (!name) return;
  ctx.scope(name);
  const st = state(ctx);
  st.implName = name;
  st.implEnd = node.endIndex;
  const trait = field(node, 'trait');
  if (!trait) return;
  // Heritage needs the symbol of the implementing type: only known when the
  // type is defined earlier in the same file.
  const sym = st.types.get(name);
  if (sym !== undefined) ctx.inherit(sym, heritageName(trait), 'implements');
};

const modItem: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  if (!field(node, 'body')) {
    // `mod foo;` pulls in foo.rs / foo/mod.rs
    ctx.imp('self::' + name.text, node, [name.text]);
    return;
  }
  define(node, ctx, { name: name.text, kind: 'namespace', exported: isPub(node) });
};

/** `const` / `static`: module level and associated constants, not locals. */
const constItem: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name || ctx.inCallable()) return;
  const value = field(node, 'value');
  // Keep short values in the signature, cut long initialisers.
  const long = value && (value.endIndex - value.startIndex > 80 || value.startPosition.row !== value.endPosition.row);
  define(node, ctx, {
    name: name.text,
    kind: 'constant',
    sig: itemText(node, ctx, long ? value.startIndex : node.endIndex).replace(/\s*=$/, ''),
    scope: false,
    exported: memberExported(node, container(node)),
  });
};

const typeItem: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  const owner = container(node);
  const sym = define(node, ctx, {
    name: name.text,
    kind: 'type',
    sig: itemText(node, ctx),
    scope: false,
    exported: memberExported(node, owner),
  });
  if (!owner) state(ctx).types.set(name.text, sym);
};

const macroDefinition: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (!name) return;
  state(ctx).macroDefEnd = node.endIndex;
  define(node, ctx, {
    name: name.text,
    kind: 'macro',
    sig: 'macro_rules! ' + name.text,
    exported: hasAttr(node, 'macro_export'),
  });
};

function recordCall(fn: Node | null, node: Node, ctx: Ctx): void {
  for (let i = 0; fn && i < 3; i++) {
    switch (fn.type) {
      case 'identifier': {
        const name = fn.text;
        if (!NOISE_CALLS.has(name)) ctx.call(name, node);
        return;
      }
      case 'scoped_identifier': {
        const path = field(fn, 'path');
        // `Vec::<u8>::new` -> receiver `Vec`
        const recv = path && (path.type === 'generic_type' || path.type === 'bracketed_type')
          ? typeName(path)
          : simpleReceiver(path);
        ctx.call(field(fn, 'name')?.text, node, recv ?? '?');
        return;
      }
      case 'field_expression':
        // Always a receiver ('?' for method chains): a method call is never a bare call.
        ctx.call(field(fn, 'field')?.text, node, simpleReceiver(field(fn, 'value')) ?? '?');
        return;
      case 'generic_function': // `foo::<T>()`, `x.collect::<Vec<_>>()`
        fn = field(fn, 'function');
        break;
      default:
        return;
    }
  }
}

const callExpression: Visitor = (node, ctx) => {
  recordCall(field(node, 'function'), node, ctx);
};

const macroInvocation: Visitor = (node, ctx) => {
  const m = field(node, 'macro');
  if (!m) return;
  if (m.type === 'identifier') ctx.call(m.text, node);
  else if (m.type === 'scoped_identifier') ctx.call(field(m, 'name')?.text, node, simpleReceiver(field(m, 'path')) ?? '?');
};

/** `x: &Foo`, `mut x: Foo` in function and closure parameter lists. */
const parameter: Visitor = (node, ctx) => {
  const list = node.parent;
  if (!list) return;
  if (list.type !== 'closure_parameters') {
    const owner = list.parent?.type;
    if (owner !== 'function_item' && owner !== 'function_signature_item') return;
  }
  const pat = field(node, 'pattern');
  if (!pat || pat.type !== 'identifier') return;
  const type = typeText(field(node, 'type'), state(ctx));
  if (type) ctx.typeHint(pat.text, type);
};

/** `let x: Foo = ..`, `let x = Foo::new(..)`, `let x = Foo { .. }` */
const letDeclaration: Visitor = (node, ctx) => {
  const pat = field(node, 'pattern');
  if (!pat || pat.type !== 'identifier') return;
  const st = state(ctx);
  const declared = field(node, 'type');
  const type = declared ? typeText(declared, st) : valueType(field(node, 'value'), st);
  if (type) ctx.typeHint(pat.text, type);
};

/** `Foo { a, b }` uses the type. */
const structExpression: Visitor = (node, ctx) => {
  const name = typeName(field(node, 'name'));
  if (name && name !== 'Self') ctx.call(name, node);
};

const attributeItem: Visitor = (node, ctx) => {
  state(ctx).attrEnd = node.endIndex;
};

// ---------------------------------------------------------------------------
// Macro arguments (token trees)
// ---------------------------------------------------------------------------

const ITEM_KEYWORDS = new Set(['fn', 'struct', 'enum', 'union', 'trait', 'mod', 'impl', 'const', 'static', 'type']);
const ITEM_MODIFIERS = new Set(['pub', 'async', 'unsafe', 'const', 'extern', 'default', 'string_literal']);
const ITEM_KINDS: Record<string, DefOpts['kind']> = {
  struct: 'struct', union: 'struct', enum: 'enum', trait: 'trait', mod: 'namespace',
  const: 'constant', static: 'constant', type: 'type',
};

function isGroup(node: Node | undefined | null, open: string): node is Node {
  return !!node && node.type === 'token_tree' && node.firstChild?.type === open;
}

/**
 * Line range of an item recovered from macro arguments: from its first token
 * (visibility / `async` / keyword) to its last one. There is no single node
 * that covers it, and the framework takes the range of a definition from a
 * node, so this builds the few node properties `Ctx.def` reads.
 * `doc` is the last doc comment in front of the item (for the doc line).
 */
function span(first: Node, last: Node, doc: Node | null | undefined): Node {
  return {
    startIndex: first.startIndex,
    endIndex: last.endIndex,
    startPosition: first.startPosition,
    endPosition: last.endPosition,
    previousSibling: doc ?? null,
    parent: null,
  } as unknown as Node;
}

/** Doc comments in front of token `cs[s]`, skipping `#[attr]` pairs. */
function docBefore(cs: Node[], s: number): Node[] {
  const parts: Node[] = [];
  for (let d = s - 1; d >= 0 && parts.length < 400;) {
    const t = cs[d]!;
    if (isComment(t)) {
      parts.unshift(t);
      d--;
    } else if (isGroup(t, '[') && d >= 1 && cs[d - 1]!.type === '#') {
      d -= 2;
    } else {
      break;
    }
  }
  return parts;
}

/**
 * Declared types in a parameter list or struct body given as a token group:
 * `(future: F, meta: SpawnMeta<'_>)`, `{ #[pin] pub inner: Inner, .. }`.
 */
function groupHints(group: Node, ctx: Ctx, st: FileState): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const len = group.endIndex - group.startIndex;
  if (len < 5 || len > 4000) return out;
  const text = ctx.src.slice(group.startIndex + 1, group.endIndex - 1).replace(/\/\/[^\n]*/g, '');
  const entry = (start: number, end: number): void => {
    const m = /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?(?:mut\s+)?([A-Za-z_]\w*)\s*:(?!:)\s*(\S[^]*)$/.exec(text.slice(start, end));
    if (!m || m[2]!.length > MAX_TYPE_TEXT) return;
    const type = cleanType(m[2]!, group.startIndex, st);
    if (type) out.push([m[1]!, type]);
  };
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 60 || ch === 40 || ch === 91 || ch === 123) depth++; // < ( [ {
    else if (ch === 41 || ch === 93 || ch === 125) depth--; // ) ] }
    else if (ch === 62) { // > but not -> / =>
      const before = text.charCodeAt(i - 1);
      if (before !== 45 && before !== 61) depth--;
    } else if (ch === 44 && depth === 0) { // ,
      entry(start, i);
      start = i + 1;
    }
  }
  entry(start, text.length);
  return out;
}

/**
 * `macro_rules! name { .. }` inside macro arguments (`doc! { macro_rules! select { .. } }`).
 * `cs[i]` is the `macro_rules` identifier.
 */
function macroRules(cs: Node[], i: number, st: FileState): void {
  const name = cs[i + 2];
  const body = cs[i + 3];
  if (cs[i + 1]?.type !== '!' || !name || name.type !== 'identifier' || !body || body.type !== 'token_tree') return;
  if (st.pending.has(body.startIndex)) return;
  let exported = false;
  for (let d = i - 1; d >= 1; d--) {
    const t = cs[d]!;
    if (isComment(t)) continue;
    if (!isGroup(t, '[') || cs[d - 1]!.type !== '#') break;
    if (t.endIndex - t.startIndex < 40 && t.text.includes('macro_export')) exported = true;
    d--;
  }
  const docParts = docBefore(cs, i);
  st.pending.set(body.startIndex, {
    def: {
      name: name.text,
      kind: 'macro',
      sig: 'macro_rules! ' + name.text,
      doc: joinDoc(docParts) ?? '',
      exported,
      range: span(cs[i]!, body, docParts[docParts.length - 1]),
    },
    macroDef: true,
  });
}

/**
 * Receiver of a call recovered from tokens; `cs[k]` is the called name.
 * `x.f(..)` -> x, `self.q.f(..)` -> self.q, `A::B::f(..)` -> A::B, call
 * chains and other expressions -> '?', a bare `f(..)` -> null.
 */
function tokenReceiver(cs: Node[], k: number): string | null {
  const sep = cs[k - 1]?.type;
  if (sep !== '.' && sep !== '::') return null;
  let recv = '';
  for (let j = k - 2, parts = 0; j >= 0; j -= 2, parts++) {
    const t = cs[j]!;
    const type = t.type;
    if (type !== 'identifier' && type !== 'self' && type !== 'crate' && type !== 'super') return '?';
    if (parts >= (sep === '.' ? 2 : 4)) return '?';
    recv = recv ? t.text + sep + recv : t.text;
    const before = cs[j - 1]?.type;
    if (before === sep) continue;
    return before === '.' || before === '::' ? '?' : recv;
  }
  return recv || '?';
}

/** `impl<T> fmt::Debug for &'a Foo<T> where ..` -> [Foo, Debug] */
function implHeader(header: string): [string, string | null] | null {
  let h = header;
  for (let i = 0; i < 8; i++) {
    const next = h.replace(/<[^<>]*>/g, '');
    if (next === h) break;
    h = next;
  }
  const m = /^impl\s*(?:!?\s*([\w:]+)\s+for\s+)?(?:[&*]\s*(?:'\w+\s+)?|(?:mut|const|dyn)\s+)*([\w:]+)/.exec(h);
  if (!m) return null;
  const last = (p: string) => p.slice(p.lastIndexOf(':') + 1);
  const name = last(m[2]!);
  return name ? [name, m[1] ? last(m[1]) : null] : null;
}

/**
 * Items inside macro arguments (`cfg_rt! { pub fn spawn() {..} }`,
 * `pin_project! { struct X {..} }`) are plain token sequences. Recognise
 * `<keyword> <name> ... { body }` and define the symbol when the walker
 * reaches the body tree, so that it scopes the nested tokens like a parsed
 * item does. `cs[i]` is the keyword token.
 */
function macroItem(cs: Node[], i: number, member: boolean, ctx: Ctx, st: FileState): void {
  const kw = cs[i]!.type;

  if (kw === 'impl') {
    const before = i > 0 ? cs[i - 1]!.type : ';';
    if (before !== ';' && before !== '{' && before !== 'token_tree' && before !== 'unsafe' && before !== 'default' &&
        before !== 'line_comment' && before !== 'block_comment') return; // `-> impl Trait`, `x: impl Trait`
    for (let j = i + 1; j < cs.length && j < i + 80; j++) {
      const t = cs[j]!;
      if (t.type === ';') return;
      if (!isGroup(t, '{')) continue;
      if (st.pending.has(t.startIndex)) return;
      const start = cs[i]!.startIndex;
      const parsed = implHeader(ctx.src.slice(start, Math.min(t.startIndex, start + 400)));
      if (!parsed) return;
      st.pending.set(t.startIndex, { scope: parsed[0], trait: parsed[1], member: true });
      return;
    }
    return;
  }

  let nameNode = cs[i + 1];
  if (nameNode && nameNode.type === 'mutable_specifier') nameNode = cs[i + 2];
  if (!nameNode || nameNode.type !== 'identifier') return;
  const name = nameNode.text;

  // Modifiers in front of the keyword: `pub(crate) async unsafe fn`
  let s = i;
  let exported = false;
  while (s > 0) {
    const t = cs[s - 1]!.type;
    if (ITEM_MODIFIERS.has(t)) {
      if (t === 'pub') exported = true;
      s--;
    } else if (t === 'token_tree' && s >= 2 && cs[s - 2]!.type === 'pub') {
      exported = true;
      s -= 2;
    } else {
      break;
    }
  }
  const docParts = docBefore(cs, s);
  const lastDoc = docParts[docParts.length - 1];
  const doc = joinDoc(docParts) ?? '';
  const first = cs[s]!;
  const start = first.startIndex;
  const sigTo = (end: number) => ctx.src.slice(start, Math.min(end, start + MAX_SIG_SLICE)).replace(/[;,\s]+$/, '');

  if (kw === 'const' || kw === 'static' || kw === 'type') {
    if (kw !== 'type' && ctx.inCallable()) return;
    let eq = -1;
    for (let j = i + 2; j < cs.length && j < i + 200; j++) {
      const t = cs[j]!;
      if (t.type === '=') {
        if (eq < 0) eq = t.startIndex;
      } else if (t.type === ';') {
        const long = eq >= 0 && t.startIndex - eq > 80;
        ctx.def(nameNode, {
          name, kind: ITEM_KINDS[kw]!, sig: sigTo(long ? eq : t.startIndex), doc, scope: false,
          range: span(first, t, lastDoc),
          exported: exported || (member && kw === 'type'),
        });
        return;
      }
    }
    return;
  }

  let body: Node | null = null;
  let params: Node | null = null;
  let last: Node | null = null;
  let end = -1;
  for (let j = i + 2; j < cs.length && j < i + 120; j++) {
    const t = cs[j]!;
    if (t.type === ';') { end = t.startIndex; last = t; break; }
    if (isGroup(t, '{')) { body = t; break; }
    if (!params && kw === 'fn' && isGroup(t, '(')) params = t;
  }
  if (kw === 'mod' && !body) {
    if (end >= 0) ctx.imp('self::' + name, nameNode, [name]);
    return;
  }
  if (!body && end < 0) return;
  const isType = kw === 'struct' || kw === 'union' || kw === 'enum';
  const opts: DefOpts = {
    name,
    kind: kw === 'fn' ? (member ? 'method' : 'function') : ITEM_KINDS[kw]!,
    sig: sigTo(body ? body.startIndex : end),
    doc,
    exported,
    // The whole item, not only its body: `pub fn spawn<F>(..) -> .. where .. { .. }`
    range: span(first, body ?? last ?? nameNode, lastDoc),
  };
  if (body && !st.pending.has(body.startIndex)) {
    const typed = kw === 'fn' ? params : kw === 'struct' || kw === 'union' ? body : null;
    const hints = typed ? groupHints(typed, ctx, st) : undefined;
    st.pending.set(body.startIndex, { def: opts, member: kw === 'trait', isType, hints });
  } else {
    opts.scope = false;
    const sym = ctx.def(nameNode, opts);
    if (isType) st.types.set(name, sym);
  }
}

/**
 * Macro arguments are not parsed as expressions or items. Recover the obvious
 * calls: an identifier directly followed by a parenthesised group (`foo(..)`,
 * `x.bar(..)`, `A::new(..)`) or by `!` and a group (nested macros); and the
 * items (see macroItem).
 */
const tokenTree: Visitor = (node, ctx) => {
  const st = state(ctx);
  if (node.startIndex < st.attrEnd) return;
  if (node.firstChild?.type === '[' && node.previousSibling?.type === '#') {
    st.attrEnd = node.endIndex; // `#[cfg(..)]` inside macro arguments / macro templates
    return;
  }
  let member = false;
  const p = st.pending.get(node.startIndex);
  if (p) {
    st.pending.delete(node.startIndex);
    if (p.def) {
      const sym = ctx.def(node, p.def);
      if (p.isType) st.types.set(p.def.name, sym);
      if (p.macroDef) st.macroDefEnd = node.endIndex;
      if (p.hints) for (const [name, type] of p.hints) ctx.typeHint(name, type);
    } else if (p.scope) {
      ctx.scope(p.scope);
      const sym = st.types.get(p.scope);
      if (p.trait && sym !== undefined) ctx.inherit(sym, p.trait, 'implements');
    }
    member = !!p.member;
  }
  const items = node.startIndex >= st.macroDefEnd;
  const cs = node.children as Node[];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (!c) continue;
    const type = c.type;
    if (type === 'token_tree') {
      const prev = i > 0 ? cs[i - 1] : null;
      if (!prev) continue;
      if (prev.type === 'identifier') {
        // `fn name(..)` is a declaration, not a call.
        if (c.firstChild?.type === '(' && !(i > 1 && cs[i - 2]?.type === 'fn')) {
          const name = prev.text;
          if (!NOISE_CALLS.has(name)) ctx.call(name, prev, tokenReceiver(cs, i - 1));
        }
      } else if (prev.type === '!') {
        const m = i > 1 ? cs[i - 2] : null;
        if (m && m.type === 'identifier') ctx.call(m.text, m);
      }
    } else if (!items) {
      continue;
    } else if (ITEM_KEYWORDS.has(type)) {
      macroItem(cs, i, member, ctx, st);
    } else if (type === 'identifier' && c.endIndex - c.startIndex === 11 && c.text === 'macro_rules') {
      macroRules(cs, i, st);
    }
  }
};

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function useTree(node: Node | null, prefix: string, decl: Node, ctx: Ctx, depth: number): void {
  if (!node || depth > 8) return;
  const join = (p: string) => (prefix ? prefix + '::' + p : p);
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'super':
    case 'metavariable':
      ctx.imp(join(node.text), decl, [node.text]);
      return;
    case 'self': // `use a::b::{self}` imports `a::b`
      if (prefix) ctx.imp(prefix, decl, [prefix.slice(prefix.lastIndexOf(':') + 1)]);
      return;
    case 'scoped_identifier': {
      const name = field(node, 'name');
      ctx.imp(join(node.text), decl, name ? [name.text] : []);
      return;
    }
    case 'use_as_clause': {
      const path = field(node, 'path');
      const alias = field(node, 'alias');
      if (!path) return;
      const source = path.type === 'self' && prefix ? prefix : join(path.text);
      const original = source.slice(source.lastIndexOf('::') + 1).replace(/^:/, '');
      // `use a::Foo as Bar`: bind the alias, remember what it stands for.
      ctx.imp(source, decl, alias ? [alias.text !== original && /^\w+$/.test(original) ? `${alias.text}=${original}` : alias.text] : []);
      return;
    }
    case 'use_wildcard': {
      const path = node.namedChildren[0];
      ctx.imp(path ? join(path.text) + '::*' : (prefix ? prefix + '::*' : '*'), decl, ['*']);
      return;
    }
    case 'scoped_use_list': {
      const path = field(node, 'path');
      useTree(field(node, 'list'), path ? join(path.text) : prefix, decl, ctx, depth + 1);
      return;
    }
    case 'use_list':
      for (const c of node.namedChildren) if (c) useTree(c, prefix, decl, ctx, depth + 1);
      return;
  }
}

const useDeclaration: Visitor = (node, ctx) => {
  useTree(field(node, 'argument'), '', node, ctx, 0);
};

const externCrate: Visitor = (node, ctx) => {
  const name = field(node, 'name');
  if (name) ctx.imp(name.text, node, [field(node, 'alias')?.text ?? name.text]);
};

export const rust: LangSpec = {
  id: 'rust',
  grammar: 'rust',
  extensions: ['.rs'],
  identifiers: ['identifier', 'type_identifier', 'field_identifier'],
  comments: ['line_comment', 'block_comment'],
  visit: {
    function_item: functionItem,
    function_signature_item: functionItem,
    struct_item: structItem,
    union_item: structItem,
    enum_item: enumItem,
    trait_item: traitItem,
    impl_item: implItem,
    mod_item: modItem,
    const_item: constItem,
    static_item: constItem,
    type_item: typeItem,
    associated_type: typeItem,
    macro_definition: macroDefinition,
    call_expression: callExpression,
    macro_invocation: macroInvocation,
    struct_expression: structExpression,
    parameter: parameter,
    let_declaration: letDeclaration,
    attribute_item: attributeItem,
    inner_attribute_item: attributeItem,
    token_tree: tokenTree,
    use_declaration: useDeclaration,
    extern_crate_declaration: externCrate,
  },
};
