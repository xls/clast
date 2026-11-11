import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SymbolRow } from '../types.js';

/** `path:start-end` (or `path:line` for one-liners). */
export function loc(s: Pick<SymbolRow, 'path' | 'start_line' | 'end_line'>): string {
  return s.start_line === s.end_line
    ? `${s.path}:${s.start_line}`
    : `${s.path}:${s.start_line}-${s.end_line}`;
}

/** `kind qname  path:start-end` */
export function symLine(s: SymbolRow): string {
  return `${s.kind} ${s.qname}  ${loc(s)}`;
}

export function firstLine(text: string, max = 160): string {
  const nl = text.indexOf('\n');
  let line = nl === -1 ? text : text.slice(0, nl);
  line = line.trim();
  return line.length > max ? line.slice(0, max - 3) + '...' : line;
}

export function plural(n: number, word: string): string {
  if (n === 1) return `1 ${word}`;
  return `${n} ${word}${/(ch|sh|s|x)$/.test(word) ? 'es' : 's'}`;
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|specs|testing|testdata|fixtures|__mocks__|mocks?|e2e|benchmarks?|bench|examples?|samples?|demos?|docs?|docs_src|documentation|tutorials?|playground|stubs?)(\/|$)|(\.|_|-)(test|spec|tests|bench)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|(^|\/)(testassets|test-assets|perf|benchmarkapps)(\/|$)|Tests?\.(java|cs|kt|swift)$/i;

const testPathCache = new Map<string, boolean>();

/** Tests, fixtures, examples and benchmarks rank below production code. */
export function isTestPath(path: string): boolean {
  let hit = testPathCache.get(path);
  if (hit === undefined) {
    hit = TEST_PATH_RE.test(path);
    if (testPathCache.size > 100_000) testPathCache.clear();
    testPathCache.set(path, hit);
  }
  return hit;
}

const GENERATED_RE = /(^|\/)(generated|gen|third_party|thirdparty|external|deps|vendor)(\/|$)|\.(pb|gen|generated)\.[a-z]+$|\.d\.ts$/i;

const vendoredPathCache = new Map<string, boolean>();

export function isVendoredPath(path: string): boolean {
  let hit = vendoredPathCache.get(path);
  if (hit === undefined) {
    hit = GENERATED_RE.test(path);
    if (vendoredPathCache.size > 100_000) vendoredPathCache.clear();
    vendoredPathCache.set(path, hit);
  }
  return hit;
}

/**
 * Small LRU of file contents split into lines, so several tools in one
 * request (or consecutive requests) do not re-read the same file.
 */
export class LineCache {
  private cache = new Map<string, string[]>();
  constructor(private readonly root: string, private readonly max = 64) {}

  lines(rel: string): string[] | null {
    const hit = this.cache.get(rel);
    if (hit) {
      this.cache.delete(rel);
      this.cache.set(rel, hit);
      return hit;
    }
    let text: string;
    try {
      text = readFileSync(join(this.root, rel), 'utf-8');
    } catch {
      return null;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r?\n/);
    this.cache.set(rel, lines);
    if (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return lines;
  }

  invalidate(rel?: string): void {
    if (rel) this.cache.delete(rel);
    else this.cache.clear();
  }

  /** One trimmed source line (1-based), or ''. */
  line(rel: string, n: number, max = 180): string {
    const lines = this.lines(rel);
    const raw = lines?.[n - 1];
    if (raw === undefined) return '';
    const t = raw.trim();
    return t.length > max ? t.slice(0, max - 3) + '...' : t;
  }

  /** Numbered excerpt of lines [start, end] (1-based, inclusive). */
  excerpt(rel: string, start: number, end: number): string | null {
    const lines = this.lines(rel);
    if (!lines) return null;
    const from = Math.max(1, start);
    const to = Math.min(lines.length, end);
    const width = String(to).length;
    const out: string[] = [];
    for (let i = from; i <= to; i++) {
      out.push(`${String(i).padStart(width)}| ${lines[i - 1]}`);
    }
    return out.join('\n');
  }
}

/** Cap a list and say how many were dropped. */
export function capped<T>(items: T[], limit: number): { shown: T[]; more: number } {
  if (items.length <= limit) return { shown: items, more: 0 };
  return { shown: items.slice(0, limit), more: items.length - limit };
}
