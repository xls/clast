/**
 * Identifier tokenisation shared by indexing (FTS) and search.
 */

const WORD_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+|[^\x00-\x7F]+/g;

/**
 * Split an identifier or path into lowercase sub-words:
 * `parseAndStore` -> [parse, and, store], `HTTPServer2` -> [http, server, 2],
 * `snake_case_name` -> [snake, case, name].
 */
const splitCache = new Map<string, string[]>();

export function splitIdentifier(text: string): string[] {
  // Identifiers repeat endlessly during resolution and ranking; short ones are cached.
  const cacheable = text.length <= 48;
  if (cacheable) {
    const hit = splitCache.get(text);
    if (hit) return hit;
  }
  const out: string[] = [];
  const matches = text.match(WORD_RE);
  if (matches) for (const m of matches) out.push(m.toLowerCase());
  if (cacheable) {
    if (splitCache.size > 50_000) splitCache.clear();
    splitCache.set(text, out);
  }
  return out;
}

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*|[^\x00-\x7F]+/g;

/**
 * Text for an FTS column: every identifier is emitted as its sub-words plus
 * the whole lowercased identifier, de-duplicated, so both `parse store` and
 * `parseandstore` match.
 */
export function ftsWords(text: string): string {
  const seen = new Set<string>();
  const idents = text.match(IDENT_RE);
  if (!idents) return '';
  for (const ident of idents) {
    const parts = splitIdentifier(ident);
    for (const p of parts) seen.add(p);
    if (parts.length > 1) seen.add(parts.join(''));
    if (seen.size > 80) break;
  }
  return [...seen].join(' ');
}

/** Lowercase query terms for free-text search (stop words removed). */
const STOP = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'is', 'are', 'and', 'or', 'that', 'this', 'it',
  'with', 'as', 'by', 'at', 'from', 'how', 'what', 'where', 'which', 'does', 'do', 'be', 'when',
]);

export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of query.split(/[\s,;:(){}\[\]<>"'`=+*/\\|&!?#@^~%-]+/)) {
    if (!raw) continue;
    for (const w of splitIdentifier(raw)) {
      if (w.length < 2 || STOP.has(w) || seen.has(w)) continue;
      seen.add(w);
      terms.push(w);
    }
  }
  return terms;
}

/** True if `needle` is a subsequence of `hay` (both lowercase). */
export function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay.charCodeAt(j) === needle.charCodeAt(i)) i++;
  }
  return i === needle.length;
}

/**
 * Match a query against the sub-words of a name the way editors do
 * ("gcn" / "getCtxNode" -> getContextNode). Returns a 0..1 quality or 0.
 */
export function subwordMatch(query: string, name: string): number {
  const words = splitIdentifier(name);
  if (words.length === 0) return 0;
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!q) return 0;
  // Greedy: consume query chars as prefixes of successive words.
  let qi = 0;
  let matchedWords = 0;
  for (const w of words) {
    if (qi >= q.length) break;
    let k = 0;
    while (k < w.length && qi + k < q.length && w.charCodeAt(k) === q.charCodeAt(qi + k)) k++;
    if (k > 0) {
      qi += k;
      matchedWords++;
    }
  }
  if (qi < q.length) return 0;
  return matchedWords / words.length;
}

/**
 * Very light stemmer for matching query words against identifier words
 * (dependency ~ dependencies, parsing ~ parse, resolved ~ resolve). Not
 * linguistically exact; it only has to agree with itself.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'i';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('er') && w.length > 5) w = w.slice(0, -2);
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  // dependency / dependenc(ies): unify the y / i variants
  if (w.endsWith('y') && w.length > 4) w = w.slice(0, -1) + 'i';
  return w;
}

/** True if a name word matches a query term, allowing prefixes and inflections. */
export function wordMatches(nameWord: string, term: string): boolean {
  if (nameWord.startsWith(term)) return true;
  const a = stem(nameWord);
  const b = stem(term);
  return a === b || (b.length >= 4 && a.startsWith(b));
}

/** Initials of an identifier's sub-words: getContextNode -> gcn. Empty for single-word names. */
export function initials(name: string): string {
  const words = splitIdentifier(name);
  if (words.length < 2) return '';
  let out = '';
  for (const w of words) out += w[0];
  return out;
}

/** Damerau-Levenshtein distance with an upper bound (returns bound + 1 when exceeded). */
export function editDistance(a: string, b: string, bound: number): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > bound) return bound + 1;
  let prev2: number[] = [];
  let prev: number[] = new Array(m + 1);
  let cur: number[] = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (
        i > 1 && j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > bound) return bound + 1;
    prev2 = prev;
    prev = cur;
    cur = new Array(m + 1);
  }
  return prev[m]!;
}