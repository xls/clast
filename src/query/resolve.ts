import type { ClastDb } from '../db/index.js';
import { SYMBOL_COLUMNS, SYMBOL_FROM } from '../db/index.js';
import { CONTAINER_KINDS, type SymbolKind, type SymbolRow } from '../types.js';
import { ARITY_LANGS, arityFits, paramRange, type ParamRange } from './arity.js';
import { isTestPath, isVendoredPath } from './format.js';
import { splitIdentifier } from './words.js';

const LANG_FAMILY: Record<string, string> = {
  typescript: 'js', tsx: 'js', javascript: 'js', vue: 'js',
  c: 'c', cpp: 'c', objc: 'c',
};

export function langFamily(lang: string): string {
  return LANG_FAMILY[lang] ?? lang;
}

export const KIND_WEIGHT: Record<SymbolKind, number> = {
  class: 7, interface: 6, struct: 6, trait: 6, enum: 5,
  function: 6, method: 5, type: 4, namespace: 3, macro: 3,
  constant: 2, variable: 1, property: 0, field: 0, declaration: -3,
};

export interface SymbolRef {
  name: string;
  /** Container segments before the name (`Foo.Bar.baz` -> [Foo, Bar]). */
  container: string[];
  path?: string;
  line?: number;
}

/**
 * Parse the ways an agent may refer to a symbol:
 * `name`, `Class.method`, `Class::method`, `Class#method`,
 * `path/file.ts:name`, `path/file.ts:123` (symbol at line).
 */
export function parseSymbolRef(ref: string): SymbolRef {
  let text = ref.trim().replace(/\(.*\)$/s, '').replace(/!$/, '');
  let path: string | undefined;
  let line: number | undefined;
  const m = /^(.*[\\/.][^:]*):([^:\\/]+)$/.exec(text);
  if (m && !m[1]!.endsWith(':')) {
    path = m[1]!.replace(/\\/g, '/');
    if (/^\d+$/.test(m[2]!)) {
      line = Number(m[2]);
      return { name: '', container: [], path, line };
    }
    text = m[2]!;
  }
  const segs = text.split(/::|#|\.|->|\\/).map(s => s.trim()).filter(Boolean);
  const name = segs.pop() ?? text;
  return { name, container: segs, path, line };
}

function containerMatches(qname: string, container: string[], exact: boolean): boolean {
  if (container.length === 0) return true;
  const parts = qname.split('.');
  parts.pop();
  if (parts.length < container.length) return false;
  for (let i = 1; i <= container.length; i++) {
    const a = parts[parts.length - i]!;
    const b = container[container.length - i]!;
    if (exact ? a !== b : a.toLowerCase() !== b.toLowerCase()) return false;
  }
  return true;
}

export function pathMatches(path: string, filter: string): boolean {
  const f = filter.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path === f) return true;
  if (path.endsWith('/' + f) || path.startsWith(f.endsWith('/') ? f : f + '/')) return true;
  return path.toLowerCase().includes(f.toLowerCase());
}

/** Static desirability of a symbol as "the" definition of its name. */
export function definitionScore(s: SymbolRow): number {
  let score = KIND_WEIGHT[s.kind] ?? 0;
  if (s.exported) score += 2;
  if (isTestPath(s.path)) score -= 6;
  if (isVendoredPath(s.path)) score -= 4;
  // Longer bodies are more likely the real implementation than a stub/overload.
  score += Math.min(3, Math.log2(1 + s.end_line - s.start_line) / 2);
  return score;
}

/**
 * Resolve a symbol reference to definitions, best first. Falls back to
 * case-insensitive matching when nothing matches exactly.
 */
export function findSymbols(
  db: ClastDb,
  ref: string | SymbolRef,
  opts: { path?: string; kind?: string; exact?: boolean } = {}
): SymbolRow[] {
  let r = typeof ref === 'string' ? parseSymbolRef(ref) : ref;
  // Ruby `loaded!`: the parser drops a trailing `!` (Rust macro syntax), keep it when such a name exists.
  if (typeof ref === 'string' && /!\s*$/.test(ref) && r.name && db.symbolsByName(r.name + '!').length) r = { ...r, name: r.name + '!' };
  const pathFilter = opts.path ?? r.path;

  if (r.line !== undefined && r.path) {
    const file = findFiles(db, r.path)[0];
    if (!file) return [];
    const s = db.enclosingSymbol(file.id, r.line);
    return s ? [s] : [];
  }

  const filter = (rows: SymbolRow[], exact: boolean): SymbolRow[] =>
    rows.filter(s =>
      containerMatches(s.qname, r.container, exact) &&
      (!pathFilter || pathMatches(s.path, pathFilter)) &&
      (!opts.kind || s.kind === opts.kind)
    );

  const byName = db.symbolsByName(r.name);
  let rows = filter(byName, true);
  // Case-insensitive matching is a fallback for a misspelt name, not for a name that exists
  // but was filtered out by path / kind (that would silently swap in an unrelated symbol).
  if (rows.length === 0 && byName.length === 0 && !opts.exact) {
    rows = filter(
      db.all<SymbolRow>(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.name_lc = ?`, r.name.toLowerCase()),
      false
    );
  }
  const accept = (s: SymbolRow): boolean =>
    (!pathFilter || pathMatches(s.path, pathFilter)) && (!opts.kind || s.kind === opts.kind);

  // Sub.inheritedMember: the member is defined on a supertype of the named container.
  if (rows.length === 0 && r.container.length && byName.length) {
    const ancestors = ancestorNames(db, r.container[r.container.length - 1]!);
    if (ancestors.size) {
      rows = byName.filter(s => {
        const parts = s.qname.split('.');
        return parts.length >= 2 && ancestors.has(parts[parts.length - 2]!) && accept(s);
      });
    }
  }

  // Leading segments that name packages / modules / namespaces rather than
  // classes: django.shortcuts.render, page.Clear, Illuminate\Pipeline\Pipeline,
  // runtime::Handle::current. Match them against the file path instead.
  if (rows.length === 0 && r.container.length && byName.length) {
    for (let k = r.container.length - 1; k >= 0 && rows.length === 0; k--) {
      const containerPart = r.container.slice(r.container.length - k);
      const pathPart = r.container.slice(0, r.container.length - k).map(p => p.toLowerCase());
      rows = byName.filter(s => {
        if (!containerMatches(s.qname, containerPart, false) || !accept(s)) return false;
        const segs = s.path.toLowerCase().replace(/\.[a-z0-9]+$/, '').split('/');
        let at = 0;
        for (const seg of segs) {
          if (at < pathPart.length && seg === pathPart[at]) at++;
        }
        return at === pathPart.length;
      });
    }
  }

  // path:name where the file only re-exports the symbol (__init__.py, index.ts barrels).
  if (rows.length === 0 && pathFilter && byName.length) {
    const reexporters = findFiles(db, pathFilter, 4);
    const targets = new Set<number>();
    for (const f of reexporters) {
      for (const hop1 of db.all<{ resolved_id: number }>(
        `SELECT resolved_id FROM imports WHERE file_id = ? AND resolved_id IS NOT NULL`, f.id
      )) {
        targets.add(hop1.resolved_id);
        for (const hop2 of db.all<{ resolved_id: number }>(
          `SELECT resolved_id FROM imports WHERE file_id = ? AND resolved_id IS NOT NULL`, hop1.resolved_id
        )) targets.add(hop2.resolved_id);
      }
    }
    rows = byName.filter(
      s => targets.has(s.file_id) && containerMatches(s.qname, r.container, false) && (!opts.kind || s.kind === opts.kind)
    );
  }
  const importers = new Map<number, number>();
  const importerBoost = (fileId: number): number => {
    let n = importers.get(fileId);
    if (n === undefined) {
      n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM imports WHERE resolved_id = ?`, fileId)?.n ?? 0;
      importers.set(fileId, n);
    }
    // Among copies of the same code, the one the rest of the project imports is the real one.
    return Math.min(4, Math.log2(1 + n) / 2);
  };
  const multi = rows.length > 1;
  return rows
    .map(s => ({ s, score: definitionScore(s) + (multi ? importerBoost(s.file_id) : 0) }))
    .sort((a, b) => b.score - a.score || a.s.path.length - b.s.path.length || a.s.path.localeCompare(b.s.path) || a.s.start_line - b.s.start_line)
    .map(x => x.s);
}

/** Drop overloads / re-declarations of `chosen` (same qualified name in the same file). */
export function otherDefinitions(
  chosen: SymbolRow,
  all: SymbolRow[],
  family?: Set<number>
): { others: SymbolRow[]; overloads: number } {
  const others: SymbolRow[] = [];
  let overloads = 0;
  for (const s of all) {
    if (s.id === chosen.id) continue;
    // Interface declarations, overrides and implementations of the chosen member are not rivals.
    if (family && family.has(s.id)) continue;
    if (s.file_id === chosen.file_id && s.qname === chosen.qname) overloads++;
    // The parts of a C# partial class are one class.
    else if (
      s.qname === chosen.qname && s.kind === chosen.kind && s.lang === 'csharp' &&
      /\bpartial\b/.test(s.signature) && /\bpartial\b/.test(chosen.signature)
    ) continue;
    // A C / C++ prototype and its definition are one function, not two candidates.
    else if (cTwins(s, chosen)) continue;
    else others.push(s);
  }
  return { others, overloads };
}

/** Names of all supertypes (transitive, bounded) of the containers called `name`. */
export function ancestorNames(db: ClastDb, name: string): Set<string> {
  const out = new Set<string>();
  let frontier = [name];
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const row of db.all<{ name: string }>(
        `SELECT h.name FROM heritage h JOIN symbols s ON s.id = h.symbol_id WHERE s.name = ?`, n
      )) {
        if (row.name !== name && !out.has(row.name)) {
          out.add(row.name);
          next.push(row.name);
        }
      }
    }
    frontier = next.slice(0, 40);
  }
  return out;
}

export interface FileHit {
  id: number;
  path: string;
  lang: string;
  line_count: number;
  symbol_count: number;
}

/** Resolve a (possibly partial) file path: exact, suffix, then substring. */
export function findFiles(db: ClastDb, query: string, limit = 20): FileHit[] {
  const q = query.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const cols = 'id, path, lang, line_count, symbol_count';
  const exact = db.get<FileHit>(`SELECT ${cols} FROM files WHERE path = ?`, q);
  if (exact) return [exact];
  const like = (s: string): string => s.replace(/[\\%_]/g, c => '\\' + c);
  const suffix = db.all<FileHit>(
    `SELECT ${cols} FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY length(path) LIMIT ?`,
    '%/' + like(q), limit
  );
  if (suffix.length) return suffix;
  return db.all<FileHit>(
    `SELECT ${cols} FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY length(path) LIMIT ?`,
    '%' + like(q) + '%', limit
  );
}

// ---------------------------------------------------------------------------
// Call resolution
// ---------------------------------------------------------------------------

/**
 * Everything that can be the target of a call expression. Fields, properties
 * and variables are included because they often hold callables
 * (`register_lookup = class_or_instance_method(...)`, `onClick = () => {}`).
 */
const CALL_TARGET_KINDS = new Set<SymbolKind>([
  'function', 'method', 'class', 'struct', 'macro', 'declaration', 'type', 'interface', 'trait', 'enum',
  'field', 'property', 'variable', 'constant',
]);
const VALUE_KINDS = new Set<SymbolKind>(['field', 'property', 'variable', 'constant']);
const TYPE_KINDS = new Set<SymbolKind>(['class', 'struct', 'interface', 'trait', 'enum', 'type']);

/** In C nothing but functions and macros can be called. */
const C_CALLABLE = new Set<SymbolKind>(['function', 'declaration', 'macro']);

/** Families where a bare name must be defined in the file or imported into it. */
const STRICT_IMPORTS = new Set(['js', 'python']);
/** Languages where every file in a directory shares one namespace (no import needed). */
const SAME_DIR_PACKAGE = new Set(['java', 'go', 'kotlin', 'scala', 'csharp', 'php']);
const CALLABLE = new Set<SymbolKind>(['function', 'method', 'declaration', 'macro']);
/** Families where an unresolved import of a name proves the name is external. */
const EXTERNAL_IF_UNRESOLVED = new Set(['js', 'python', 'java']);
/** Languages where extension methods / open classes let unrelated code add methods to a type. */
const OPEN_TYPES = new Set(['csharp', 'rust', 'ruby', 'swift', 'kotlin']);

/**
 * Method names that exist on built-in collections, strings, promises, streams
 * and loggers in most languages. A call to one of these on a receiver of
 * unknown type is far more likely to be the builtin than a project method
 * with the same name, so it needs real evidence to be linked.
 */
const COMMON_MEMBER_NAMES = new Set([
  'get', 'set', 'add', 'put', 'push', 'pop', 'shift', 'unshift', 'append', 'prepend', 'extend', 'insert', 'remove',
  'delete', 'clear', 'update', 'join', 'split', 'count', 'len', 'length', 'size', 'keys', 'values', 'items',
  'entries', 'index', 'find', 'filter', 'map', 'reduce', 'each', 'foreach', 'sort', 'reverse', 'slice', 'splice',
  'concat', 'includes', 'contains', 'has', 'indexof', 'strip', 'trim', 'replace', 'format', 'encode', 'decode',
  'read', 'write', 'close', 'open', 'flush', 'send', 'receive', 'recv', 'next', 'then', 'catch', 'finally',
  'tostring', 'string', 'str', 'equals', 'hashcode', 'compare', 'compareto', 'clone', 'copy', 'isempty', 'empty',
  'first', 'last', 'any', 'all', 'sum', 'min', 'max', 'call', 'apply', 'bind', 'exec', 'test', 'match', 'search',
  'emit', 'on', 'off', 'once', 'log', 'error', 'warn', 'info', 'debug', 'trace', 'print', 'println', 'parse',
  'stringify', 'start', 'stop', 'run', 'execute', 'init', 'reset', 'dispose', 'destroy', 'name', 'value', 'type',
  'id', 'data', 'key', 'lock', 'unlock', 'wait', 'notify', 'await', 'unwrap', 'expect', 'ok', 'err', 'is_some',
  'is_none', 'iter', 'into_iter', 'collect', 'into', 'from', 'as_ref', 'as_str', 'to_string', 'to_owned', 'new',
  'default', 'build', 'create', 'load', 'save', 'validate', 'render', 'handle', 'process', 'intersection',
  'difference', 'union', 'isarray', 'callable', 'tolowercase', 'touppercase', 'lower', 'upper', 'startswith',
  'endswith', 'substring', 'substr', 'charat', 'tofixed', 'getattr', 'setattr', 'super', 'end', 'begin', 'at',
]);

export interface CallSite {
  fileId: number;
  path: string;
  lang: string;
  /** Receiver text, COMPLEX ('?') for expression receivers, null for bare calls. */
  receiver: string | null;
  /** Declared type of the receiver, when the extractor could determine it. */
  rtype?: string | null;
  /**
   * Row id of the call that produces this call's receiver (`a.b().c()`:
   * for c, the call to b). The receiver type is then b's return type.
   */
  via?: number | null;
  /** Symbol the call is made from, if known. */
  caller?: SymbolRow | null;
  /** Go: directory of the package the receiver type is qualified with (set by the resolver). */
  rtypeDir?: string;
  /** Number of arguments at the call site (-1 / undefined = unknown). */
  argc?: number | null;
}

export interface Resolution {
  /** Candidates, best first, with scores. */
  candidates: Array<{ sym: SymbolRow; score: number }>;
  /** True when the best candidate is clearly better than the rest. */
  confident: boolean;
}

/** Languages where a bare field name inside a method means this.field. */
const IMPLICIT_THIS = new Set(['java', 'csharp', 'cpp', 'kotlin', 'swift']);
/** Language families where a class is written in one place: a same-named class in another file is another class. */
const SINGLE_FILE_CLASS = new Set(['js', 'python', 'java', 'php', 'dart']);

/** `super.m()`, `super().m()`, C# `base.M()`, PHP `parent::m()`: the inherited implementation, never the caller's own. */
function isSuperReceiver(recv: string | null | undefined, lang: string): boolean {
  if (!recv) return false;
  return recv === 'super' || (recv === 'base' && lang === 'csharp') || (recv === 'parent' && lang === 'php');
}

const HEADER_RE = /\.(h|hh|hpp|hxx|inl|ipp)$/i;

/** A C / C++ function with internal linkage: visible only in its own translation unit. */
export function isFileLocal(s: SymbolRow): boolean {
  return /^(?:\w+\s+)*static\b/.test(s.signature) && !HEADER_RE.test(s.path) && s.qname === s.name;
}

/**
 * C / C++: a prototype and its definition (or two declarations of one function) are one target.
 * Two full definitions in different source files are different functions, as is anything `static`.
 */
export function cTwins(a: SymbolRow, b: SymbolRow): boolean {
  if (a.qname !== b.qname || langFamily(a.lang) !== 'c' || langFamily(b.lang) !== 'c') return false;
  if (a.file_id === b.file_id) return true;
  if (isFileLocal(a) || isFileLocal(b)) return false;
  // Class members (Foo::bar in a header and in a .cc) pair up by qualified name.
  if (a.qname !== a.name) return true;
  return a.kind === 'declaration' || b.kind === 'declaration' || HEADER_RE.test(a.path) || HEADER_RE.test(b.path);
}
const SELF_RECEIVERS = new Set(['this', 'self', 'super', '$this', 'cls', 'base', 'Self', 'static', 'parent', 'me']);
const CONFIDENT_SCORE = 55;
const CONFIDENT_GAP = 12;

/** Above this many same-named definitions, candidates are pre-selected before scoring. */
const PRESELECT_THRESHOLD = 40;

interface NameIndex {
  all: SymbolRow[];
  /** Members by the name of their class / struct / trait. */
  byContainer: Map<string, SymbolRow[]>;
  byFile: Map<number, SymbolRow[]>;
  /** Free functions, classes, variables: everything that is not a member. */
  free: SymbolRow[];
  containers: string[];
  /** Pre-selected candidates per receiver spelling (for common method names). */
  byReceiver: Map<string, SymbolRow[]>;
}

interface ImportedNames {
  /** Bound name -> file it is imported from (null = outside the project). */
  names: Map<string, number | null>;
  /** Files imported with `*`. */
  wildcards: Set<number>;
  /** Bound alias -> original name in the source file. */
  aliases: Map<string, string>;
}

/** Receivers that are language / runtime globals: nothing reached through them is project code. */
const BUILTIN_RECEIVERS: Record<string, Set<string>> = {
  js: new Set([
    'console', 'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Date', 'Promise', 'Reflect',
    'Symbol', 'process', 'window', 'document', 'navigator', 'globalThis', 'Buffer', 'Intl', 'Atomics', 'RegExp',
    'WebAssembly', 'localStorage', 'sessionStorage', 'performance', 'crypto', 'URL', 'Error', 'Map', 'Set',
    'BigInt', 'Proxy', 'global', 'self', 'location', 'history', 'fs', 'path', 'os', 'util',
  ]),
  python: new Set(['os', 'sys', 're', 'json', 'math', 'logging', 'time', 'datetime', 'itertools', 'functools', 'str', 'dict', 'list']),
  java: new Set(['System', 'Math', 'String', 'Objects', 'Arrays', 'Collections', 'Integer', 'Long', 'Thread', 'Optional']),
  csharp: new Set([
    'Console', 'Math', 'String', 'Convert', 'Task', 'Enumerable', 'Path', 'File', 'Guid', 'Environment',
    // keyword types: string.IsNullOrEmpty(), int.Parse(), object.ReferenceEquals()
    'string', 'object', 'int', 'long', 'short', 'byte', 'uint', 'ulong', 'double', 'float', 'decimal', 'bool', 'char',
  ]),
  go: new Set(['fmt', 'os', 'strings', 'strconv', 'bytes', 'errors', 'time', 'sync', 'math', 'sort', 'io', 'context']),
  rust: new Set(['std', 'core', 'alloc', 'Vec', 'String', 'Box', 'Arc', 'Rc', 'Option', 'Result', 'HashMap', 'mem', 'ptr', 'fmt']),
  ruby: new Set([
    'Kernel', 'File', 'Dir', 'Time', 'Math', 'JSON', 'String', 'Array', 'Hash', 'Integer', 'Class', 'Module', 'Struct',
    'Object', 'Proc', 'Set', 'Regexp', 'Thread', 'Mutex', 'Process', 'IO', 'ENV', 'Float', 'Symbol', 'Comparable',
  ]),
  php: new Set(['parent']),
};

/** Variable names that say nothing about the type of the object they hold. */
const GENERIC_RECEIVERS = new Set([
  'obj', 'object', 'item', 'instance', 'inst', 'value', 'val', 'data', 'result', 'res', 'ret', 'it', 'el', 'elem',
  'element', 'entry', 'node', 'target', 'source', 'src', 'dst', 'dest', 'other', 'that', 'tmp', 'temp', 'ref',
  'ptr', 'arg', 'args', 'param', 'params', 'input', 'output', 'out', 'key', 'thing', 'current', 'cur', 'next',
  'prev', 'first', 'last', 'left', 'right', 'child', 'parent', 'root', 'base', 'impl', 'delegate', 'inner',
  'outer', 'wrapped',
]);

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * Resolves call sites to definitions. Holds per-request caches (imports of a
 * file, candidate definitions of a name, class ancestry); create a new
 * instance whenever the index changes.
 */
export class Resolver {
  private goPackages: { dirs: Set<string>; prefixes: Set<string>; bySource: Map<string, string | null> } | null = null;
  private goImportCache = new Map<number, Map<string, string | null>>();

  /** Go: project directory an import path names, or null when it is outside the project. */
  private goPackageDir(source: string): string | null {
    let g = this.goPackages;
    if (!g) {
      g = this.goPackages = { dirs: new Set(), prefixes: new Set(), bySource: new Map() };
      for (const f of this.db.all<{ path: string }>(`SELECT path FROM files WHERE lang = 'go'`)) g.dirs.add(dirOf(f.path));
      // The module path is not stored: learn it as the prefix that most imports of project
      // directories share (`github.com/gohugoio/hugo` + `/deps`).
      const counts = new Map<string, number>();
      const sources = this.db.all<{ source: string; n: number }>(
        `SELECT i.source, COUNT(*) AS n FROM imports i JOIN files f ON f.id = i.file_id WHERE f.lang = 'go' GROUP BY i.source`
      );
      for (const s of sources) {
        const parts = s.source.split('/');
        for (let k = 1; k < parts.length; k++) {
          if (g.dirs.has(parts.slice(k).join('/'))) {
            const prefix = parts.slice(0, k).join('/');
            counts.set(prefix, (counts.get(prefix) ?? 0) + s.n);
            break;
          }
        }
      }
      let top = 0;
      for (const n of counts.values()) top = Math.max(top, n);
      // (In a project with only a handful of internal imports a single one has to be enough.)
      const floor = top >= 4 ? Math.max(2, top * 0.05) : 1;
      for (const [prefix, n] of counts) if (n >= floor) g.prefixes.add(prefix);
    }
    let hit = g.bySource.get(source);
    if (hit !== undefined) return hit;
    hit = null;
    if (g.prefixes.has(source) && g.dirs.has('')) hit = '';
    else {
      const parts = source.split('/');
      for (let k = 1; k < parts.length; k++) {
        if (g.prefixes.has(parts.slice(0, k).join('/')) && g.dirs.has(parts.slice(k).join('/'))) {
          hit = parts.slice(k).join('/');
          break;
        }
      }
    }
    g.bySource.set(source, hit);
    return hit;
  }

  /** Go: package names a file imports -> project directory (null = external package). */
  private goImports(fileId: number): Map<string, string | null> {
    let map = this.goImportCache.get(fileId);
    if (!map) {
      map = new Map();
      for (const r of this.db.all<{ source: string; names: string }>(
        `SELECT source, names FROM imports INDEXED BY idx_imports_file WHERE file_id = ?`, fileId
      )) {
        const name = r.names.split(',')[0]?.trim();
        if (name && name !== '_' && name !== '.') map.set(name, this.goPackageDir(r.source));
      }
      this.goImportCache.set(fileId, map);
    }
    return map;
  }

  /**
   * Go: a receiver type written `pkg.Type`. Returns the site with the bare type name and
   * the package directory, or null when the package is not part of this project.
   */
  private goQualified(site: CallSite): CallSite | null {
    const t = site.rtype;
    if (!t || (site.lang !== 'go' && site.lang !== 'rust')) return site;
    const dot = t.indexOf('.');
    if (dot === -1) return site;
    const pkg = t.slice(0, dot);
    const type = t.slice(dot + 1);
    if (site.lang === 'rust') {
      // `std::io::Error`, or `io::Error` after `use std::io;`: a standard-library type, whatever the
      // project calls its own types. Any other module path keeps the old by-name behaviour.
      if (pkg === 'std' || this.stdNames(site.fileId).has(pkg)) return null;
      return { ...site, rtype: type };
    }
    const dir = this.goImports(site.fileId).get(pkg);
    if (dir === null) return null;
    if (dir !== undefined) return { ...site, rtype: type, rtypeDir: dir };
    // Declared in a file with other imports (a field of a struct defined elsewhere): go by the directory name.
    const named = this.db.symbolsByName(type).find(
      s => (CONTAINER_KINDS.has(s.kind) || s.kind === 'type') && s.lang === 'go' && dirOf(s.path).split('/').pop() === pkg
    );
    return named ? { ...site, rtype: type, rtypeDir: dirOf(named.path) } : { ...site, rtype: type };
  }

  private importCache = new Map<number, Set<number>>();
  private importNameCache = new Map<number, ImportedNames>();
  private candidateCache = new Map<string, SymbolRow[]>();
  private ancestorCache = new Map<number, Set<string>>();
  private rubyAncestorCache = new Map<number, Set<string>>();
  private relatedCache = new Map<string, { anc: Set<string>; desc: Set<string> }>();
  private familyCache = new Map<number, Set<number>>();
  private familyCountCache = new Map<string, number>();
  private parentCache = new Map<number, SymbolRow | null>();
  private mentionCache = new Map<string, boolean>();
  private projectTypeCache = new Map<string, boolean>();

  constructor(private readonly db: ClastDb) {}

  /** File ids imported (directly) by a file. */
  importsOf(fileId: number): Set<number> {
    let set = this.importCache.get(fileId);
    if (!set) {
      set = new Set<number>();
      for (const r of this.db.all<{ resolved_id: number | null }>(
        `SELECT resolved_id FROM imports INDEXED BY idx_imports_file WHERE file_id = ?`, fileId
      )) {
        if (r.resolved_id !== null) set.add(r.resolved_id);
      }
      this.importCache.set(fileId, set);
    }
    return set;
  }

  /**
   * True when the name `type`, as seen from the calling file, is a class defined in that file or in
   * the file it is imported from, and `cand` is a member of a same-named class somewhere else.
   */
  private otherTypeInScope(type: string, cand: SymbolRow, site: CallSite): boolean {
    const from = this.importedNames(site.fileId).names.get(type);
    const home = from === undefined ? site.fileId : from;
    if (home === null || home === cand.file_id) return false;
    const types = this.db.symbolsByName(type).filter(s => CONTAINER_KINDS.has(s.kind) || s.kind === 'type');
    if (types.some(s => s.file_id === home)) return true;
    // Java: a type of the same package needs no import and wins over anything else of that name.
    if (from === undefined && (site.lang === 'java' || site.lang === 'php')) {
      const dir = dirOf(site.path);
      return dirOf(cand.path) !== dir && types.some(s => s.lang === site.lang && dirOf(s.path) === dir);
    }
    return false;
  }

  private arityCache = new Map<number, ParamRange | null>();

  /**
   * Can a call with the site's argument count be a call of `sym`? True when either side is
   * unknown. Tells overloads apart and rejects same-named methods with another shape.
   */
  arityFits(sym: SymbolRow, site: CallSite): boolean {
    const argc = site.argc;
    if (argc === undefined || argc === null || argc < 0) return true;
    if (!CALLABLE.has(sym.kind) || sym.kind === 'macro' || !ARITY_LANGS.has(sym.lang)) return true;
    let range = this.arityCache.get(sym.id);
    if (range === undefined) {
      range = paramRange(sym.signature, sym.name, sym.lang);
      if (range && langFamily(sym.lang) === 'c') {
        // C++ default arguments are written on the declaration in the header, not on the definition:
        // `void f(int a, int b = 0);` + `void f(int a, int b) { ... }` accept the same calls.
        for (const id of this.familyOf(sym)) {
          const twin = id === sym.id ? undefined : this.db.symbolById(id);
          if (!twin || twin.qname !== sym.qname || twin.file_id === sym.file_id) continue;
          const other = paramRange(twin.signature, twin.name, twin.lang);
          if (!other) { range = null; break; }
          range = { min: Math.min(range.min, other.min), max: Math.max(range.max, other.max), ext: false };
        }
      }
      this.arityCache.set(sym.id, range);
    }
    if (!range) return true;
    const recv = site.receiver;
    const unbound = !!recv && (/^[A-Z]/.test(recv) || recv.includes('::'));
    return arityFits(range, argc, sym.lang, unbound);
  }

  private filePathCache = new Map<number, string | null>();

  private filePath(fileId: number): string | null {
    let p = this.filePathCache.get(fileId);
    if (p === undefined) {
      p = this.db.get<{ path: string }>(`SELECT path FROM files WHERE id = ?`, fileId)?.path ?? null;
      this.filePathCache.set(fileId, p);
    }
    return p;
  }

  private instanceTypeCache = new Map<string, string | null>();

  /**
   * Type of a module-level variable `name` defined in file `fileId`, read from its declaration:
   * `pre_save = ModelSignal(...)`, `export const logger = new Logger()`, `export const x: Foo = ...`.
   */
  private instanceType(fileId: number, name: string): string | null {
    const key = fileId + ':' + name;
    let t = this.instanceTypeCache.get(key);
    if (t !== undefined) return t;
    t = null;
    const decl = this.db.symbolsByName(name).find(s => s.file_id === fileId && VALUE_KINDS.has(s.kind) && s.qname === s.name);
    if (decl) {
      const sig = decl.signature;
      const m =
        /:\s*([A-Z][\w$]*)\s*(?:<[^=]*>)?\s*=/.exec(sig) ??
        /=\s*(?:new\s+)?(?:[\w$]+\.)*([A-Z][\w$]*)\s*[(<]/.exec(sig);
      if (m && this.isProjectType(m[1]!)) t = m[1]!;
    }
    this.instanceTypeCache.set(key, t);
    return t;
  }

  /** Go: does the file import the package in directory `dir`? */
  private importsGoDir(fileId: number, dir: string): boolean {
    for (const d of this.goImports(fileId).values()) if (d === dir) return true;
    return false;
  }

  /** Names a file imports, mapped to the file they come from (null = not in this project). */
  private importedNames(fileId: number): ImportedNames {
    let entry = this.importNameCache.get(fileId);
    if (!entry) {
      entry = { names: new Map(), wildcards: new Set(), aliases: new Map() };
      for (const r of this.db.all<{ names: string; resolved_id: number | null }>(
        `SELECT names, resolved_id FROM imports INDEXED BY idx_imports_file WHERE file_id = ?`, fileId
      )) {
        if (!r.names) continue;
        for (const raw of r.names.split(',')) {
          if (raw === '*') {
            if (r.resolved_id !== null) entry.wildcards.add(r.resolved_id);
            continue;
          }
          // "alias=original": the file binds `alias`, the definition is called `original`.
          const eq = raw.indexOf('=');
          const n = eq === -1 ? raw : raw.slice(0, eq);
          if (eq !== -1) entry.aliases.set(n, raw.slice(eq + 1));
          if (!entry.names.has(n) || entry.names.get(n) === null) entry.names.set(n, r.resolved_id);
        }
      }
      this.importNameCache.set(fileId, entry);
    }
    return entry;
  }

  private defaultExportCache = new Map<number, string | null>();

  /** Name of the symbol a file exports as its default / `module.exports`, if any. */
  private defaultExportOf(fileId: number): string | null {
    let name = this.defaultExportCache.get(fileId);
    if (name === undefined) {
      name = this.db.get<{ default_export: string | null }>(
        `SELECT default_export FROM files WHERE id = ?`, fileId
      )?.default_export ?? null;
      this.defaultExportCache.set(fileId, name);
    }
    return name;
  }

  /** Can code in `fileId` plausibly refer to `target`: same file, imports its file, or names its class? */
  canSee(fileId: number, target: SymbolRow): boolean {
    const imports = this.importsOf(fileId);
    if (fileId === target.file_id || imports.has(target.file_id)) return true;
    const container = this.containerName(target);
    if (container !== null && !container.startsWith('(') && this.fileMentions(fileId, container)) return true;
    // Through a package that re-exports it: `from django.db import models` -> models.Model in base.py.
    if (imports.size <= 60) {
      for (const f of imports) if (this.importsOf(f).has(target.file_id)) return true;
    }
    return false;
  }

  /**
   * A call at `rawSite` was bound to `bound`, a declaration of the same member on a supertype of
   * `target`'s class. Can it run `target`? Not when the receiver is statically a class unrelated to
   * the target's (a sibling subclass), and not for `super.m()`, which names one implementation.
   */
  reaches(target: SymbolRow, bound: SymbolRow, rawSite: CallSite): boolean {
    const tc = this.containerName(target);
    const bc = this.containerName(bound);
    if (!tc || !bc || tc === bc) return true;
    // Go interfaces are satisfied structurally: there is no declared relation to check against.
    if (target.lang === 'go') return true;
    if (isSuperReceiver(rawSite.receiver, rawSite.lang)) return false;
    const site = this.goQualified(this.withFieldType(rawSite)) ?? rawSite;
    const recv = site.receiver;
    let type: string | null = null;
    if (site.rtype && recv && !SELF_RECEIVERS.has(recv)) type = site.rtype;
    else if (site.caller && ((recv && SELF_RECEIVERS.has(recv)) || (!recv && IMPLICIT_THIS.has(site.lang)))) {
      type = this.enclosingContainer(site.caller)?.name ?? null;
    }
    if (!type || type === tc) return true;
    const rel = this.relatedTo(tc);
    return rel.anc.has(type) || rel.desc.has(type);
  }

  private aliasUseCache = new Map<string, Array<{ fileId: number; alias: string }>>();

  /**
   * Local names under which other files refer to `sym`: import aliases
   * (`import { X as Y }`) and default-import / require bindings of a file
   * whose default export is `sym`.
   */
  aliasesOf(sym: SymbolRow): Array<{ fileId: number; alias: string }> {
    const key = sym.file_id + ':' + sym.name;
    let out = this.aliasUseCache.get(key);
    if (out) return out;
    out = [];
    const isDefault = this.defaultExportOf(sym.file_id) === sym.name;
    const sources = [sym.file_id];
    if (isDefault) {
      // Files that pass the default export on: `module.exports = require('./lib/express')`.
      for (const r of this.db.all<{ id: number }>(
        `SELECT f.id FROM files f JOIN imports i ON i.file_id = f.id
         WHERE f.default_export = '*' AND i.resolved_id = ? LIMIT 20`,
        sym.file_id
      )) {
        sources.push(r.id);
      }
    }
    const rows: Array<{ file_id: number; names: string }> = [];
    for (const source of sources) {
      rows.push(...this.db.all<{ file_id: number; names: string }>(
        `SELECT file_id, names FROM imports INDEXED BY idx_imports_resolved WHERE resolved_id = ? AND names <> ''`,
        source
      ));
    }
    for (const r of rows) {
      const parts = r.names.split(',');
      for (const raw of parts) {
        const eq = raw.indexOf('=');
        if (eq !== -1) {
          if (raw.slice(eq + 1) === sym.name && raw.slice(0, eq) !== sym.name) out.push({ fileId: r.file_id, alias: raw.slice(0, eq) });
        } else if (
          isDefault && parts.length === 1 && raw !== sym.name && raw !== '*' &&
          // A name the file defines or re-exports is a named import of that, not a local name for the default.
          !this.candidates(raw).some(c => c.file_id === sym.file_id || this.importsOf(sym.file_id).has(c.file_id))
        ) {
          // `const express = require('./express')` / `import express from './express'`
          out.push({ fileId: r.file_id, alias: raw });
        }
      }
    }
    // One hop further: files that import the alias from a file that re-exports the symbol under it.
    const seen = new Set(out.map(o => o.fileId + ':' + o.alias));
    for (const via of [...out]) {
      for (const r of this.db.all<{ file_id: number; names: string }>(
        `SELECT file_id, names FROM imports INDEXED BY idx_imports_resolved WHERE resolved_id = ? AND names <> '' LIMIT 2000`,
        via.fileId
      )) {
        for (const raw of r.names.split(',')) {
          const eq = raw.indexOf('=');
          const imported = eq === -1 ? raw : raw.slice(eq + 1);
          if (imported !== via.alias) continue;
          const local = eq === -1 ? raw : raw.slice(0, eq);
          const k = r.file_id + ':' + local;
          if (!seen.has(k)) {
            seen.add(k);
            out.push({ fileId: r.file_id, alias: local });
          }
        }
      }
    }
    this.aliasUseCache.set(key, out);
    return out;
  }

  candidates(name: string): SymbolRow[] {
    let list = this.candidateCache.get(name);
    if (!list) {
      list = this.db.symbolsByName(name).filter(s => CALL_TARGET_KINDS.has(s.kind));
      this.candidateCache.set(name, list);
    }
    return list;
  }

  private parentOf(sym: SymbolRow): SymbolRow | null {
    if (sym.parent_id === null) return null;
    let p = this.parentCache.get(sym.parent_id);
    if (p === undefined) {
      p = this.db.symbolById(sym.parent_id) ?? null;
      this.parentCache.set(sym.parent_id, p);
    }
    return p;
  }

  /** Nearest enclosing class-like symbol of `sym` (lexical), or its container by qualified name. */
  private enclosingContainer(sym: SymbolRow): { name: string; id: number | null } | null {
    const cached = this.containerCache.get(sym.id);
    if (cached !== undefined) return cached;
    const found = this.findEnclosingContainer(sym);
    this.containerCache.set(sym.id, found);
    return found;
  }

  private findEnclosingContainer(sym: SymbolRow): { name: string; id: number | null } | null {
    if (CONTAINER_KINDS.has(sym.kind)) return { name: sym.name, id: sym.id };
    let namespace: { name: string; id: number | null } | null = null;
    let cur: SymbolRow | null = sym;
    for (let i = 0; i < 8 && cur; i++) {
      cur = this.parentOf(cur);
      if (!cur || !CONTAINER_KINDS.has(cur.kind)) continue;
      if (cur.kind !== 'namespace') return { name: cur.name, id: cur.id };
      namespace ??= { name: cur.name, id: cur.id };
    }
    // Go receivers, Rust impl blocks, C++ out-of-line definitions (possibly inside a
    // namespace block): the class is only in the qualified name.
    const name = this.containerName(sym);
    if (name && (!namespace || name !== namespace.name)) return { name, id: null };
    return namespace;
  }

  private stdNameCache = new Map<number, Set<string>>();

  /** Rust: names a file imports from the standard library (`use std::task::{Context, Wake}`). */
  private stdNames(fileId: number): Set<string> {
    let set = this.stdNameCache.get(fileId);
    if (!set) {
      set = new Set<string>();
      for (const r of this.db.all<{ source: string; names: string }>(
        `SELECT source, names FROM imports INDEXED BY idx_imports_file WHERE file_id = ?`, fileId
      )) {
        if (!/^(std|core|alloc)(::|$)/.test(r.source)) continue;
        for (const n of r.names.split(',')) {
          const name = n.trim().split('=')[0]!.trim();
          if (name) set.add(name);
        }
      }
      this.stdNameCache.set(fileId, set);
    }
    return set;
  }

  /**
   * A supertype written in file `fileId` that cannot be a project type even though the project
   * defines one of that name: a Go type of an external package (`io.Closer`), a Rust trait the
   * file imports from the standard library (`use std::task::Wake`).
   */
  externalSupertype(name: string, qualifier: string | null, fileId: number, lang: string): boolean {
    if (lang === 'go') return !!qualifier && this.goImports(fileId).get(qualifier) === null;
    if (lang === 'rust') return !qualifier && this.stdNames(fileId).has(name);
    // JavaScript family: the name is imported from a package that is not part of this repository
    // (`import { Service } from 'cordis'`). A class of that name elsewhere, in a test for instance, is
    // not the base class.
    if (langFamily(lang) === 'js' && !qualifier) {
      for (const r of this.db.all<{ source: string; names: string; resolved_id: number | null }>(
        `SELECT source, names, resolved_id FROM imports INDEXED BY idx_imports_file WHERE file_id = ?`, fileId
      )) {
        if (r.resolved_id !== null || !r.names || /^(\.|\/|@\/|~\/)/.test(r.source)) continue;
        for (const raw of r.names.split(',')) {
          const local = raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : raw;
          if (local === name) return true;
        }
      }
    }
    return false;
  }

  /**
   * Ruby constants are looked up lexically: `Base` written inside `Rails::Generators::NamedBase` is
   * `Rails::Generators::Base`, never `ActiveRecord::Base`, and `Thor::Group` is not some other
   * `Group`. Returns every part of the (possibly reopened) class or module, or nothing when no
   * enclosing scope defines it (a gem).
   */
  private rubyConstant(from: SymbolRow, qualifier: string | null, name: string): SymbolRow[] {
    const cands = this.db.symbolsByName(name).filter(s => CONTAINER_KINDS.has(s.kind) && s.lang === 'ruby');
    if (cands.length === 0) return [];
    const parts = from.qname.split('.');
    const tail = (qualifier ? qualifier.replace(/::/g, '.').replace(/^\./, '') + '.' : '') + name;
    for (let n = parts.length; n >= 0; n--) {
      const want = (n ? parts.slice(0, n).join('.') + '.' : '') + tail;
      const hits = cands.filter(s => s.qname === want && s.id !== from.id);
      if (hits.length) return hits;
    }
    return [];
  }

  /**
   * Qualified names of the Ruby ancestors (superclasses and mixins) of a class or module, found
   * by lexical constant lookup. All parts of a reopened class contribute their own heritage.
   */
  rubyAncestors(containerId: number): Set<string> {
    let set = this.rubyAncestorCache.get(containerId);
    if (set) return set;
    set = new Set<string>();
    const start = this.db.symbolById(containerId);
    let frontier: SymbolRow[] = start
      ? this.db.symbolsByName(start.name).filter(s => s.qname === start.qname && s.lang === 'ruby' && CONTAINER_KINDS.has(s.kind))
      : [];
    for (let depth = 0; depth < 8 && frontier.length; depth++) {
      const next: SymbolRow[] = [];
      for (const sym of frontier) {
        for (const row of this.db.all<{ name: string; qualifier: string | null }>(
          `SELECT name, qualifier FROM heritage WHERE symbol_id = ?`, sym.id
        )) {
          for (const parent of this.rubyConstant(sym, row.qualifier, row.name)) {
            if (parent.qname === start?.qname) continue;
            if (!set.has(parent.qname)) next.push(parent);
          }
        }
      }
      for (const p of next) set.add(p.qname);
      frontier = next.slice(0, 48);
    }
    this.rubyAncestorCache.set(containerId, set);
    return set;
  }

  /** Names of the classes a container extends/implements, transitively (bounded). */
  ancestorsOf(containerId: number): Set<string> {
    let set = this.ancestorCache.get(containerId);
    if (set) return set;
    set = new Set<string>();
    const self = this.db.symbolById(containerId);
    if (self?.lang === 'ruby') {
      // By identity, then reported as names for the callers that compare names.
      for (const q of this.rubyAncestors(containerId)) set.add(q.slice(q.lastIndexOf('.') + 1));
      this.ancestorCache.set(containerId, set);
      return set;
    }
    let frontier = [containerId];
    for (let depth = 0; depth < 5 && frontier.length; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const row of this.db.all<{ name: string; file_id: number; qualifier: string | null; lang: string }>(
          `SELECT h.name, h.file_id, h.qualifier, f.lang FROM heritage h JOIN files f ON f.id = h.file_id WHERE h.symbol_id = ?`, id
        )) {
          if (this.externalSupertype(row.name, row.qualifier, row.file_id, row.lang)) continue;
          // `class A extends Base` where Base is `import { X as Base }`: the supertype is X.
          const h = { name: this.importedNames(row.file_id).aliases.get(row.name) ?? row.name };
          if (set.has(h.name)) continue;
          set.add(h.name);
          for (const parent of this.db.symbolsByName(h.name)) {
            if (CONTAINER_KINDS.has(parent.kind)) next.push(parent.id);
          }
        }
      }
      frontier = next.slice(0, 24);
    }
    this.ancestorCache.set(containerId, set);
    return set;
  }

  /** Ancestor and descendant type names of every container called `name`. */
  relatedTo(name: string): { anc: Set<string>; desc: Set<string> } {
    let rel = this.relatedCache.get(name);
    if (rel) return rel;
    rel = { anc: new Set(), desc: new Set() };
    for (const s of this.db.symbolsByName(name)) {
      if (!CONTAINER_KINDS.has(s.kind)) continue;
      for (const a of this.ancestorsOf(s.id)) rel.anc.add(a);
      // Subtypes that extend this type under an import alias.
      for (const use of this.aliasesOf(s)) {
        for (const row of this.db.all<{ name: string }>(
          `SELECT s.name FROM heritage h JOIN symbols s ON s.id = h.symbol_id WHERE h.name = ? AND h.file_id = ?`,
          use.alias, use.fileId
        )) {
          if (row.name !== name) rel.desc.add(row.name);
        }
      }
    }
    let frontier = [name, ...rel.desc];
    for (let depth = 0; depth < 6 && frontier.length && rel.desc.size < 4000; depth++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const row of this.db.all<{ name: string; file_id: number; qualifier: string | null; lang: string }>(
          `SELECT s.name, h.file_id, h.qualifier, f.lang FROM heritage h JOIN symbols s ON s.id = h.symbol_id
           JOIN files f ON f.id = h.file_id WHERE h.name = ? LIMIT 1000`, n
        )) {
          if (this.externalSupertype(n, row.qualifier, row.file_id, row.lang)) continue;
          if (row.name !== name && !rel.desc.has(row.name)) {
            rel.desc.add(row.name);
            next.push(row.name);
          }
        }
      }
      frontier = next.slice(0, 400);
    }
    this.relatedCache.set(name, rel);
    return rel;
  }

  private containerName(s: SymbolRow): string | null {
    const i = s.qname.lastIndexOf('.');
    if (i === -1) return null;
    const j = s.qname.lastIndexOf('.', i - 1);
    return s.qname.slice(j + 1, i);
  }

  /** Does the file's code mention this identifier at all? */
  private fileMentions(fileId: number, name: string): boolean {
    const key = fileId + ':' + name;
    let hit = this.mentionCache.get(key);
    if (hit === undefined) {
      const nameId = this.db.nameId(name, false);
      hit =
        nameId !== undefined &&
        this.db.get(`SELECT 1 AS x FROM occ WHERE name_id = ? AND file_id = ?`, nameId, fileId) !== undefined;
      this.mentionCache.set(key, hit);
    }
    return hit;
  }

  /** Is `name` a class-like type defined in this project? */
  private isProjectType(name: string): boolean {
    let hit = this.projectTypeCache.get(name);
    if (hit === undefined) {
      hit = this.db.symbolsByName(name).some(s => CONTAINER_KINDS.has(s.kind) || s.kind === 'type');
      this.projectTypeCache.set(name, hit);
    }
    return hit;
  }

  /**
   * Symbols that are "the same target" as `sym` for call-graph purposes:
   * overloads (same qualified name in the same file), C/C++ prototypes and
   * their definitions, and same-named methods in containers related by
   * inheritance (interface method <-> implementation, base <-> override).
   * A call resolved to any member counts for all.
   */
  familyOf(sym: SymbolRow): Set<number> {
    let fam = this.familyCache.get(sym.id);
    if (fam) return fam;
    fam = new Set<number>([sym.id]);
    let same = this.candidates(sym.name);
    const container = this.containerName(sym);
    let related: Set<string> | null = null;
    // Go has no overriding: `Engine.Use` shadows the embedded `RouterGroup.Use`, callers are not shared.
    if (container && same.length > 1 && sym.lang !== 'go') {
      const rel = this.relatedTo(container);
      related = new Set([...rel.anc, ...rel.desc]);
      if (same.length >= 600) {
        // Crowded name (`run`, `get`): look only at same-named members of related types.
        const idx = this.nameIndex(sym.name);
        const narrowed: SymbolRow[] = [...(idx.byFile.get(sym.file_id) ?? [])];
        for (const c of idx.containers) if (related.has(c)) narrowed.push(...(idx.byContainer.get(c) ?? []));
        same = narrowed;
      }
    }
    const cFamily = langFamily(sym.lang) === 'c';
    for (const other of same) {
      if (other.id === sym.id) continue;
      const sameKindOfThing = CALLABLE.has(other.kind) === CALLABLE.has(sym.kind);
      if (
        other.qname === sym.qname && sameKindOfThing &&
        (other.file_id === sym.file_id || (cFamily && CALLABLE.has(sym.kind) && cTwins(sym, other)))
      ) {
        // Overloads; in C/C++ also the header declaration of a definition.
        fam.add(other.id);
      } else if (related && (other.kind === 'method' || other.kind === sym.kind)) {
        const oc = this.containerName(other);
        if (!oc || !related.has(oc)) continue;
        if (oc === container && other.file_id !== sym.file_id) {
          // Two types with the same short name (Cache\Repository and Config\Repository, both implementing
          // a contract called Repository) are related only if one of them is that interface.
          const po = this.parentOf(other);
          const ps = this.parentOf(sym);
          // (Methods written outside the type body - Rust impl blocks, Go receivers - have no parent symbol:
          // the same method name on a same-named type in another file is then simply another type.)
          if (!po || !ps) continue;
          if (po.kind !== 'interface' && ps.kind !== 'interface' && po.kind !== 'trait' && ps.kind !== 'trait') continue;
          // ... and, where files import what they use, only if one of the two files imports the other
          // (`use Contracts\Events\Dispatcher as DispatcherContract`): Bus\Dispatcher is someone else's contract.
          if (
            SINGLE_FILE_CLASS.has(langFamily(sym.lang)) &&
            !this.importsOf(sym.file_id).has(other.file_id) && !this.importsOf(other.file_id).has(sym.file_id)
          ) continue;
        }
        fam.add(other.id);
      }
    }
    // The native bridge: a Kotlin `external fun` / Java `native` method and the C or C++ function of
    // the same name are one function written in two languages (JNI). Calls of either reach the other.
    const bridge = (s: SymbolRow): boolean =>
      (s.lang === 'kotlin' || s.lang === 'java') && /\bexternal\s+fun\b|\bnative\b/.test(s.signature);
    const native = (s: SymbolRow): boolean => langFamily(s.lang) === 'c' && (s.kind === 'function' || s.kind === 'declaration');
    if (bridge(sym) || native(sym)) {
      const other = bridge(sym) ? native : bridge;
      for (const twin of this.candidates(sym.name)) if (twin.id !== sym.id && other(twin)) fam.add(twin.id);
    }
    this.familyCache.set(sym.id, fam);
    return fam;
  }

  /**
   * True when `other` overrides `target` in a subtype and `target` has a body of its own:
   * a call bound to the override never runs `target` (the reverse is not true: a call bound
   * to the base method may dispatch to the override).
   */
  overriddenBelow(target: SymbolRow, other: SymbolRow): boolean {
    if (other.id === target.id || other.qname === target.qname) return false;
    const tc = this.containerName(target);
    const oc = this.containerName(other);
    if (!tc || !oc || tc === oc) return false;
    const parent = this.parentOf(target);
    if (!parent || (parent.kind !== 'class' && parent.kind !== 'struct')) return false;
    if (target.kind === 'declaration' || /\babstract\b/.test(target.signature)) return false;
    const rel = this.relatedTo(tc);
    return rel.desc.has(oc) && !rel.anc.has(oc);
  }

  /** How many genuinely different definitions (families) share this name. */
  private familyCount(name: string): number {
    let n = this.familyCountCache.get(name);
    if (n !== undefined) return n;
    const cands = this.candidates(name);
    if (cands.length > 60) {
      n = cands.length; // too many to group; certainly not distinctive
    } else {
      const seen = new Set<number>();
      n = 0;
      for (const c of cands) {
        if (seen.has(c.id)) continue;
        n++;
        for (const id of this.familyOf(c)) seen.add(id);
      }
    }
    this.familyCountCache.set(name, n);
    return n;
  }

  /**
   * Evidence that a member call on a receiver of unknown type targets `cand`
   * (a method of `container`). Zero evidence means "not linked".
   */
  private memberEvidence(
    name: string, cand: SymbolRow, container: string | null, site: CallSite, recv: string | null, lenient = false
  ): number {
    let e = 0;
    if (cand.file_id === site.fileId) e += 24;
    else if (this.importsOf(site.fileId).has(cand.file_id)) e += 22;
    else if (dirOf(cand.path) === dirOf(site.path)) e += site.lang === 'go' || site.lang === 'java' ? 15 : 8;
    if (container && cand.file_id !== site.fileId && this.fileMentions(site.fileId, container)) e += 18;
    let receiverMatches = false;
    if (recv && container && !GENERIC_RECEIVERS.has(recv.toLowerCase())) {
      if (looselyNamed(recv, container)) {
        e += 30;
        receiverMatches = true;
      } else if (recv.length <= 2 && container.toLowerCase().startsWith(recv.toLowerCase())) {
        // Go convention: `s` for *Site, `c` for *Context, `rg` ... Within a package this is good evidence.
        e += 8;
        receiverMatches = site.lang === 'go' && dirOf(cand.path) === dirOf(site.path);
      } else {
        // `@cache.fetch_multi` -> Cache::Store#fetch_multi: the receiver names the enclosing namespace.
        const q = cand.qname.split('.');
        const outer = q.length >= 3 ? q[q.length - 3]! : null;
        if (outer && outer.length >= 4 && looselyNamed(recv, outer)) {
          e += 22;
          receiverMatches = true;
        }
      }
    }
    if (COMMON_MEMBER_NAMES.has(name.toLowerCase())) {
      // .get(), .add(), .count(): only the receiver's name can tell a project method from a builtin.
      return receiverMatches || lenient ? e : 0;
    }
    // `connection_handler.establish_connection`: the receiver names ConnectionHandler, so a same-named
    // method on some other class (even the caller's own) is not the target.
    if (!receiverMatches && recv && !GENERIC_RECEIVERS.has(recv.toLowerCase()) && this.receiverNamesOther(name, recv, container)) {
      return 0;
    }
    if (this.familyCount(name) === 1) {
      // Defined once in the whole project. A multi-word name (`complete_inflight`, `pollElapsed`)
      // is then almost certainly this method; a single word (`changed`, `close`) may be a library's.
      e += splitIdentifier(name).length >= 2 && name.length >= 8 ? 46 : 20;
    } else if (e === 0 && recv && splitIdentifier(name).length >= 2 && name.length >= 8 && this.familyCount(name) <= 3) {
      // A distinctive name with two or three definitions and no other clue (`@cache.fetch_multi` in a
      // test): still worth listing as a name-only candidate rather than hiding the call site.
      e += 16;
    }
    return e;
  }

  private receiverOtherCache = new Map<string, Set<string>>();

  /** Does the receiver's name match the class of a different definition of `name`? */
  private receiverNamesOther(name: string, recv: string, container: string | null): boolean {
    const key = name + '\0' + recv;
    let matches = this.receiverOtherCache.get(key);
    if (!matches) {
      matches = new Set<string>();
      const cands = this.candidates(name);
      if (cands.length <= 400) {
        for (const c of cands) {
          const cn = this.containerName(c);
          if (cn && looselyNamed(recv, cn)) matches.add(cn);
        }
      }
      this.receiverOtherCache.set(key, matches);
    }
    return matches.size > 0 && (container === null || !matches.has(container));
  }

  /** Score how plausible it is that a call at `site` targets `cand`; null = impossible. */
  private score(name: string, cand: SymbolRow, site: CallSite): number | null {
    const fam = langFamily(site.lang);
    if (langFamily(cand.lang) !== fam) return null;
    if (site.lang === 'c' && !C_CALLABLE.has(cand.kind)) return null;

    // Production code does not call into tests, fixtures or examples.
    if (isTestPath(cand.path) && !isTestPath(site.path)) return null;
    // ... nor into vendored / third-party trees it does not import.
    if (
      isVendoredPath(cand.path) && !isVendoredPath(site.path) && cand.file_id !== site.fileId &&
      !this.importsOf(site.fileId).has(cand.file_id) &&
      !(site.lang === 'go' && (dirOf(cand.path) === dirOf(site.path) || this.importsGoDir(site.fileId, dirOf(cand.path))))
    ) {
      return null;
    }

    const sameFile = cand.file_id === site.fileId;
    const parent = this.parentOf(cand);

    // Functions nested in a function are visible only inside it.
    if (parent && (parent.kind === 'function' || parent.kind === 'method')) {
      if (!sameFile || !site.caller) return null;
      const q = site.caller.qname;
      if (q !== parent.qname && !q.startsWith(parent.qname + '.')) return null;
    }

    // A type nested inside a class is visible by its bare name only within that class.
    if (
      !site.receiver && parent && TYPE_KINDS.has(cand.kind) &&
      CONTAINER_KINDS.has(parent.kind) && parent.kind !== 'namespace'
    ) {
      const q = site.caller?.qname ?? '';
      if (!sameFile || !(q === parent.qname || q.startsWith(parent.qname + '.'))) return null;
    }

    const container = this.containerName(cand);
    const inContainer = parent !== null && CONTAINER_KINDS.has(parent.kind);
    // A function directly inside a C++ namespace is a free function: callable by its bare name from any
    // code that includes it, whatever class the caller belongs to.
    const nsFunction = fam === 'c' && parent !== null && parent.kind === 'namespace' && cand.kind !== 'method';
    const isMember =
      !nsFunction &&
      (cand.kind === 'method' ||
        (inContainer && (cand.kind === 'function' || cand.kind === 'declaration' || VALUE_KINDS.has(cand.kind))));
    // The number of arguments rules the definition out (another overload, or an unrelated method of that name).
    if (site.argc !== undefined && site.argc !== null && site.argc >= 0 && !this.arityFits(cand, site)) return null;
    // C: a static function is callable only inside its own file (or a file that includes it).
    if (fam === 'c' && !sameFile && isFileLocal(cand) && !this.importsOf(site.fileId).has(cand.file_id)) return null;
    // A module-level variable is only callable by its bare name; never through an object.
    if (VALUE_KINDS.has(cand.kind) && !inContainer && site.receiver) return null;
    // A field is only callable when it holds a function: `s.Conf.Watching()` is not the bool field `Watching`.
    if (VALUE_KINDS.has(cand.kind) && inContainer) {
      if (cand.lang === 'java') return null;
      if (cand.lang === 'go' && !cand.signature.includes('func')) return null;
      if (cand.lang === 'rust' && !/\bfn\b|\bFn(Mut|Once)?\b/.test(cand.signature)) return null;
    }
    const callerC = site.caller ? this.enclosingContainer(site.caller) : null;
    let tie = this.tieCache.get(cand.id);
    if (tie === undefined) {
      tie = definitionScore(cand) * 0.5;
      this.tieCache.set(cand.id, tie);
    }
    const recv = site.receiver;

    // The caller's own class. Where classes cannot be split over files, a class of the same name
    // in another file (one `DatabaseSchemaEditor` per backend) is a different class.
    // Ruby: classes are open (many files) but identified by their full name. `Base` is a different
    // class in every namespace, so the caller's class and its ancestors are compared by qualified name.
    const rubyCallerQ =
      site.lang === 'ruby' && callerC !== null && callerC.id !== null && parent !== null && CONTAINER_KINDS.has(parent.kind)
        ? this.db.symbolById(callerC.id)?.qname ?? null
        : null;
    const inCallerClass =
      rubyCallerQ !== null
        ? isMember && parent!.qname === rubyCallerQ
        : isMember && callerC !== null && container === callerC.name &&
          (!SINGLE_FILE_CLASS.has(fam) || sameFile || callerC.id === null || parent === null ||
            !CONTAINER_KINDS.has(parent.kind) || parent.id === callerC.id);
    const inCallerAncestors = (): boolean =>
      rubyCallerQ !== null
        ? isMember && this.rubyAncestors(callerC!.id!).has(parent!.qname)
        : isMember && callerC !== null && container !== null &&
          (callerC.id !== null ? this.ancestorsOf(callerC.id).has(container) : this.relatedTo(callerC.name).anc.has(container));

    // --- typed receiver: x.foo() where x: T ------------------------------------
    if (site.rtype && recv && !SELF_RECEIVERS.has(recv)) {
      const T = site.rtype;
      if (isMember && container) {
        const vis = this.typeVisibility(T, cand, site);
        if (container === T) {
          // Go `pkg.Type`: methods live in the package that defines the type.
          if (site.rtypeDir !== undefined && dirOf(cand.path) !== site.rtypeDir) return null;
          // The calling file imports (or defines) its own type T: a same-named class elsewhere is not it.
          if (SINGLE_FILE_CLASS.has(fam) && !sameFile && this.otherTypeInScope(T, cand, site)) return null;
          return 100 + vis + tie;
        }
        const rel = this.relatedTo(T);
        if (rel.anc.has(container)) return 86 + vis + tie; // inherited from a supertype
        if (rel.desc.has(container)) {
          // An override in a subtype. When T itself is a library type (TextWriter, Stream) nearly all
          // calls on it go elsewhere: keep the project override as a possibility, never as a fact.
          return this.isProjectType(T) ? 72 + vis + tie : Math.min(48, 40 + vis + tie);
        }
      }
      // Not a member of T or its relatives. Only languages with extension
      // methods / open classes can still reach an unrelated definition.
      if (!OPEN_TYPES.has(site.lang)) return null;
      if (!isMember) return null;
      const e = this.memberEvidence(name, cand, container, site, null);
      // An extension method with a distinctive name that the project defines once (`app.UseRouting()`).
      const unique = e >= 46 && splitIdentifier(name).length >= 2 && name.length >= 8 && this.familyCount(name) === 1;
      return e >= 30 ? Math.min(unique ? 60 : 50, 10 + e) + tie : null;
    }

    // --- bare call: foo() ---------------------------------------------------
    if (!recv) {
      if (isMember) {
        // Python / JS: a bare name never reaches a method (it needs self. / this.).
        if (STRICT_IMPORTS.has(fam)) return null;
        if (inCallerClass) return (sameFile ? 88 : 72) + tie; // implicit this / same (partial) class
        if (inCallerAncestors()) return 68 + tie;
        if (site.lang === 'java' && container !== name) {
          // `import static pkg.Utils.mkEntry;` / `import static pkg.Utils.*;`
          // (Not constructors: `import pkg.TopicPartition` + `new TopicPartition()` names the class.)
          const imp = this.importedNames(site.fileId);
          if (imp.names.get(name) === cand.file_id) return 94 + tie;
          if (imp.wildcards.has(cand.file_id)) return 58 + tie;
        }
        if (site.lang === 'go' || site.lang === 'rust') return null;
        if (site.lang === 'ruby' || site.lang === 'php') {
          const e = this.memberEvidence(name, cand, container, site, null);
          return e >= 20 ? Math.min(48, 10 + e) + tie : null;
        }
        // Java / C# / C++: an outer class's method or a static import.
        return sameFile ? 40 + tie : null;
      }
      const imported = this.importedNames(site.fileId);
      const from = imported.names.get(name);
      if (sameFile) return 82 + tie;
      if (from !== undefined && from !== null) {
        if (from === cand.file_id) return 96 + tie;
        if (this.importsOf(from).has(cand.file_id)) return 62 + tie; // re-exported one hop away
        return null; // the name is imported from somewhere else
      }
      if (STRICT_IMPORTS.has(fam)) {
        if (imported.wildcards.has(cand.file_id)) return 58 + tie;
        if (this.importsOf(site.fileId).has(cand.file_id)) return 46 + tie; // default / destructured import
        // Classic script files share one global scope.
        if (site.lang === 'javascript' && this.importsOf(site.fileId).size === 0 && imported.names.size === 0) {
          return dirOf(cand.path) === dirOf(site.path) ? 44 + tie : null;
        }
        return null;
      }
      if (site.lang === 'go') return dirOf(cand.path) === dirOf(site.path) ? 78 + tie : null;
      // Same enclosing namespace / module as the caller (Ruby modules, C++ / C# namespaces, Rust mods).
      const ns = site.caller ? namespaceAffinity(site.caller.qname, cand.qname) : 0;
      if (this.importsOf(site.fileId).has(cand.file_id)) return 64 + ns + tie;
      if (fam === 'c') {
        // Headers include headers: one transitive hop still counts as "included".
        for (const f of this.importsOf(site.fileId)) {
          if (this.importsOf(f).has(cand.file_id)) return 56 + tie;
        }
      }
      const a = cand.path.split('/');
      const b = site.path.split('/');
      let common = 0;
      while (common < a.length - 1 && common < b.length - 1 && a[common] === b[common]) common++;
      if (common === a.length - 1 && common === b.length - 1) {
        // Same directory. In package-per-directory languages that is the same package: no import needed.
        return (SAME_DIR_PACKAGE.has(site.lang) ? 66 : 46) + ns + tie;
      }
      return 18 + Math.min(12, common * 3) + ns * 2 + tie;
    }

    // --- super.foo() / base.Foo() / parent::foo() ----------------------------------
    if (isSuperReceiver(recv, site.lang)) {
      if (!isMember || (callerC !== null && container === callerC.name)) return null;
      // (Which class of that name: the one the subclass's file imports, when there are copies.)
      if (inCallerAncestors()) return 92 + (container ? this.typeVisibility(container, cand, site) : 0) + tie;
      // A mixin calls up the MRO of whatever class it is mixed into (`super().dispatch()` in a
      // Django mixin): the parent is not declared here, so any other definition is a candidate.
      // (Only where a method resolution order exists: in JS / PHP / Java `super` is the declared parent.)
      if (fam !== 'python' && fam !== 'ruby') return null;
      if (callerC && container && this.relatedTo(callerC.name).desc.has(container)) return null;
      return 34 + tie;
    }

    // --- this.foo() / self.foo() ---------------------------------------------
    if (SELF_RECEIVERS.has(recv)) {
      if (!isMember) {
        // JS object-literal style: `this.helper()` where helper is a function in the same file.
        return fam === 'js' && sameFile && cand.kind === 'function' ? 36 + tie : null;
      }
      if (inCallerClass) return (sameFile ? 96 : 80) + tie;
      if (inCallerAncestors()) return 76 + (container ? this.typeVisibility(container, cand, site) : 0) + tie;
      // `function View() { this.lookup() }` with `View.prototype.lookup = ...` in the same file.
      if (!callerC && site.caller && container === site.caller.name && sameFile) return 90 + tie;
      if (callerC && container && this.relatedTo(callerC.name).desc.has(container)) return 56 + tie; // abstract hook
      // Inside a trait / mixin, `$this->save()` is a method of whatever class uses it: even a
      // common name is then worth a (name-only) candidate.
      const host = callerC && callerC.id !== null ? this.db.symbolById(callerC.id) : undefined;
      const mixin = !!host && (host.kind === 'trait' || (host.lang === 'ruby' && host.kind === 'namespace') || /Mixin$/.test(host.name));
      const e = this.memberEvidence(name, cand, container, site, null, mixin);
      return e >= (mixin ? 8 : 20) ? Math.min(46, 10 + e) + tie : null; // mixin-style
    }

    // --- expression receiver: a.b().foo(), "x".foo() --------------------------
    if (recv === '?') {
      if (!isMember) return null;
      const e = this.memberEvidence(name, cand, container, site, null);
      // Nothing is known about the receiver: with several definitions of the name, being in the same
      // file (or imported) makes one of them likely, not certain.
      const cap = this.familyCount(name) === 1 ? 90 : 50;
      return e >= 15 ? Math.min(cap, 10 + e) + tie : null;
    }

    // --- named receiver: obj.foo(), Foo.bar(), pkg.Func(), ns::func() ---------
    const bare = recv.replace(/^[$@&*]+/, '');
    const last = bare.split(/\.|::|->|\\/).pop() ?? bare;
    const first = bare.split(/\.|::|->|\\/)[0] ?? bare;
    // console.log(), Math.max(), os.path.join(): runtime globals and external modules.
    if (BUILTIN_RECEIVERS[fam]?.has(first) && !this.isProjectType(first)) return null;
    const names = this.importedNames(site.fileId).names;
    if (EXTERNAL_IF_UNRESOLVED.has(fam) && names.get(first) === null) return null;
    if (site.lang === 'go') {
      // `pkg.Func()`, `pkg.Type{}`: the receiver is an imported package, which is a directory.
      const dir = this.goImports(site.fileId).get(first);
      if (dir === null) return null; // a package outside the project
      if (dir !== undefined) {
        if (dirOf(cand.path) !== dir) return null;
        if (bare === first) return isMember ? null : 94 + tie;
      }
    }
    if (container && (last === container || bare === container)) {
      // `Assert.Equal()` written without an outer class does not mean a class `Assert` nested inside
      // some other class (`Http2Utilities.Assert`), unless the call is made from inside that class.
      if (bare === container && parent) {
        const outer = this.parentOf(parent);
        if (outer && CONTAINER_KINDS.has(outer.kind) && outer.kind !== 'namespace') {
          const q = site.caller?.qname ?? '';
          // Inside the outer class the nested one is the nearest of that name: it shadows any other.
          if (q === outer.qname || q.startsWith(outer.qname + '.')) return 106 + tie;
          // (`import pkg.Outer.Inner;` makes the nested class nameable on its own.)
          if (!sameFile && names.get(container) !== cand.file_id) return null;
        }
      }
      return 92 + this.typeVisibility(container, cand, site) + tie; // static / qualified call
    }
    if (isMember) {
      // Static / class-level call through a subclass: Sub.inheritedMethod().
      if (container && /^[A-Z]/.test(last) && this.isProjectType(last) && this.relatedTo(last).anc.has(container)) {
        return 84 + tie;
      }
      const e = this.memberEvidence(name, cand, container, site, last);
      return e >= 15 ? 10 + e + tie : null;
    }
    // Rust macros are addressed through a crate / module path: tokio::select!, crate::cfg_rt!.
    if (cand.kind === 'macro' && site.lang === 'rust') return 70 + tie;
    const from = names.get(last);
    if (from !== undefined && from !== null) {
      if (from === cand.file_id) return 94 + tie; // import * as ns / import module
      // Python `from django.utils import text`: the name is a submodule of the imported package.
      if (fam === 'python') {
        const pkg = this.filePath(from);
        if (pkg && /(^|\/)__init__\.py$/.test(pkg) && cand.path === dirOf(pkg) + '/' + last + '.py') return 92 + tie;
      }
      // The namespace is a package whose __init__ / index re-exports the definition.
      return this.importsOf(from).has(cand.file_id) ? 72 + tie : null;
    }
    if (moduleLike(last, cand.path)) return (this.importsOf(site.fileId).has(cand.file_id) ? 86 : 74) + tie;
    return null;
  }

  /**
   * Small bonus for the definition of type `typeName` that the calling file
   * can actually see (same file, imported by name, or nearest in the tree).
   * Decides between identical copies of a class (vendored forks, monorepo
   * packages).
   */
  private typeVisibility(typeName: string, cand: SymbolRow, site: CallSite): number {
    if (cand.file_id === site.fileId) return 8;
    const from = this.importedNames(site.fileId).names.get(typeName);
    if (from === cand.file_id) return 8;
    if (this.importsOf(site.fileId).has(cand.file_id)) return 6;
    if (from !== undefined && from !== null && this.importsOf(from).has(cand.file_id)) return 5;
    const a = cand.path.split('/');
    const b = site.path.split('/');
    let common = 0;
    while (common < a.length - 1 && common < b.length - 1 && a[common] === b[common]) common++;
    return Math.min(4, common);
  }

  private fieldTypeCache = new Map<string, string | null>();

  /** Declared type of `container.field` (also looking at supertypes), or null if unknown / ambiguous. */
  private fieldType(container: string, field: string): string | null {
    // Go field types may be written `pkg.Type`.
    const dot = container.lastIndexOf('.');
    if (dot !== -1) container = container.slice(dot + 1);
    const key = container + '.' + field;
    let t = this.fieldTypeCache.get(key);
    if (t !== undefined) return t;
    t = null;
    const owners = [container, ...[...this.relatedTo(container).anc].slice(0, 8)];
    for (const owner of owners) {
      const rows = this.db.all<{ type: string }>(
        `SELECT DISTINCT type FROM field_types WHERE container = ? AND field = ? LIMIT 3`, owner, field
      );
      if (rows.length === 1) { t = rows[0]!.type; break; }
      if (rows.length > 1) break; // same class name with different field types: do not guess
    }
    if (t === null) {
      // A getter / property with a declared type reads like a field: `get grid(): Grid`, `@property def conn(self) -> Connection`.
      for (const owner of owners) {
        const getters = this.db.symbolsByName(field).filter(
          s =>
            s.ret && this.containerName(s) === owner &&
            (s.kind === 'property' || /^(?:[\w@.()]+\s+)*get\s/.test(s.signature) || /^@(?:cached_)?property\b/.test(s.signature))
        );
        if (getters.length === 0) continue;
        const types = new Set(getters.map(g => g.ret));
        if (types.size === 1) t = getters[0]!.ret;
        break;
      }
    }
    this.fieldTypeCache.set(key, t);
    return t;
  }

  /**
   * Fill in the receiver type from class field declarations when the
   * extractor could not (the class is declared in another file: C++ headers,
   * partial classes, Go structs elsewhere in the package).
   */
  private withFieldType(site: CallSite, depth = 0): CallSite {
    if (site.rtype && site.rtype.includes('#')) {
      // Deferred by the extractor: the declared type of field `f` of type `T` ("T#f"), defined in another file.
      const cut = site.rtype.indexOf('#');
      const t = this.fieldType(site.rtype.slice(0, cut), site.rtype.slice(cut + 1));
      site = { ...site, rtype: t };
    }
    if (site.rtype) {
      // The declared type may be written with an import alias (`const q: JobQueue`).
      const original = this.importedNames(site.fileId).aliases.get(site.rtype);
      return original ? { ...site, rtype: original } : site;
    }
    const r = site.receiver;
    if (r && site.via) {
      // The receiver is produced by another call (a chain link, or a variable initialised from a call).
      const t = this.chainType(site, depth);
      if (t) return { ...site, rtype: t };
      if (r === '?') return site;
    }
    // An imported module-level instance: `from signals import pre_save` ... `pre_save.send()`.
    if (r && /^[A-Za-z_$][\w$]*$/.test(r) && !SELF_RECEIVERS.has(r)) {
      const from = this.importedNames(site.fileId).names.get(r);
      if (from !== undefined && from !== null) {
        const original = this.importedNames(site.fileId).aliases.get(r) ?? r;
        const t = this.instanceType(from, original);
        if (t) return { ...site, rtype: t };
      }
    }
    if (!r || r === '?' || !site.caller) return site;
    let field: string | null = null;
    const m = /^(?:this|self|\$this|base|Self)(?:\.|->|::)([A-Za-z_]\w*)$/.exec(r) ?? /^@([A-Za-z_]\w*)$/.exec(r);
    if (m) field = m[1]!;
    else {
      // self.shared.inject.push(): follow the declared type of each field in turn.
      const deep = /^(?:this|self|\$this)((?:(?:\.|->)[A-Za-z_]\w*){2,4})$/.exec(r);
      if (deep) {
        const container = this.enclosingContainer(site.caller);
        let type: string | null = container ? container.name : null;
        for (const f of deep[1]!.split(/\.|->/).filter(Boolean)) {
          type = type ? this.fieldType(type, f) : null;
          if (!type) break;
        }
        return type ? { ...site, rtype: type } : site;
      }
      if (IMPLICIT_THIS.has(site.lang) && /^[A-Za-z_]\w*$/.test(r) && !SELF_RECEIVERS.has(r)) field = r;
    }
    if (!field) return site;
    const container = this.enclosingContainer(site.caller);
    if (!container) return site;
    const t = this.fieldType(container.name, field);
    return t ? { ...site, rtype: t } : site;
  }

  private nameIndexCache = new Map<string, NameIndex>();
  private tieCache = new Map<number, number>();
  private containerCache = new Map<number, { name: string; id: number | null } | null>();

  /** Candidates of a name grouped for fast pre-selection (only built for crowded names). */
  private nameIndex(name: string): NameIndex {
    let idx = this.nameIndexCache.get(name);
    if (idx) return idx;
    const all = this.candidates(name);
    idx = { all, byContainer: new Map(), byFile: new Map(), free: [], containers: [], byReceiver: new Map() };
    for (const c of all) {
      const f = idx.byFile.get(c.file_id);
      if (f) f.push(c);
      else idx.byFile.set(c.file_id, [c]);
      const parent = this.parentOf(c);
      const inContainer = parent !== null && CONTAINER_KINDS.has(parent.kind);
      const nsFunction = langFamily(c.lang) === 'c' && parent !== null && parent.kind === 'namespace' && c.kind !== 'method';
      const isMember = !nsFunction && (c.kind === 'method' || (inContainer && c.kind !== 'class' && c.kind !== 'struct' && c.kind !== 'interface'));
      const container = isMember ? this.containerName(c) : null;
      if (container) {
        const list = idx.byContainer.get(container);
        if (list) list.push(c);
        else idx.byContainer.set(container, [c]);
      } else {
        idx.free.push(c);
      }
    }
    idx.containers = [...idx.byContainer.keys()];
    this.nameIndexCache.set(name, idx);
    return idx;
  }

  /**
   * Candidates that can possibly score for this call site. Purely an
   * optimisation for names with hundreds of definitions (`run`, `add`,
   * `get`): it must return a superset of what score() accepts.
   */
  private preselect(name: string, site: CallSite): SymbolRow[] {
    const idx = this.nameIndex(name);
    const recv = site.receiver;
    const fam = langFamily(site.lang);
    const common = COMMON_MEMBER_NAMES.has(name.toLowerCase());
    const out = new Set<SymbolRow>();
    const add = (list: SymbolRow[] | undefined): void => {
      if (list) for (const s of list) out.add(s);
    };
    const addRelated = (type: string): void => {
      add(idx.byContainer.get(type));
      const rel = this.relatedTo(type);
      for (const a of rel.anc) add(idx.byContainer.get(a));
      // The type (or a supertype) declares the member: overrides further down are the same
      // family and always score lower, so a hub interface (`IDisposable.dispose` with thousands
      // of implementers) does not need them scored at every call site.
      if (out.size > 0 && rel.desc.size > 50) return;
      if (rel.desc.size < idx.containers.length) {
        for (const d of rel.desc) add(idx.byContainer.get(d));
      } else {
        for (const c of idx.containers) if (rel.desc.has(c)) add(idx.byContainer.get(c));
      }
    };
    const callerC = site.caller ? this.enclosingContainer(site.caller) : null;

    if (site.rtype && recv && !SELF_RECEIVERS.has(recv)) {
      addRelated(site.rtype);
      return out.size === 0 && OPEN_TYPES.has(site.lang) ? idx.all : [...out];
    }
    if (!recv) {
      if (callerC) addRelated(callerC.name);
      add(idx.byFile.get(site.fileId));
      const imported = this.importedNames(site.fileId);
      const from = imported.names.get(name);
      if (from !== undefined && from !== null) {
        add(idx.byFile.get(from));
        for (const f of this.importsOf(from)) add(idx.byFile.get(f));
      }
      if (STRICT_IMPORTS.has(fam)) {
        const imports = this.importsOf(site.fileId);
        if (site.lang === 'javascript' && imports.size === 0 && imported.names.size === 0) return idx.all;
        for (const f of imported.wildcards) add(idx.byFile.get(f));
        for (const f of imports) add(idx.byFile.get(f));
        return [...out];
      }
      if (site.lang === 'go') {
        const dir = dirOf(site.path);
        for (const s of idx.free) if (dirOf(s.path) === dir) out.add(s);
        return [...out];
      }
      if (!common && (site.lang === 'ruby' || site.lang === 'php')) return idx.all;
      add(idx.free);
      return [...out];
    }
    if (SELF_RECEIVERS.has(recv)) {
      if (!common) return idx.all;
      if (callerC) addRelated(callerC.name);
      add(idx.byFile.get(site.fileId));
      return [...out];
    }
    if (recv === '?') return common ? [] : idx.all;
    if (!common) return idx.all;

    // Named receiver + common method name: only the receiver's name can link it.
    const bare = recv.replace(/^[$@&*]+/, '');
    const last = bare.split(/\.|::|->|\\/).pop() ?? bare;
    const lastLc = last.toLowerCase();
    const generic = GENERIC_RECEIVERS.has(lastLc);
    const typeAncestors = /^[A-Z]/.test(last) && this.isProjectType(last) ? this.relatedTo(last).anc : null;
    // The same receiver names recur at thousands of sites: match them against the containers once.
    const key = bare + '\0' + last;
    let matched = idx.byReceiver.get(key);
    if (!matched) {
      matched = [];
      for (const c of idx.containers) {
        if (
          c === last || bare === c ||
          (typeAncestors !== null && typeAncestors.has(c)) ||
          (!generic && (looselyNamed(last, c) || (last.length <= 2 && c.toLowerCase().startsWith(lastLc))))
        ) {
          matched.push(...(idx.byContainer.get(c) ?? []));
        }
      }
      matched.push(...idx.free);
      idx.byReceiver.set(key, matched);
    }
    return matched;
  }

  /**
   * True when a member call's receiver gives no usable type information: an
   * expression (`a.b().foo()`) or an untyped variable that is neither
   * this/self, a runtime global, nor an external module. Such call sites
   * cannot be attributed to any one definition of a common method name.
   */
  isOpaqueReceiver(rawSite: CallSite): boolean {
    const site = this.withFieldType(rawSite);
    const recv = site.receiver;
    if (!recv || site.rtype || SELF_RECEIVERS.has(recv)) return false;
    if (recv === '?') return true;
    const fam = langFamily(site.lang);
    const first = recv.replace(/^[$@&*]+/, '').split(/\.|::|->|\\/)[0] ?? recv;
    if (BUILTIN_RECEIVERS[fam]?.has(first) && !this.isProjectType(first)) return false;
    if (EXTERNAL_IF_UNRESOLVED.has(fam) && this.importedNames(site.fileId).names.get(first) === null) return false;
    // A capitalised receiver is a type (static call): a project type is handled by the
    // resolver, anything else is an external class. Neither is "unknown".
    if (/^[A-Z]/.test(first) && !first.includes('_')) return false;
    return true;
  }

  private chainTypeCache = new Map<number, string | null>();

  /**
   * Type of an expression receiver that is itself a call: the return type of
   * that call's target (or the class, for constructor calls). Follows up to
   * four links of a chain.
   */
  private chainType(site: CallSite, depth: number): string | null {
    const via = site.via;
    if (!via || depth > 4) return null;
    const cached = this.chainTypeCache.get(via);
    if (cached !== undefined) return cached;
    this.chainTypeCache.set(via, null); // guards against cycles
    const row = this.db.get<{ name: string; receiver: string | null; rtype: string | null; via: number | null }>(
      `SELECT n.name, c.receiver, c.rtype, c.via FROM calls c JOIN names n ON n.id = c.name_id WHERE c.rowid = ?`, via
    );
    let type: string | null = null;
    if (row) {
      const res = this.resolve(
        row.name,
        { fileId: site.fileId, path: site.path, lang: site.lang, receiver: row.receiver, rtype: row.rtype, via: row.via, caller: site.caller },
        depth + 1
      );
      const top = res.candidates[0];
      if (top) {
        if (TYPE_KINDS.has(top.sym.kind)) type = top.sym.name; // Foo(...) / new Foo(...)
        else if (top.sym.kind === 'method' && this.containerName(top.sym) === top.sym.name) type = top.sym.name; // constructor
        else {
          // Prefer a declared return type from anywhere in the target's family
          // (the interface may declare it while the implementation infers it).
          type = top.sym.ret;
          if (!type) {
            for (const c of res.candidates) {
              if (c.sym.ret && this.familyOf(top.sym).has(c.sym.id)) { type = c.sym.ret; break; }
            }
          }
        }
      }
    }
    this.chainTypeCache.set(via, type);
    return type;
  }

  /** Rank the definitions a call to `name` at `site` may refer to. */
  resolve(name: string, rawSite: CallSite, depth = 0, typesOnly = false): Resolution {
    // The calling file may know the definition under another name:
    // `import { X as Y }`, `import express from './express'`, `const express = require('./express')`.
    if (!rawSite.receiver) {
      const imported = this.importedNames(rawSite.fileId);
      const from = imported.names.get(name);
      if (from !== undefined && from !== null) {
        const original = imported.aliases.get(name);
        // ... or the file it is imported from re-exports it under this name (`export { parseId as getId } from`).
        let real: string | null = original ?? this.importedNames(from).aliases.get(name) ?? null;
        // Not when the name itself is defined there, or in a file it re-exports (`export * from './message'`
        // in a package's index): then the import means that definition, not the default export.
        if (!real && !this.candidates(name).some(c => c.file_id === from || this.importsOf(from).has(c.file_id))) {
          real = this.defaultExportOf(from);
          if (real === '*') {
            // The imported file re-exports another module's default export.
            real = null;
            for (const f of this.importsOf(from)) {
              const d = this.defaultExportOf(f);
              if (d && d !== '*') { real = d; break; }
            }
          }
        }
        if (real && real !== name) {
          const hits = this.candidates(real).filter(c => c.file_id === from || this.importsOf(from).has(c.file_id));
          if (hits.length) {
            const scored = hits
              .map(sym => ({ sym, score: (sym.file_id === from ? 96 : 62) + definitionScore(sym) * 0.5 }))
              .sort((a, b) => b.score - a.score);
            return { candidates: scored, confident: true };
          }
        }
      }
    }

    let all = this.candidates(name);
    // Resolving a type name (a supertype in `extends X`): constructors and same-named members are not answers.
    // (Ruby modules are mixins: `include Foo` names a module.)
    if (typesOnly) all = all.filter(c => TYPE_KINDS.has(c.kind) || (c.kind === 'namespace' && c.lang === 'ruby'));
    if (all.length === 0) return { candidates: [], confident: false };
    const typed = this.goQualified(this.withFieldType(rawSite, depth));
    if (!typed) return { candidates: [], confident: false }; // receiver of a type from an external Go package
    const site = typed;
    let cands = all.length > PRESELECT_THRESHOLD && !typesOnly ? this.preselect(name, site) : all;
    if (cands.length === 0) return { candidates: [], confident: false };

    // A bare name imported from outside the project cannot be a project symbol.
    if (!site.receiver && EXTERNAL_IF_UNRESOLVED.has(langFamily(site.lang))) {
      const from = this.importedNames(site.fileId).names.get(name);
      if (from === null && !all.some(c => c.file_id === site.fileId)) return { candidates: [], confident: false };
    }
    // A receiver whose declared type is not defined in this project is external too
    // (except where extension methods can add project methods to foreign types).
    if (
      site.rtype && site.receiver && !SELF_RECEIVERS.has(site.receiver) &&
      !OPEN_TYPES.has(site.lang) && !this.isProjectType(site.rtype)
    ) {
      return { candidates: [], confident: false };
    }

    const scored: Array<{ sym: SymbolRow; score: number }> = [];
    for (const sym of cands) {
      const score = this.score(name, sym, site);
      if (score !== null) scored.push({ sym, score });
    }
    if (scored.length === 0) return { candidates: [], confident: false };
    if (scored.length > 1) {
      // `record.topic()` with both a `topic` field and a `topic()` accessor: the call means the method.
      const callables = new Set<string>();
      for (const c of scored) if (!VALUE_KINDS.has(c.sym.kind)) callables.add(c.sym.file_id + ':' + c.sym.qname);
      if (callables.size) {
        for (let i = scored.length - 1; i >= 0; i--) {
          const s = scored[i]!.sym;
          if (VALUE_KINDS.has(s.kind) && callables.has(s.file_id + ':' + s.qname)) scored.splice(i, 1);
        }
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0]!;
    // The runner-up that matters is the best candidate that is a genuinely
    // different target (not an overload / interface twin of the winner).
    const family = scored.length > 1 ? this.familyOf(top.sym) : null;
    const second = scored.find(
      (c, i) =>
        i > 0 && !family!.has(c.sym.id) &&
        // Copies of one definition are the same answer: build variants (#[cfg], foo_linux.go /
        // foo_windows.go, #ifdef) score alike, and for vendored forks the winner is simply the copy
        // this file can see. Neither makes the call ambiguous.
        // (Only those: two crates that each define `Error::kind(&self) -> &ErrorKind` are different targets.)
        !(
          c.sym.qname === top.sym.qname && c.sym.kind === top.sym.kind && c.sym.signature === top.sym.signature &&
          (dirOf(c.sym.path) === dirOf(top.sym.path) || isVendoredPath(c.sym.path) !== isVendoredPath(top.sym.path))
        )
    );
    // Two same-named members of same-named types (a forked `URI.toString`, a re-declared `ILogger.warn`)
    // differ only in which type the calling file can see: its import / proximity bonus decides.
    const sameNamed = second !== undefined && second.sym.qname === top.sym.qname && second.sym.kind === top.sym.kind;
    let confident = top.score >= CONFIDENT_SCORE && (!second || top.score - second.score >= (sameNamed ? 4 : CONFIDENT_GAP));
    // An untyped receiver whose name fits two unrelated classes equally (`user.set_password()` with both
    // AbstractBaseUser and AnonymousUser defining it): the name decides nothing, so neither is a fact.
    if (
      confident && second && site.receiver && !site.rtype && site.receiver !== '?' &&
      !SELF_RECEIVERS.has(site.receiver)
    ) {
      const last = site.receiver.replace(/^[$@&*]+/, '').split(/\.|::|->|\\/).pop() ?? '';
      const tc = this.containerName(top.sym);
      const sc = this.containerName(second.sym);
      if (last && tc && sc && tc !== sc && tc !== last && looselyNamed(last, tc) && looselyNamed(last, sc)) confident = false;
    }
    // A bare call to a distinctively named function or class that the project defines exactly once
    // (`new AntiforgeryTokenSet()`, `lookupKeyReadOrReply()`): proximity is irrelevant, there is nothing else it can be.
    if (
      !confident && !second && !site.receiver && top.score >= 18 &&
      !STRICT_IMPORTS.has(langFamily(site.lang)) &&
      (splitIdentifier(name).length >= 2 || name.length >= 10) && this.familyCount(name) === 1
    ) {
      confident = true;
    }
    // Swift / Dart / Kotlin construct by calling the type: `Session(...)`. With a single type of that
    // name in the project there is nothing else it can be.
    if (
      !confident && !second && !site.receiver && TYPE_KINDS.has(top.sym.kind) && /^[A-Z]/.test(name) &&
      (site.lang === 'swift' || site.lang === 'dart' || site.lang === 'kotlin')
    ) {
      confident = true;
    }
    return { candidates: scored, confident };
  }
}

interface LooseName {
  /** Lowercase, without leading / trailing underscores. */
  lc: string;
  words: string[];
  initials: string;
}

const looseNames = new Map<string, LooseName>();

/** Per-name preparation for looselyNamed (the pair test itself runs millions of times on crowded names). */
function looseName(name: string): LooseName {
  let info = looseNames.get(name);
  if (!info) {
    const words = splitIdentifier(name);
    info = { lc: name.toLowerCase().replace(/^_+|_+$/g, ''), words, initials: words.map(w => w[0]).join('') };
    if (looseNames.size > 300_000) looseNames.clear();
    looseNames.set(name, info);
  }
  return info;
}

/** `db` ~ `Database`, `userRepo` ~ `UserRepository`, `parser` ~ `SourceParser`. */
function looselyNamed(receiver: string, container: string): boolean {
  const ri = looseName(receiver);
  const r = ri.lc;
  if (r.length < 2) return false;
  const ci = looseName(container);
  const c = container.length === ci.lc.length ? ci.lc : container.toLowerCase();
  if (r === c) return true;
  if (r.length >= 3 && (c.includes(r) || r.includes(c))) return true;
  const rw = ri.words;
  const cw = ci.words;
  if (rw.length === 0 || cw.length === 0) return false;
  // Every receiver word is a prefix of some container word (repo -> repository).
  let all = true;
  for (const w of rw) {
    if (w.length < 2) { all = false; break; }
    let found = false;
    for (const x of cw) if (x.startsWith(w)) { found = true; break; }
    if (!found) { all = false; break; }
  }
  if (all) return true;
  // Initialism: `sp` -> SourceParser.
  return r === ci.initials;
}

/** Points for sharing leading namespace segments: `A.B.x` and `A.B.y` -> 12, `A.x` and `A.y` -> 6. */
function namespaceAffinity(callerQname: string, candQname: string): number {
  const a = callerQname.split('.');
  const b = candQname.split('.');
  let common = 0;
  while (common < a.length - 1 && common < b.length - 1 && a[common] === b[common]) common++;
  return Math.min(3, common) * 6;
}

/** Receiver names the module/package a function lives in. */
function moduleLike(receiver: string, path: string): boolean {
  const r = receiver.toLowerCase();
  const parts = path.toLowerCase().split('/');
  const file = parts.pop()!.replace(/\.[a-z0-9]+$/, '');
  if (file === r || file.replace(/[-_]/g, '') === r.replace(/[-_]/g, '')) return true;
  const dir = parts.pop();
  return dir !== undefined && (dir === r || dir.replace(/[-_]/g, '') === r.replace(/[-_]/g, ''));
}
