import type { ClastDb } from '../db/index.js';
import { SYMBOL_COLUMNS, SYMBOL_FROM } from '../db/index.js';
import { CONTAINER_KINDS, type SymbolKind, type SymbolRow } from '../types.js';
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
  const r = typeof ref === 'string' ? parseSymbolRef(ref) : ref;
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
    // A C / C++ prototype and its definition are one function, not two candidates.
    else if (s.qname === chosen.qname && langFamily(s.lang) === 'c' && langFamily(chosen.lang) === 'c') continue;
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
}

export interface Resolution {
  /** Candidates, best first, with scores. */
  candidates: Array<{ sym: SymbolRow; score: number }>;
  /** True when the best candidate is clearly better than the rest. */
  confident: boolean;
}

/** Languages where a bare field name inside a method means this.field. */
const IMPLICIT_THIS = new Set(['java', 'csharp', 'cpp', 'kotlin', 'swift']);
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
  csharp: new Set(['Console', 'Math', 'String', 'Convert', 'Task', 'Enumerable', 'Path', 'File', 'Guid', 'Environment']),
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
  private importCache = new Map<number, Set<number>>();
  private importNameCache = new Map<number, ImportedNames>();
  private candidateCache = new Map<string, SymbolRow[]>();
  private ancestorCache = new Map<number, Set<string>>();
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
    if (fileId === target.file_id || this.importsOf(fileId).has(target.file_id)) return true;
    const container = this.containerName(target);
    return container !== null && !container.startsWith('(') && this.fileMentions(fileId, container);
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
        } else if (isDefault && parts.length === 1 && raw !== sym.name && raw !== '*') {
          // `const express = require('./express')` / `import express from './express'`
          out.push({ fileId: r.file_id, alias: raw });
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

  /** Names of the classes a container extends/implements, transitively (bounded). */
  ancestorsOf(containerId: number): Set<string> {
    let set = this.ancestorCache.get(containerId);
    if (set) return set;
    set = new Set<string>();
    let frontier = [containerId];
    for (let depth = 0; depth < 5 && frontier.length; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const row of this.db.all<{ name: string; file_id: number }>(
          `SELECT name, file_id FROM heritage WHERE symbol_id = ?`, id
        )) {
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
        for (const row of this.db.all<{ name: string }>(
          `SELECT s.name FROM heritage h JOIN symbols s ON s.id = h.symbol_id WHERE h.name = ? LIMIT 1000`, n
        )) {
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
        (other.file_id === sym.file_id || (cFamily && langFamily(other.lang) === 'c' && CALLABLE.has(sym.kind)))
      ) {
        // Overloads; in C/C++ also the header declaration of a definition.
        fam.add(other.id);
      } else if (related && (other.kind === 'method' || other.kind === sym.kind)) {
        const oc = this.containerName(other);
        if (oc && related.has(oc)) fam.add(other.id);
      }
    }
    this.familyCache.set(sym.id, fam);
    return fam;
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
  private memberEvidence(name: string, cand: SymbolRow, container: string | null, site: CallSite, recv: string | null): number {
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
      }
    }
    if (COMMON_MEMBER_NAMES.has(name.toLowerCase())) {
      // .get(), .add(), .count(): only the receiver's name can tell a project method from a builtin.
      return receiverMatches ? e : 0;
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
      !this.importsOf(site.fileId).has(cand.file_id)
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
    const isMember =
      cand.kind === 'method' ||
      (inContainer && (cand.kind === 'function' || cand.kind === 'declaration' || VALUE_KINDS.has(cand.kind)));
    // A module-level variable is only callable by its bare name; never through an object.
    if (VALUE_KINDS.has(cand.kind) && !inContainer && site.receiver) return null;
    const callerC = site.caller ? this.enclosingContainer(site.caller) : null;
    let tie = this.tieCache.get(cand.id);
    if (tie === undefined) {
      tie = definitionScore(cand) * 0.5;
      this.tieCache.set(cand.id, tie);
    }
    const recv = site.receiver;

    const inCallerClass = isMember && callerC !== null && container === callerC.name;
    const inCallerAncestors = (): boolean =>
      isMember && callerC !== null && container !== null &&
      (callerC.id !== null ? this.ancestorsOf(callerC.id).has(container) : this.relatedTo(callerC.name).anc.has(container));

    // --- typed receiver: x.foo() where x: T ------------------------------------
    if (site.rtype && recv && !SELF_RECEIVERS.has(recv)) {
      const T = site.rtype;
      if (isMember && container) {
        const vis = this.typeVisibility(T, cand, site);
        if (container === T) return 100 + vis + tie;
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
      return e >= 30 ? Math.min(50, 10 + e) + tie : null;
    }

    // --- bare call: foo() ---------------------------------------------------
    if (!recv) {
      if (isMember) {
        // Python / JS: a bare name never reaches a method (it needs self. / this.).
        if (STRICT_IMPORTS.has(fam)) return null;
        if (inCallerClass) return (sameFile ? 88 : 72) + tie; // implicit this / same (partial) class
        if (inCallerAncestors()) return 68 + tie;
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

    // --- this.foo() / self.foo() ---------------------------------------------
    if (SELF_RECEIVERS.has(recv)) {
      if (!isMember) {
        // JS object-literal style: `this.helper()` where helper is a function in the same file.
        return fam === 'js' && sameFile && cand.kind === 'function' ? 36 + tie : null;
      }
      if (inCallerClass) return (sameFile ? 96 : 80) + tie;
      if (inCallerAncestors()) return 76 + tie;
      // `function View() { this.lookup() }` with `View.prototype.lookup = ...` in the same file.
      if (!callerC && site.caller && container === site.caller.name && sameFile) return 90 + tie;
      if (callerC && container && this.relatedTo(callerC.name).desc.has(container)) return 56 + tie; // abstract hook
      const e = this.memberEvidence(name, cand, container, site, null);
      return e >= 20 ? Math.min(46, 10 + e) + tie : null; // mixin-style
    }

    // --- expression receiver: a.b().foo(), "x".foo() --------------------------
    if (recv === '?') {
      if (!isMember) return null;
      const e = this.memberEvidence(name, cand, container, site, null);
      return e >= 15 ? 10 + e + tie : null;
    }

    // --- named receiver: obj.foo(), Foo.bar(), pkg.Func(), ns::func() ---------
    const bare = recv.replace(/^[$@&*]+/, '');
    const last = bare.split(/\.|::|->|\\/).pop() ?? bare;
    const first = bare.split(/\.|::|->|\\/)[0] ?? bare;
    // console.log(), Math.max(), os.path.join(): runtime globals and external modules.
    if (BUILTIN_RECEIVERS[fam]?.has(first) && !this.isProjectType(first)) return null;
    const names = this.importedNames(site.fileId).names;
    if (EXTERNAL_IF_UNRESOLVED.has(fam) && names.get(first) === null) return null;
    if (container && (last === container || bare === container)) {
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
    this.fieldTypeCache.set(key, t);
    return t;
  }

  /**
   * Fill in the receiver type from class field declarations when the
   * extractor could not (the class is declared in another file: C++ headers,
   * partial classes, Go structs elsewhere in the package).
   */
  private withFieldType(site: CallSite, depth = 0): CallSite {
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
      const isMember = c.kind === 'method' || (inContainer && c.kind !== 'class' && c.kind !== 'struct' && c.kind !== 'interface');
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
        let real: string | null = original ?? null;
        if (!real && !this.candidates(name).some(c => c.file_id === from)) {
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
    if (typesOnly) all = all.filter(c => TYPE_KINDS.has(c.kind));
    if (all.length === 0) return { candidates: [], confident: false };
    const site = this.withFieldType(rawSite, depth);
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
        // Build variants of one definition (#[cfg], foo_linux.go / foo_windows.go, #ifdef) are the same answer.
        !(c.sym.qname === top.sym.qname && c.sym.kind === top.sym.kind && top.score - c.score < 3)
    );
    let confident = top.score >= CONFIDENT_SCORE && (!second || top.score - second.score >= CONFIDENT_GAP);
    // A bare call to a distinctively named function or class that the project defines exactly once
    // (`new AntiforgeryTokenSet()`, `lookupKeyReadOrReply()`): proximity is irrelevant, there is nothing else it can be.
    if (
      !confident && !second && !site.receiver && top.score >= 18 &&
      !STRICT_IMPORTS.has(langFamily(site.lang)) &&
      (splitIdentifier(name).length >= 2 || name.length >= 10) && this.familyCount(name) === 1
    ) {
      confident = true;
    }
    return { candidates: scored, confident };
  }
}

const looseCache = new Map<string, boolean>();

/** `db` ~ `Database`, `userRepo` ~ `UserRepository`, `parser` ~ `SourceParser`. */
function looselyNamed(receiver: string, container: string): boolean {
  const key = receiver + '\0' + container;
  let hit = looseCache.get(key);
  if (hit === undefined) {
    hit = looselyNamedUncached(receiver, container);
    if (looseCache.size > 200_000) looseCache.clear();
    looseCache.set(key, hit);
  }
  return hit;
}

function looselyNamedUncached(receiver: string, container: string): boolean {
  const r = receiver.toLowerCase().replace(/^_+|_+$/g, '');
  const c = container.toLowerCase();
  if (r.length < 2) return false;
  if (r === c) return true;
  if (r.length >= 3 && (c.includes(r) || r.includes(c))) return true;
  const rw = splitIdentifier(receiver);
  const cw = splitIdentifier(container);
  if (rw.length === 0 || cw.length === 0) return false;
  // Every receiver word is a prefix of some container word (repo -> repository).
  if (rw.every(w => w.length >= 2 && cw.some(x => x.startsWith(w)))) return true;
  // Initialism: `sp` -> SourceParser.
  if (r.length >= 2 && r === cw.map(w => w[0]).join('')) return true;
  return false;
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
