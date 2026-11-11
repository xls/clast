import type { Node } from 'web-tree-sitter';
import type { SymbolKind } from '../types.js';

/**
 * Options for registering a definition found in the syntax tree.
 */
export interface DefOpts {
  name: string;
  kind: SymbolKind;
  /**
   * Outer node used for the symbol's line range and doc-comment lookup, when it
   * differs from the definition node (e.g. `export_statement`, a decorated
   * definition, or a `lexical_declaration` wrapping a declarator).
   */
  range?: Node | null;
  /**
   * Body node. The signature is the source text from the start of the range up
   * to the start of the body. Defaults to the node's `body` field. Pass `null`
   * to use the whole (first line of the) node as the signature.
   */
  body?: Node | null;
  /** Explicit signature text (overrides body-based slicing). */
  sig?: string;
  /** Explicit doc text (e.g. Python docstrings). */
  doc?: string | null;
  /**
   * Extra qualifier prepended to the qualified name for definitions that are
   * lexically outside their container: Go receivers, C++ `Foo::bar`, etc.
   */
  qualifier?: string | null;
  exported?: boolean;
  /**
   * When false the symbol does not open a scope: nested definitions are not
   * qualified by it and calls inside are attributed to the enclosing symbol.
   * Required when defining a symbol for a node other than the one being
   * visited (e.g. enum members registered from the enum visitor). Default true.
   */
  scope?: boolean;
  /**
   * Define the symbol as a member of the nearest enclosing container (class,
   * struct, ...) instead of the innermost scope. Used for instance attributes
   * assigned inside methods (`self.x = ...` in Python `__init__`).
   */
  inContainer?: boolean;
}

/**
 * Context handed to language visitors. All methods refer to the node currently
 * being visited; scopes opened by `def`/`scope` close automatically when the
 * walker leaves that node.
 */
export interface Ctx {
  readonly src: string;
  /** Register a symbol. Returns its index. */
  def(node: Node, opts: DefOpts): number;
  /** Open a naming-only scope (Rust `impl`, PHP/Java packages, ...). */
  scope(name: string): void;
  /**
   * Record a call made at `node`. `receiverType` may be given when the
   * receiver's class is evident from the expression itself
   * (`new Foo().bar()`, casts); otherwise it is derived from type hints.
   */
  call(name: string | null | undefined, node: Node, receiver?: string | null, receiverType?: string | null): void;
  /**
   * Record an import of `source`. `names` are the names bound in this file;
   * write `alias=original` when the binding is renamed (`import { a as b }`
   * -> `b=a`) and `*` for wildcard imports.
   */
  imp(source: string | null | undefined, node: Node, names?: string[]): void;
  /** Record that symbol `sym` extends/implements `name`. */
  inherit(sym: number, name: string | null | undefined, kind?: 'extends' | 'implements'): void;
  /**
   * Record an identifier occurrence under a different name than the source
   * text (e.g. C# `[Authorize]` also references `AuthorizeAttribute`).
   */
  ref(name: string | null | undefined, node: Node): void;
  /**
   * Record the declared type of a parameter, local, or field so that member
   * calls on it (`record.topic()`, `this.repo.find()`) can be resolved to
   * the right class. `type` is raw type text; it is normalised with
   * typeName(). The hint is attached to the nearest enclosing function (or
   * class, for field declarations). Pass `onContainer` = true to attach it
   * to the enclosing class even from inside a method: constructor parameter
   * properties, `self.x = Foo()` assignments.
   */
  typeHint(name: string | null | undefined, type: string | null | undefined, onContainer?: boolean): void;
  /**
   * Declare the symbol this file exports as its default
   * (`export default X`, `module.exports = X`). Importers that bind it to
   * another local name are then linked to X.
   */
  exportDefault(name: string | null | undefined): void;
  /** Kind of the innermost enclosing symbol, or null at file level. */
  parentKind(): SymbolKind | null;
  /** True if any enclosing symbol is a function or method. */
  inCallable(): boolean;
  /** Number of enclosing real symbols (0 = file level). */
  depth(): number;
}

/** Return 'skip' to prevent the walker from descending into the node. */
export type Visitor = (node: Node, ctx: Ctx) => void | 'skip';

export interface LangSpec {
  /** Language id used in config and in the database. */
  id: string;
  /** Grammar file name without the `tree-sitter-` prefix and `.wasm` suffix. */
  grammar: string;
  extensions: string[];
  /** Leaf node types recorded as identifier occurrences (reference index). */
  identifiers: string[];
  /** Type names may be lowercase (Go unexported types, C structs); see typeName(). */
  lowercaseTypes?: boolean;
  /** Node types whose text is a comment (for doc extraction). */
  comments?: string[];
  /**
   * Node types that may sit between a doc comment and the item it documents
   * (Rust attributes, PHP attributes, ...). They are skipped when looking for
   * the leading comment.
   */
  docSkip?: string[];
  /** Visitors keyed by tree-sitter node type. */
  visit: Record<string, Visitor>;
  /**
   * Optional: pick a different spec id based on file content (used to parse
   * `.h` files as C++ when they look like C++).
   */
  sniff?: (source: string, path: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers shared by language specs
// ---------------------------------------------------------------------------

export function field(node: Node | null | undefined, name: string): Node | null {
  return node ? node.childForFieldName(name) : null;
}

export function text(node: Node | null | undefined): string {
  return node ? node.text : '';
}

/** First named child with one of the given types. */
export function childOfType(node: Node | null | undefined, ...types: string[]): Node | null {
  if (!node) return null;
  for (const c of node.namedChildren) {
    if (c && types.includes(c.type)) return c;
  }
  return null;
}

export function childrenOfType(node: Node | null | undefined, ...types: string[]): Node[] {
  if (!node) return [];
  const out: Node[] = [];
  for (const c of node.namedChildren) {
    if (c && types.includes(c.type)) out.push(c);
  }
  return out;
}

/** Nearest ancestor with one of the given types (bounded). */
export function ancestor(node: Node, types: string[], maxUp = 8): Node | null {
  let cur = node.parent;
  for (let i = 0; cur && i < maxUp; i++) {
    if (types.includes(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

export function stripQuotes(s: string): string {
  return s.replace(/^[bru]*(['"`<])/i, '').replace(/['"`>]$/, '');
}

/** Last segment of a dotted / scoped name: `a.b.C` -> `C`, `a::b` -> `b`. */
export function lastSegment(s: string): string {
  const m = /([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*$/.exec(s);
  return m ? m[1]! : s;
}

/** Receiver marker for member calls whose receiver is a complex expression. */
export const COMPLEX_RECEIVER = '?';

/**
 * Receiver text of a member call. Short simple receivers (`this`, `db`,
 * `Foo`, `this.repo`) are returned as text; anything else (call chains,
 * literals, indexing) becomes COMPLEX_RECEIVER so the resolver still knows
 * the call HAD a receiver and is not a bare `foo()` call. Returns null only
 * when there is no receiver node at all.
 */
export function simpleReceiver(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.endIndex - node.startIndex > 48) return COMPLEX_RECEIVER;
  const t = node.text;
  if (/[\s(\[{"'`]/.test(t) || /^\d/.test(t)) return COMPLEX_RECEIVER;
  return t;
}

const TYPE_WRAPPERS = new Set([
  'Option', 'Optional', 'Arc', 'Rc', 'Box', 'RefCell', 'Mutex', 'RwLock', 'Cell', 'Pin', 'Weak',
  'Promise', 'Readonly', 'Partial', 'Required', 'NonNullable', 'Awaited', 'Lazy', 'Task', 'ValueTask',
  'Nullable', 'Future', 'CompletableFuture', 'Supplier', 'Provider', 'Ref', 'Ptr', 'unique_ptr',
  'shared_ptr', 'weak_ptr', 'Type', 'ClassVar', 'Final', 'Annotated',
]);

/**
 * Reduce raw type text to the bare name of the class it denotes, or null:
 * `*Site` -> Site, `ProducerRecord<K, V>` -> ProducerRecord,
 * `Option<Arc<Handle>>` -> Handle, `pkg.Foo` / `ns::Foo` -> Foo,
 * `Foo | null` -> Foo, `const Foo&` -> Foo. Collections and primitives
 * are not class types and yield null.
 */
export function typeName(raw: string | null | undefined, allowLowercase = false): string | null {
  if (!raw) return null;
  let t = raw.trim();
  for (let i = 0; i < 4; i++) {
    // Strip qualifiers, pointer / reference sigils and lifetimes until stable (`&'a mut Foo`).
    for (let guard = 0; guard < 6; guard++) {
      const before = t;
      t = t
        .replace(/^(const|readonly|mut|final|volatile|static|ref|out|in|params|dyn|impl|struct|class|enum|typename|unsigned|signed)\s+/, '')
        .replace(/^[&*?\s:]+/, '')
        .replace(/^'[a-z_]+\s+/, '');
      if (t === before) break;
    }
    t = t
      .replace(/[&*?!\s]+$/, '')
      .replace(/\s*\|\s*(null|undefined|None)\b/g, '')
      .replace(/^(null|undefined|None)\s*\|\s*/, '')
      .trim();
    const m = /^([\w.:\\]+)\s*[<\[](.*)[>\]]$/s.exec(t);
    if (!m) break;
    const outer = m[1]!.split(/\.|::|\\/).pop()!;
    if (!TYPE_WRAPPERS.has(outer)) { t = m[1]!; break; }
    // Unwrap: first type argument at nesting depth 0.
    let depth = 0;
    let end = m[2]!.length;
    for (let k = 0; k < m[2]!.length; k++) {
      const ch = m[2]![k];
      if (ch === '<' || ch === '[' || ch === '(') depth++;
      else if (ch === '>' || ch === ']' || ch === ')') depth--;
      else if (ch === ',' && depth === 0) { end = k; break; }
    }
    t = m[2]!.slice(0, end).trim();
  }
  if (/[|&(){}\[\],<>=\s]/.test(t)) return null;
  const name = t.split(/\.|::|\\/).pop() ?? '';
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  if (name.length < 2) return null;
  if (!/[A-Z]/.test(name[0]!)) {
    // Lowercase names are primitives / builtins in most languages (int, string, str, bool, ...).
    // Go and C name real types in lowercase too, so those specs opt in, minus the builtins.
    if (!allowLowercase || PRIMITIVE_TYPES.has(name) || /^(u?int|float|complex)\d*(_t)?$/.test(name) || name.endsWith('_t')) return null;
  }
  return name;
}

const PRIMITIVE_TYPES = new Set([
  'int', 'uint', 'char', 'short', 'long', 'float', 'double', 'void', 'bool', 'boolean', 'byte', 'rune', 'string',
  'str', 'error', 'any', 'auto', 'var', 'let', 'unsigned', 'signed', 'size', 'uintptr', 'interface', 'struct',
  'func', 'map', 'chan', 'object', 'number', 'bigint', 'symbol', 'unknown', 'never', 'null', 'undefined', 'dict',
  'list', 'tuple', 'set', 'bytes', 'usize', 'isize', 'self', 'this', 'array', 'mixed', 'callable', 'iterable',
  'static', 'const', 'wchar', 'ssize', 'off', 'time', 'file', 'va_list', 'sds',
  // C++ standard library value types: not classes of the project.
  'vector', 'deque', 'pair', 'queue', 'stack', 'mutex', 'thread', 'atomic', 'function', 'optional', 'variant',
  'ostream', 'istream', 'ofstream', 'ifstream', 'stringstream', 'unordered_map', 'unordered_set', 'basic_string',
  'string_view', 'span', 'bitset', 'complex', 'regex', 'iterator', 'allocator',
]);

/** UPPER_SNAKE names are treated as constants. */
export function isConstName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && name.length > 1;
}
