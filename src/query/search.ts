import type { ClastDb } from '../db/index.js';
import { SYMBOL_COLUMNS, SYMBOL_FROM } from '../db/index.js';
import type { SymbolRow } from '../types.js';
import { isTestPath, isVendoredPath } from './format.js';
import { KIND_WEIGHT, parseSymbolRef, pathMatches } from './resolve.js';
import { editDistance, queryTerms, splitIdentifier, subwordMatch, wordMatches } from './words.js';

export interface SearchOptions {
  kind?: string | string[];
  /** Path filter: directory prefix, file suffix or substring. */
  path?: string;
  lang?: string;
  limit?: number;
  /** Only exported / public symbols. */
  exported?: boolean;
}

export interface SearchHit {
  sym: SymbolRow;
  score: number;
  /** How the hit matched: exact, prefix, words, substring, text, fuzzy. */
  match: string;
  /** Number of files that mention the symbol's name. */
  refs: number;
  /** True when no other symbol shares this name (so `refs` really is about this symbol). */
  unique: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when more candidates existed than were returned. */
  truncated: boolean;
}

const CANDIDATE_CAP = 400;

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, c => '\\' + c);
}

/**
 * Ranked symbol search. Accepts an identifier (`parseAndStore`), a partial or
 * abbreviated name (`parseSt`, `pas`), a qualified name (`Indexer.indexAll`),
 * or free text (`resolve import path`) which is matched against names,
 * signatures and doc comments.
 */
export function searchSymbols(db: ClastDb, query: string, opts: SearchOptions = {}): SearchResult {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const q = query.trim();
  if (!q) return { hits: [], truncated: false };

  const kinds = opts.kind ? new Set(Array.isArray(opts.kind) ? opts.kind : [opts.kind]) : null;
  const accept = (s: SymbolRow): boolean =>
    (!kinds || kinds.has(s.kind)) &&
    (!opts.lang || s.lang === opts.lang) &&
    (!opts.exported || s.exported === 1) &&
    (!opts.path || pathMatches(s.path, opts.path));

  const found = new Map<number, SearchHit>();
  const add = (rows: SymbolRow[], base: number, match: string, bonus?: (s: SymbolRow) => number): void => {
    for (const s of rows) {
      if (!accept(s)) continue;
      const score = base + (bonus ? bonus(s) : 0);
      const prev = found.get(s.id);
      if (!prev || prev.score < score) found.set(s.id, { sym: s, score, match, refs: 0, unique: false });
    }
  };

  const select = `SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM}`;
  const isMultiWord = /\s/.test(q);
  const ref = parseSymbolRef(q);
  const name = isMultiWord ? q : ref.name;
  const nameLc = name.toLowerCase();
  const wantTests = /test|spec|mock|fixture|bench|example/i.test(q) || (opts.path ? isTestPath(opts.path) : false);

  if (!isMultiWord && name) {
    // 1. Exact name (case-sensitive, then insensitive).
    add(db.all<SymbolRow>(`${select} WHERE s.name = ? LIMIT ${CANDIDATE_CAP}`, name), 100, 'exact');
    add(db.all<SymbolRow>(`${select} WHERE s.name_lc = ? LIMIT ${CANDIDATE_CAP}`, nameLc), 92, 'exact');

    // Qualified query: keep only hits whose container matches, when any do.
    if (ref.container.length) {
      const want = ref.container.map(c => c.toLowerCase());
      const matches = (s: SymbolRow): boolean => {
        const parts = s.qname.toLowerCase().split('.');
        parts.pop();
        return want.every((w, i) => parts[parts.length - want.length + i] === w);
      };
      const qualified = [...found.values()].filter(h => matches(h.sym));
      if (qualified.length) {
        for (const h of found.values()) {
          if (matches(h.sym)) h.score += 8;
          else h.score -= 30;
        }
      }
    }

    // 2. Prefix.
    if (found.size < CANDIDATE_CAP && nameLc.length >= 2) {
      add(
        db.all<SymbolRow>(
          `${select} WHERE s.name_lc >= ? AND s.name_lc < ? ORDER BY length(s.name_lc) LIMIT ${CANDIDATE_CAP}`,
          nameLc, nameLc + '\uffff'
        ),
        78, 'prefix',
        s => -Math.min(12, (s.name.length - name.length) * 0.5)
      );
    }
  }

  // 2b. Abbreviations of the name's words: "KProd" -> KafkaProducer, "recAccum" -> RecordAccumulator.
  const queryWords = !isMultiWord ? splitIdentifier(name) : [];
  if (queryWords.length >= 2 && found.size < CANDIDATE_CAP) {
    const pattern = queryWords.map(likeEscape).join('%') + '%';
    add(
      db.all<SymbolRow>(
        `${select} WHERE s.name_lc LIKE ? ESCAPE '\\' ORDER BY length(s.name_lc) LIMIT 300`,
        pattern
      ).filter(s => subwordMatch(name, s.name) > 0),
      66, 'abbrev',
      s => subwordMatch(name, s.name) * 8 - Math.min(8, (s.name.length - name.length) * 0.2)
    );
  }
  // 2c. Initials: "gcn" -> getContextNode, "qs" -> QuerySet.
  if (!isMultiWord && /^[a-z]{2,6}$/.test(nameLc) && found.size < CANDIDATE_CAP) {
    add(db.all<SymbolRow>(`${select} WHERE s.abbr = ? LIMIT 200`, nameLc), 60, 'initials');
  }

  // 3. Word / concept match through FTS (names, signatures, docs, paths).
  const terms = queryTerms(q);
  if (terms.length && found.size < CANDIDATE_CAP) {
    const ftsRows = (expr: string, max: number): Array<SymbolRow & { rank: number }> => {
      try {
        return db.all<SymbolRow & { rank: number }>(
          `SELECT ${SYMBOL_COLUMNS}, bm25(symbols_fts, 10.0, 3.0, 4.0, 1.0) AS rank
           FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid JOIN files f ON f.id = s.file_id
           WHERE symbols_fts MATCH ? ORDER BY rank LIMIT ?`,
          expr, max
        );
      } catch {
        return [];
      }
    };
    const quoted = terms.map(t => `"${t.replace(/"/g, '')}"*`);
    const nameCols = (ts: string[]): string => `{words} : (${ts.join(' AND ')})`;

    // All terms in the name: strongest concept signal.
    const inName = ftsRows(nameCols(quoted), CANDIDATE_CAP);
    add(inName, isMultiWord ? 74 : 64, 'words', s => {
      // Terms found in the symbol's own name count fully; terms that only match
      // the enclosing class name make the class, not each member, the best hit.
      const words = splitIdentifier(s.name);
      const own = terms.filter(t => words.some(w => wordMatches(w, t))).length;
      const coverage = own / Math.max(words.length, terms.length);
      return coverage * 14 - (terms.length - own) * 9;
    });

    // Terms spread over name, signature, doc and path. Score by how many
    // terms the *name* covers first, then overall coverage, then bm25.
    const textBonus = (s: SymbolRow): number => {
      const own = splitIdentifier(s.name);
      const container = splitIdentifier(s.qname.slice(0, Math.max(0, s.qname.length - s.name.length)));
      const hay = splitIdentifier(s.signature + ' ' + s.doc + ' ' + s.path);
      let inName = 0;
      let inContainer = 0;
      let anywhere = 0;
      for (const t of terms) {
        if (own.some(w => wordMatches(w, t))) { inName++; anywhere++; }
        else if (container.some(w => wordMatches(w, t))) { inContainer++; anywhere++; }
        else if (hay.some(w => wordMatches(w, t))) anywhere++;
      }
      const rank = (s as SymbolRow & { rank: number }).rank;
      return (
        (inName / terms.length) * 28 +
        (inContainer / terms.length) * 9 +
        (anywhere / terms.length) * 14 +
        Math.min(6, -rank / 2)
      );
    };
    if (found.size < limit * 3 || isMultiWord) {
      const all = ftsRows(quoted.join(' AND '), 400);
      add(all, 30, 'text', textBonus);
      // Free-text queries degrade to "any term"; identifier queries do not
      // (a partial identifier should fall through to substring / fuzzy).
      if (isMultiWord && terms.length > 1 && all.length < limit * 2) {
        add(ftsRows(quoted.join(' OR '), 500), 22, 'text', textBonus);
      }
    }
  }

  // 4. Substring anywhere in the name.
  if (!isMultiWord && found.size < limit * 2 && nameLc.length >= 3) {
    add(
      db.all<SymbolRow>(
        `${select} WHERE s.name_lc LIKE ? ESCAPE '\\' ORDER BY length(s.name_lc) LIMIT 200`,
        '%' + likeEscape(nameLc) + '%'
      ),
      52, 'substring',
      s => -Math.min(10, (s.name.length - name.length) * 0.3)
    );
  }

  // 5. Fuzzy: abbreviations ("gcn" -> getContextNode) and loose subsequences.
  let best = 0;
  for (const h of found.values()) if (h.score > best) best = h.score;
  if (!isMultiWord && (found.size < limit || best < 55) && nameLc.length >= 2 && nameLc.length <= 40 && /^[a-z0-9_$]+$/.test(nameLc)) {
    const pattern = '%' + nameLc.split('').map(likeEscape).join('%') + '%';
    const rows = db.all<SymbolRow>(
      `${select} WHERE s.name_lc LIKE ? ESCAPE '\\' AND length(s.name_lc) <= ? ORDER BY length(s.name_lc) LIMIT 300`,
      pattern, Math.max(12, nameLc.length * 6)
    );
    add(rows, 30, 'fuzzy', s => {
      const sw = subwordMatch(name, s.name);
      // Abbreviations of the name's words beat arbitrary subsequences; tighter matches beat looser ones.
      return (sw > 0 ? 16 + sw * 10 : 0) - Math.min(14, (s.name.length - name.length) * 0.5);
    });
  }

  // 6. Typos: edit distance against names that share the first two characters.
  best = 0;
  for (const h of found.values()) if (h.score > best) best = h.score;
  let nameHit = false;
  for (const h of found.values()) if (h.match === 'exact' || h.match === 'prefix') { nameHit = true; break; }
  if (!isMultiWord && !nameHit && nameLc.length >= 4 && nameLc.length <= 40) {
    const bound = nameLc.length >= 9 ? 3 : nameLc.length >= 6 ? 2 : 1;
    const prefix = nameLc.slice(0, 2);
    const names = db.all<{ name_lc: string }>(
      `SELECT DISTINCT s.name_lc AS name_lc FROM symbols s
       WHERE s.name_lc >= ? AND s.name_lc < ? AND length(s.name_lc) BETWEEN ? AND ? LIMIT 20000`,
      prefix, prefix + '\uffff', nameLc.length - bound, nameLc.length + bound
    );
    const close: Array<[string, number]> = [];
    for (const row of names) {
      const d = editDistance(nameLc, row.name_lc, bound);
      if (d <= bound) close.push([row.name_lc, d]);
    }
    close.sort((a, b) => a[1] - b[1]);
    for (const [candidate, d] of close.slice(0, 12)) {
      add(db.all<SymbolRow>(`${select} WHERE s.name_lc = ? LIMIT 40`, candidate), 84 - d * 9, 'typo');
    }
  }

  // --- final ranking --------------------------------------------------------
  const hits = [...found.values()];
  const refCache = new Map<string, number>();
  const defCache = new Map<string, number>();
  for (const h of hits) {
    const s = h.sym;
    let refs = refCache.get(s.name);
    if (refs === undefined) {
      refs = db.refFileCount(s.name);
      refCache.set(s.name, refs);
    }
    h.refs = refs;
    let defs = defCache.get(s.name);
    if (defs === undefined) {
      defs = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM symbols WHERE name = ?`, s.name)?.n ?? 1;
      defCache.set(s.name, defs);
    }
    h.unique = defs === 1;
    h.score += KIND_WEIGHT[s.kind] ?? 0;
    if (s.exported) h.score += 2;
    h.score += Math.min(8, Math.log2(1 + refs) * 1.4);
    // Tests and examples mention every concept; for free-text queries they must not bury the implementation.
    if (!wantTests && isTestPath(s.path)) h.score -= h.match === 'text' || h.match === 'words' ? 16 : 9;
    if (isVendoredPath(s.path)) h.score -= 6;
    if (s.doc) h.score += 1;
    // Nested helpers rank below top-level definitions of the same name.
    h.score -= Math.min(3, (s.qname.split('.').length - 1) * 0.5);
  }

  // Production code always comes before tests / examples / docs (unless the query asks for those):
  // tests mention every concept by name and would otherwise bury the implementation.
  const testRank = (h: SearchHit): number => (!wantTests && isTestPath(h.sym.path) ? 1 : 0);
  hits.sort(
    (a, b) =>
      testRank(a) - testRank(b) ||
      b.score - a.score ||
      a.sym.path.length - b.sym.path.length ||
      a.sym.path.localeCompare(b.sym.path) ||
      a.sym.start_line - b.sym.start_line
  );
  return { hits: hits.slice(0, limit), truncated: hits.length > limit };
}
