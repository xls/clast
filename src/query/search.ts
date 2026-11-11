import type { ClastDb } from '../db/index.js';
import { SYMBOL_COLUMNS, SYMBOL_FROM } from '../db/index.js';
import type { SymbolRow } from '../types.js';
import { isTestPath, isVendoredPath } from './format.js';
import { KIND_WEIGHT, parseSymbolRef, pathMatches } from './resolve.js';
import { queryTerms, splitIdentifier, subwordMatch } from './words.js';

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
      if (!prev || prev.score < score) found.set(s.id, { sym: s, score, match, refs: 0 });
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
          nameLc, nameLc + '￿'
        ),
        78, 'prefix',
        s => -Math.min(12, (s.name.length - name.length) * 0.5)
      );
    }
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
      const words = splitIdentifier(s.name);
      // Prefer names that are mostly made of the query terms.
      const coverage = terms.filter(t => words.some(w => w.startsWith(t))).length / Math.max(words.length, terms.length);
      return coverage * 14;
    });

    // Terms spread over name, signature, doc and path. Score by how many
    // terms the *name* covers first, then overall coverage, then bm25.
    const textBonus = (s: SymbolRow): number => {
      const words = splitIdentifier(s.qname);
      const hay = (s.qname + ' ' + s.signature + ' ' + s.doc + ' ' + s.path).toLowerCase();
      let inName = 0;
      let anywhere = 0;
      for (const t of terms) {
        if (words.some(w => w.startsWith(t))) inName++;
        if (hay.includes(t)) anywhere++;
      }
      const rank = (s as SymbolRow & { rank: number }).rank;
      return (inName / terms.length) * 26 + (anywhere / terms.length) * 14 + Math.min(6, -rank / 2);
    };
    if (found.size < limit * 3 || isMultiWord) {
      const all = ftsRows(quoted.join(' AND '), 200);
      add(all, 30, 'text', textBonus);
      // Free-text queries degrade to "any term"; identifier queries do not
      // (a partial identifier should fall through to substring / fuzzy).
      if (isMultiWord && terms.length > 1 && all.length < limit * 2) {
        add(ftsRows(quoted.join(' OR '), 300), 22, 'text', textBonus);
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
  if (!isMultiWord && (found.size < limit || best < 50) && nameLc.length >= 2 && nameLc.length <= 40 && /^[a-z0-9_$]+$/.test(nameLc)) {
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

  // --- final ranking --------------------------------------------------------
  const hits = [...found.values()];
  const refCache = new Map<string, number>();
  for (const h of hits) {
    const s = h.sym;
    let refs = refCache.get(s.name);
    if (refs === undefined) {
      refs = db.refFileCount(s.name);
      refCache.set(s.name, refs);
    }
    h.refs = refs;
    h.score += KIND_WEIGHT[s.kind] ?? 0;
    if (s.exported) h.score += 2;
    h.score += Math.min(8, Math.log2(1 + refs) * 1.4);
    if (!wantTests && isTestPath(s.path)) h.score -= 9;
    if (isVendoredPath(s.path)) h.score -= 6;
    if (s.doc) h.score += 1;
    // Nested helpers rank below top-level definitions of the same name.
    h.score -= Math.min(3, (s.qname.split('.').length - 1) * 0.5);
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.sym.path.length - b.sym.path.length ||
      a.sym.path.localeCompare(b.sym.path) ||
      a.sym.start_line - b.sym.start_line
  );
  return { hits: hits.slice(0, limit), truncated: hits.length > limit };
}
