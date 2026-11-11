/**
 * Identifier tokenisation shared by indexing (FTS) and search.
 */

const WORD_RE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+|[^\x00-\x7F]+/g;

/**
 * Split an identifier or path into lowercase sub-words:
 * `parseAndStore` -> [parse, and, store], `HTTPServer2` -> [http, server, 2],
 * `snake_case_name` -> [snake, case, name].
 */
export function splitIdentifier(text: string): string[] {
  const out: string[] = [];
  const matches = text.match(WORD_RE);
  if (!matches) return out;
  for (const m of matches) out.push(m.toLowerCase());
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
