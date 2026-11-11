/** Kinds of symbols stored in the index. */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'struct'
  | 'trait'
  | 'enum'
  | 'type'
  | 'namespace'
  | 'constant'
  | 'variable'
  | 'field'
  | 'property'
  | 'macro'
  | 'declaration';

export const SYMBOL_KINDS: SymbolKind[] = [
  'function', 'method', 'class', 'interface', 'struct', 'trait', 'enum', 'type',
  'namespace', 'constant', 'variable', 'field', 'property', 'macro', 'declaration',
];

/** Kinds that can contain members (used for outlines and qualified names). */
export const CONTAINER_KINDS = new Set<SymbolKind>([
  'class', 'interface', 'struct', 'trait', 'enum', 'namespace',
]);

export const CALLABLE_KINDS = new Set<SymbolKind>(['function', 'method', 'macro', 'declaration']);

/** A symbol as produced by the extractor (before it gets a database id). */
export interface ExSymbol {
  name: string;
  /** Dotted qualified name, e.g. "ParserManager.parseAndStore". */
  qname: string;
  kind: SymbolKind;
  signature: string;
  doc: string;
  /** 1-based line of the definition. */
  startLine: number;
  endLine: number;
  startCol: number;
  /** 1-based first line of the leading doc comment / decorators, or 0. */
  docLine: number;
  /** Index of the parent symbol in the same extraction, or -1. */
  parent: number;
  exported: boolean;
}

export interface ExCall {
  /** Index of the calling symbol in the same extraction, or -1 for file level. */
  caller: number;
  name: string;
  line: number;
  /** Receiver text for member calls ("this", "self", "Foo", "db"), if simple. */
  receiver: string | null;
  /** Declared type of the receiver when a type hint was in scope (`Foo` for `x: Foo; x.bar()`). */
  rtype: string | null;
  count: number;
}

export interface ExImport {
  source: string;
  names: string[];
  line: number;
}

export interface ExHeritage {
  symbol: number;
  name: string;
  kind: 'extends' | 'implements';
}

/** Everything extracted from a single source file. */
export interface Extraction {
  lang: string;
  lineCount: number;
  symbols: ExSymbol[];
  calls: ExCall[];
  imports: ExImport[];
  heritage: ExHeritage[];
  /** Identifier occurrences: [name, "12,40,41"] (1-based lines, capped per file). */
  occ: Array<[string, string]>;
  hadError: boolean;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  name_lc: string;
  qname: string;
  kind: SymbolKind;
  signature: string;
  doc: string;
  start_line: number;
  end_line: number;
  start_col: number;
  doc_line: number;
  parent_id: number | null;
  exported: number;
  /** Joined from files. */
  path: string;
  lang: string;
}

export interface FileRow {
  id: number;
  path: string;
  hash: string;
  mtime: number;
  size: number;
  lang: string;
  line_count: number;
  symbol_count: number;
  indexed_at: number;
}
