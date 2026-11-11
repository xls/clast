import type { ClastDb } from '../db/index.js';
import { SYMBOL_COLUMNS, SYMBOL_FROM } from '../db/index.js';
import type { SymbolKind, SymbolRow } from '../types.js';
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
  const segs = text.split(/::|#|\.|->/).map(s => s.trim()).filter(Boolean);
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
  opts: { path?: string; kind?: string } = {}
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

  let rows = filter(db.symbolsByName(r.name), true);
  if (rows.length === 0) {
    rows = filter(
      db.all<SymbolRow>(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.name_lc = ?`, r.name.toLowerCase()),
      false
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

const CALL_TARGET_KINDS = new Set<SymbolKind>([
  'function', 'method', 'class', 'struct', 'macro', 'declaration', 'type', 'interface', 'trait', 'enum',
]);

export interface CallSite {
  fileId: number;
  path: string;
  lang: string;
  receiver: string | null;
  /** Symbol the call is made from, if known. */
  caller?: SymbolRow | null;
}

export interface Resolution {
  /** Candidates, best first, with scores. */
  candidates: Array<{ sym: SymbolRow; score: number }>;
  /** True when the best candidate is clearly better than the rest. */
  confident: boolean;
}

const SELF_RECEIVERS = new Set(['this', 'self', 'super', '$this', 'cls', 'base', 'Self', 'static', 'parent']);

/**
 * Caches the per-request lookups call resolution needs (imports of a file,
 * candidate definitions of a name, class ancestry).
 */
export class Resolver {
  private importCache = new Map<number, Set<number>>();
  private candidateCache = new Map<string, SymbolRow[]>();
  private ancestorCache = new Map<number, Set<string>>();

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

  candidates(name: string): SymbolRow[] {
    let list = this.candidateCache.get(name);
    if (!list) {
      list = this.db.symbolsByName(name).filter(s => CALL_TARGET_KINDS.has(s.kind));
      this.candidateCache.set(name, list);
    }
    return list;
  }

  /** Names of the classes a symbol's container extends/implements (1 level + transitive by name, bounded). */
  ancestorsOf(containerId: number): Set<string> {
    let set = this.ancestorCache.get(containerId);
    if (set) return set;
    set = new Set<string>();
    let frontier = [containerId];
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const h of this.db.all<{ name: string }>(`SELECT name FROM heritage WHERE symbol_id = ?`, id)) {
          if (set.has(h.name)) continue;
          set.add(h.name);
          for (const parent of this.db.symbolsByName(h.name)) {
            if (parent.kind === 'class' || parent.kind === 'interface' || parent.kind === 'struct' || parent.kind === 'trait') {
              next.push(parent.id);
            }
          }
        }
      }
      frontier = next.slice(0, 20);
    }
    this.ancestorCache.set(containerId, set);
    return set;
  }

  private containerName(s: SymbolRow): string | null {
    const i = s.qname.lastIndexOf('.');
    if (i === -1) return null;
    const j = s.qname.lastIndexOf('.', i - 1);
    return s.qname.slice(j + 1, i);
  }

  /** Score how plausible it is that a call at `site` targets `cand`. */
  private score(cand: SymbolRow, site: CallSite): number {
    if (langFamily(cand.lang) !== langFamily(site.lang)) return -100;
    let score = 0;

    // --- file proximity
    if (cand.file_id === site.fileId) score += 50;
    else if (this.importsOf(site.fileId).has(cand.file_id)) score += 40;
    else {
      const a = cand.path.split('/');
      const b = site.path.split('/');
      let common = 0;
      while (common < a.length - 1 && common < b.length - 1 && a[common] === b[common]) common++;
      if (common === a.length - 1 && common === b.length - 1) score += 18; // same directory
      else score += Math.min(10, common * 2);
    }

    // --- receiver evidence
    const container = this.containerName(cand);
    const callerContainer = site.caller ? this.containerName(site.caller) : null;
    const isMember = cand.kind === 'method' && container !== null;
    const recv = site.receiver;

    if (recv) {
      const bare = recv.replace(/^[$@&*]+/, '').replace(/\(\)$/, '');
      const last = bare.split(/\.|::|->/).pop() ?? bare;
      if (SELF_RECEIVERS.has(bare)) {
        if (isMember && callerContainer && container === callerContainer && cand.file_id === site.fileId) score += 60;
        else if (isMember && site.caller?.parent_id && container && this.ancestorsOf(site.caller.parent_id).has(container)) score += 45;
        else if (isMember) score -= 10;
        else score -= 25; // free function cannot be reached through this/self
      } else if (container && (last === container || bare === container)) {
        score += 55; // Foo.bar(), Foo::new()
      } else if (container && looselyNamed(last, container)) {
        score += 25; // db.query() -> Database.query, userRepo.find() -> UserRepository.find
      } else if (!isMember && moduleLike(last, cand.path)) {
        score += 35; // pkg.Func(), module.func()
      } else if (isMember) {
        score += 0; // unknown receiver type: neutral
      } else if (cand.kind === 'function' || cand.kind === 'declaration') {
        score -= 12; // obj.foo() rarely targets a free function
      }
    } else {
      if (isMember) {
        // Bare call to a method: plausible only inside the same class (implicit this).
        if (callerContainer && container === callerContainer) score += 30;
        else if (site.caller?.parent_id && container && this.ancestorsOf(site.caller.parent_id).has(container)) score += 20;
        else score -= 15;
      }
    }

    score += definitionScore(cand);
    return score;
  }

  private familyCache = new Map<number, Set<number>>();

  /**
   * Symbols that are "the same target" as `sym` for call-graph purposes:
   * overloads (same qualified name in the same file) and same-named methods
   * in containers related by inheritance (interface method <-> implementation,
   * base method <-> override). A call resolved to any member counts for all.
   */
  familyOf(sym: SymbolRow): Set<number> {
    let fam = this.familyCache.get(sym.id);
    if (fam) return fam;
    fam = new Set<number>([sym.id]);
    const same = this.candidates(sym.name);
    const container = this.containerName(sym);
    let related: Set<string> | null = null;
    if (container && sym.parent_id !== null && same.length > 1 && same.length < 400) {
      related = new Set(this.ancestorsOf(sym.parent_id));
      // Descendants: containers whose heritage names this container (2 levels).
      let frontier = [container];
      for (let depth = 0; depth < 2 && frontier.length; depth++) {
        const next: string[] = [];
        for (const name of frontier) {
          for (const row of this.db.all<{ name: string }>(
            `SELECT s.name FROM heritage h JOIN symbols s ON s.id = h.symbol_id WHERE h.name = ? LIMIT 200`, name
          )) {
            if (!related.has(row.name)) { related.add(row.name); next.push(row.name); }
          }
        }
        frontier = next.slice(0, 50);
      }
    }
    for (const other of same) {
      if (other.id === sym.id) continue;
      if (other.file_id === sym.file_id && other.qname === sym.qname) fam.add(other.id);
      else if (related && other.kind === sym.kind) {
        const oc = this.containerName(other);
        if (oc && related.has(oc)) fam.add(other.id);
      }
    }
    this.familyCache.set(sym.id, fam);
    return fam;
  }

  /** Rank the definitions a call to `name` at `site` may refer to. */
  resolve(name: string, site: CallSite): Resolution {
    const cands = this.candidates(name);
    if (cands.length === 0) return { candidates: [], confident: false };
    const scored = cands
      .map(sym => ({ sym, score: this.score(sym, site) }))
      .filter(c => c.score > -50)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return { candidates: [], confident: false };
    const top = scored[0]!;
    // The runner-up that matters is the best candidate that is a genuinely
    // different target (not an overload / interface twin of the winner).
    const family = scored.length > 1 ? this.familyOf(top.sym) : null;
    const second = scored.find((c, i) => i > 0 && !family!.has(c.sym.id));
    // A lone global candidate reached through an unrelated receiver is weak
    // evidence (think `list.push()` vs a project method named `push`).
    const confident = top.score >= 30 && (!second || top.score - second.score >= 12);
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
