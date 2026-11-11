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
  /** Record a call made at `node`. */
  call(name: string | null | undefined, node: Node, receiver?: string | null): void;
  /** Record an import of `source`. */
  imp(source: string | null | undefined, node: Node, names?: string[]): void;
  /** Record that symbol `sym` extends/implements `name`. */
  inherit(sym: number, name: string | null | undefined, kind?: 'extends' | 'implements'): void;
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

/** Receiver text if it is short and simple enough to be a useful hint. */
export function simpleReceiver(node: Node | null | undefined): string | null {
  if (!node) return null;
  const t = node.text;
  if (t.length > 40 || /[\s(]/.test(t)) return null;
  return t;
}

/** UPPER_SNAKE names are treated as constants. */
export function isConstName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && name.length > 1;
}
