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
  let text = ref.trim().replace(/\(\)$/, '');
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
  if (rows.length === 0 && !opts.exact) {
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
export function otherDefinitions(chosen: SymbolRow, all: SymbolRow[]): { others: SymbolRow[]; overloads: number } {
  const others: SymbolRow[] = [];
  let overloads = 0;
  for (const s of all) {
    if (s.id === chosen.id) continue;
    if (s.file_id === chosen.file_id && s.qname === chosen.qname) overloads++;
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

/** In C nothing but functions and macros can be called. */
const C_CALLABLE = new Set<SymbolKind>(['function', 'declaration', 'macro']);

/** Families where a bare name must be defined in the file or imported into it. */
const STRICT_IMPORTS = new Set(['js', 'python']);
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
  private importNameCache = new Map<number, { names: Map<string, number | null>; wildcards: Set<number> }>();
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
  private importedNames(fileId: number): { names: Map<string, number | null>; wildcards: Set<number> } {
    let entry = this.importNameCache.get(fileId);
    if (!entry) {
      entry = { names: new Map(), wildcards: new Set() };
      for (const r of this.db.all<{ names: string; resolved_id: number | null }>(
        `SELECT names, resolved_id FROM imports INDEXED BY idx_imports_file WHERE file_id = ?`, fileId
      )) {
        if (!r.names) continue;
        for (const n of r.names.split(',')) {
          if (n === '*') {
            if (r.resolved_id !== null) entry.wildcards.add(r.resolved_id);
          } else if (!entry.names.has(n) || entry.names.get(n) === null) {
            entry.names.set(n, r.resolved_id);
          }
        }
      }
      this.importNameCache.set(fileId, entry);
    }
    return entry;
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
    if (CONTAINER_KINDS.has(sym.kind)) return { name: sym.name, id: sym.id };
    let cur: SymbolRow | null = sym;
    for (let i = 0; i < 8 && cur; i++) {
      cur = this.parentOf(cur);
      if (cur && CONTAINER_KINDS.has(cur.kind)) return { name: cur.name, id: cur.id };
    }
    // Go receivers, Rust impl blocks, C++ out-of-line definitions: the container is only in the name.
    const name = this.containerName(sym);
    return name ? { name, id: null } : null;
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
        for (const h of this.db.all<{ name: string }>(`SELECT name FROM heritage WHERE symbol_id = ?`, id)) {
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
    }
    let frontier = [name];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const row of this.db.all<{ name: string }>(
          `SELECT s.name FROM heritage h JOIN symbols s ON s.id = h.symbol_id WHERE h.name = ? LIMIT 300`, n
        )) {
          if (row.name !== name && !rel.desc.has(row.name)) {
            rel.desc.add(row.name);
            next.push(row.name);
          }
        }
      }
      frontier = next.slice(0, 60);
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
    const same = this.candidates(sym.name);
    const container = this.containerName(sym);
    let related: Set<string> | null = null;
    if (container && same.length > 1 && same.length < 600) {
      const rel = this.relatedTo(container);
      related = new Set([...rel.anc, ...rel.desc]);
    }
    const cFamily = langFamily(sym.lang) === 'c';
    for (const other of same) {
      if (other.id === sym.id) continue;
      if (other.qname === sym.qname && (other.file_id === sym.file_id || (cFamily && langFamily(other.lang) === 'c'))) {
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
    if (cand.file_id === site.fileId) e += 15;
    else if (this.importsOf(site.fileId).has(cand.file_id)) e += 22;
    else if (dirOf(cand.path) === dirOf(site.path)) e += site.lang === 'go' || site.lang === 'java' ? 15 : 8;
    if (container && cand.file_id !== site.fileId && this.fileMentions(site.fileId, container)) e += 18;
    if (recv && container) {
      if (looselyNamed(recv, container)) e += 30;
      else if (recv.length === 1 && container[0]!.toLowerCase() === recv.toLowerCase()) e += 8; // Go: `s` for *Site
    }
    const receiverMatches = e >= 30 && recv !== null && container !== null && looselyNamed(recv, container);
    if (COMMON_MEMBER_NAMES.has(name.toLowerCase())) {
      // .get(), .add(), .count(): only the receiver's name can tell a project method from a builtin.
      return receiverMatches ? e : 0;
    }
    if (this.familyCount(name) === 1) e += 20;
    return e;
  }

  /** Score how plausible it is that a call at `site` targets `cand`; null = impossible. */
  private score(name: string, cand: SymbolRow, site: CallSite): number | null {
    const fam = langFamily(site.lang);
    if (langFamily(cand.lang) !== fam) return null;
    if (site.lang === 'c' && !C_CALLABLE.has(cand.kind)) return null;

    // Production code does not call into tests, fixtures or examples.
    if (isTestPath(cand.path) && !isTestPath(site.path)) return null;

    const sameFile = cand.file_id === site.fileId;
    const parent = this.parentOf(cand);

    // Functions nested in a function are visible only inside it.
    if (parent && (parent.kind === 'function' || parent.kind === 'method')) {
      if (!sameFile || !site.caller) return null;
      const q = site.caller.qname;
      if (q !== parent.qname && !q.startsWith(parent.qname + '.')) return null;
    }

    const container = this.containerName(cand);
    const inContainer = parent !== null && CONTAINER_KINDS.has(parent.kind);
    const isMember =
      cand.kind === 'method' ||
      (inContainer && (cand.kind === 'function' || cand.kind === 'declaration' || VALUE_KINDS.has(cand.kind)));
    // A module-level variable is only callable by its bare name; never through an object.
    if (VALUE_KINDS.has(cand.kind) && !inContainer && site.receiver) return null;
    const callerC = site.caller ? this.enclosingContainer(site.caller) : null;
    const tie = definitionScore(cand) * 0.5;
    const recv = site.receiver;

    const inCallerClass = isMember && callerC !== null && container === callerC.name;
    const inCallerAncestors = (): boolean =>
      isMember && callerC !== null && container !== null &&
      (callerC.id !== null ? this.ancestorsOf(callerC.id).has(container) : this.relatedTo(callerC.name).anc.has(container));

    // --- typed receiver: x.foo() where x: T ------------------------------------
    if (site.rtype && recv && !SELF_RECEIVERS.has(recv)) {
      const T = site.rtype;
      if (isMember && container) {
        if (container === T) return 100 + tie;
        const rel = this.relatedTo(T);
        if (rel.anc.has(container)) return 86 + tie; // inherited from a supertype
        if (rel.desc.has(container)) return 72 + tie; // override in a subtype
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
      if (this.importsOf(site.fileId).has(cand.file_id)) return 64 + tie;
      const a = cand.path.split('/');
      const b = site.path.split('/');
      let common = 0;
      while (common < a.length - 1 && common < b.length - 1 && a[common] === b[common]) common++;
      if (common === a.length - 1 && common === b.length - 1) return 46 + tie; // same directory
      return 18 + Math.min(12, common * 3) + tie;
    }

    // --- this.foo() / self.foo() ---------------------------------------------
    if (SELF_RECEIVERS.has(recv)) {
      if (!isMember) {
        // JS object-literal style: `this.helper()` where helper is a function in the same file.
        return fam === 'js' && sameFile && cand.kind === 'function' ? 36 + tie : null;
      }
      if (inCallerClass) return (sameFile ? 96 : 80) + tie;
      if (inCallerAncestors()) return 76 + tie;
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
    if (container && (last === container || bare === container)) return 92 + tie; // static / qualified call
    if (isMember) {
      // Static / class-level call through a subclass: Sub.inheritedMethod().
      if (container && /^[A-Z]/.test(last) && this.isProjectType(last) && this.relatedTo(last).anc.has(container)) {
        return 84 + tie;
      }
      const e = this.memberEvidence(name, cand, container, site, last);
      return e >= 15 ? 10 + e + tie : null;
    }
    const from = this.importedNames(site.fileId).names.get(last);
    if (from !== undefined && from !== null) return from === cand.file_id ? 94 + tie : null; // import * as ns
    if (moduleLike(last, cand.path)) return (this.importsOf(site.fileId).has(cand.file_id) ? 86 : 74) + tie;
    return null;
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
  private withFieldType(site: CallSite): CallSite {
    const r = site.receiver;
    if (site.rtype || !r || r === '?' || !site.caller) return site;
    let field: string | null = null;
    const m = /^(?:this|self|\$this|base|Self)(?:\.|->|::)([A-Za-z_]\w*)$/.exec(r) ?? /^@([A-Za-z_]\w*)$/.exec(r);
    if (m) field = m[1]!;
    else if (IMPLICIT_THIS.has(site.lang) && /^[A-Za-z_]\w*$/.test(r) && !SELF_RECEIVERS.has(r)) field = r;
    if (!field) return site;
    const container = this.enclosingContainer(site.caller);
    if (!container) return site;
    const t = this.fieldType(container.name, field);
    return t ? { ...site, rtype: t } : site;
  }

  /** Rank the definitions a call to `name` at `site` may refer to. */
  resolve(name: string, rawSite: CallSite): Resolution {
    const cands = this.candidates(name);
    if (cands.length === 0) return { candidates: [], confident: false };
    const site = this.withFieldType(rawSite);

    // A bare name imported from outside the project cannot be a project symbol.
    if (!site.receiver && EXTERNAL_IF_UNRESOLVED.has(langFamily(site.lang))) {
      const from = this.importedNames(site.fileId).names.get(name);
      if (from === null && !cands.some(c => c.file_id === site.fileId)) return { candidates: [], confident: false };
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
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0]!;
    // The runner-up that matters is the best candidate that is a genuinely
    // different target (not an overload / interface twin of the winner).
    const family = scored.length > 1 ? this.familyOf(top.sym) : null;
    const second = scored.find((c, i) => i > 0 && !family!.has(c.sym.id));
    const confident = top.score >= CONFIDENT_SCORE && (!second || top.score - second.score >= CONFIDENT_GAP);
    return { candidates: scored, confident };
  }
}

/** `db` ~ `Database`, `userRepo` ~ `UserRepository`, `parser` ~ `SourceParser`. */
function looselyNamed(receiver: string, container: string): boolean {
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

/** Receiver names the module/package a function lives in. */
function moduleLike(receiver: string, path: string): boolean {
  const r = receiver.toLowerCase();
  const parts = path.toLowerCase().split('/');
  const file = parts.pop()!.replace(/\.[a-z0-9]+$/, '');
  if (file === r || file.replace(/[-_]/g, '') === r.replace(/[-_]/g, '')) return true;
  const dir = parts.pop();
  return dir !== undefined && (dir === r || dir.replace(/[-_]/g, '') === r.replace(/[-_]/g, ''));
}
