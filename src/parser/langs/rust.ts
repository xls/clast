import type { Node } from 'web-tree-sitter';
import { cleanComment } from '../extractor.js';
import type { Ctx, DefOpts, LangSpec, Visitor } from '../spec.js';
import { field } from '../spec.js';

const MAX_SIG_SLICE = 600;
const MAX_DOC = 600;
const MAX_DOC_LINES = 40;

/** Prelude enum constructors: never user symbols, extremely frequent. */
const NOISE_CALLS = new Set(['Some', 'Ok', 'Err']);

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
}
const states = new WeakMap<Ctx, FileState>();
function state(ctx: Ctx): FileState {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { types: new Map(), attrEnd: -1, macroDefEnd: -1, pending: new Map() }));
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

function shortText(node: Node | null | undefined, max = 40): string | null {
  if (!node || node.endIndex - node.startIndex > max) return null;
  const t = node.text;
  return /[\s(]/.test(t) ? null : t;
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
    ctx.inherit(sym, typeName(b), 'extends');
  }
};

/** `impl Type` / `impl Trait for Type`: naming scope only, never a symbol. */
const implItem: Visitor = (node, ctx) => {
  const name = typeName(field(node, 'type'));
  if (!name) return;
  ctx.scope(name);
  const trait = field(node, 'trait');
  if (!trait) return;
  // Heritage needs the symbol of the implementing type: only known when the
  // type is defined earlier in the same file.
  const sym = state(ctx).types.get(name);
  if (sym !== undefined) ctx.inherit(sym, typeName(trait), 'implements');
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
          : shortText(path);
        ctx.call(field(fn, 'name')?.text, node, recv);
        return;
      }
      case 'field_expression':
        ctx.call(field(fn, 'field')?.text, node, shortText(field(fn, 'value')));
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
  else if (m.type === 'scoped_identifier') ctx.call(field(m, 'name')?.text, node, shortText(field(m, 'path')));
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
  // Doc comments in front of that, skipping `#[attr]` pairs.
  const docParts: Node[] = [];
  for (let d = s - 1; d >= 0 && docParts.length < 400;) {
    const t = cs[d]!;
    if (isComment(t)) {
      docParts.unshift(t);
      d--;
    } else if (isGroup(t, '[') && d >= 1 && cs[d - 1]!.type === '#') {
      d -= 2;
    } else {
      break;
    }
  }
  const doc = joinDoc(docParts) ?? '';
  const start = cs[s]!.startIndex;
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
          exported: exported || (member && kw === 'type'),
        });
        return;
      }
    }
    return;
  }

  let body: Node | null = null;
  let end = -1;
  for (let j = i + 2; j < cs.length && j < i + 120; j++) {
    const t = cs[j]!;
    if (t.type === ';') { end = t.startIndex; break; }
    if (isGroup(t, '{')) { body = t; break; }
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
  };
  if (body && !st.pending.has(body.startIndex)) {
    st.pending.set(body.startIndex, { def: opts, member: kw === 'trait', isType });
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
          if (!NOISE_CALLS.has(name)) ctx.call(name, prev);
        }
      } else if (prev.type === '!') {
        const m = i > 1 ? cs[i - 2] : null;
        if (m && m.type === 'identifier') ctx.call(m.text, m);
      }
    } else if (items && ITEM_KEYWORDS.has(type)) {
      macroItem(cs, i, member, ctx, st);
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
      ctx.imp(source, decl, alias ? [alias.text] : []);
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
    attribute_item: attributeItem,
    inner_attribute_item: attributeItem,
    token_tree: tokenTree,
    use_declaration: useDeclaration,
    extern_crate_declaration: externCrate,
  },
};
