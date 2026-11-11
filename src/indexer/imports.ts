import { posix } from 'node:path';
import type { ClastDb } from '../db/index.js';

const JS_LANGS = new Set(['typescript', 'tsx', 'javascript', 'vue']);
const EXT_RE = /\.[A-Za-z0-9]+$/;

interface ImportRow {
  rowid: number;
  file_id: number;
  source: string;
  path: string;
  lang: string;
}

/**
 * In-memory lookup from path shapes to file ids, used to resolve import
 * specifiers to indexed files.
 */
class PathIndex {
  /** Exact path -> id. */
  readonly exact = new Map<string, number>();
  /** Path without extension -> ids. */
  readonly noExt = new Map<string, number[]>();
  /** Last path segment (without extension) -> [pathNoExt, id][]. */
  readonly byBase = new Map<string, Array<[string, number, string]>>();

  constructor(files: Array<{ id: number; path: string }>) {
    for (const f of files) {
      this.exact.set(f.path, f.id);
      const stem = f.path.replace(EXT_RE, '');
      const list = this.noExt.get(stem);
      if (list) list.push(f.id);
      else this.noExt.set(stem, [f.id]);
      const base = stem.slice(stem.lastIndexOf('/') + 1);
      const bl = this.byBase.get(base);
      if (bl) bl.push([stem, f.id, f.path]);
      else this.byBase.set(base, [[stem, f.id, f.path]]);
    }
  }

  /** Resolve a concrete project-relative path, trying extensions and index files. */
  lookup(p: string): number | undefined {
    const direct = this.exact.get(p);
    if (direct !== undefined) return direct;
    const stemmed = this.noExt.get(p);
    if (stemmed) return stemmed[0];
    // foo.js -> foo.ts (ESM-style TypeScript imports)
    if (EXT_RE.test(p)) {
      const alt = this.noExt.get(p.replace(EXT_RE, ''));
      if (alt) return alt[0];
    }
    for (const idx of ['/index', '/__init__', '/mod']) {
      const hit = this.noExt.get(p + idx);
      if (hit) return hit[0];
    }
    return undefined;
  }

  /**
   * Resolve a non-relative specifier by path suffix. When several files match,
   * prefer the one closest to the importing file; give up if still ambiguous.
   */
  suffix(spec: string, fromPath: string): number | undefined {
    const stem = spec.replace(EXT_RE, '');
    const base = stem.slice(stem.lastIndexOf('/') + 1);
    const candidates = this.byBase.get(base) ?? (EXT_RE.test(spec) ? undefined : this.byBase.get(spec));
    const hits: Array<[string, number, string]> = [];
    const hasExt = spec !== stem;
    for (const c of candidates ?? []) {
      if (c[0] === stem || c[0].endsWith('/' + stem)) {
        if (hasExt && !c[2].endsWith(spec)) continue;
        hits.push(c);
      }
    }
    if (hits.length === 0) {
      // Package directory: a/b -> a/b/index.*, a/b/__init__.py, a/b/mod.rs
      for (const idx of ['index', '__init__', 'mod']) {
        for (const c of this.byBase.get(idx) ?? []) {
          const dir = c[0].slice(0, -(idx.length + 1));
          if (dir === stem || dir.endsWith('/' + stem)) hits.push(c);
        }
        if (hits.length) break;
      }
    }
    if (hits.length === 0) return undefined;
    if (hits.length === 1) return hits[0]![1];
    let best: number | undefined;
    let bestScore = -1;
    let tie = false;
    for (const h of hits) {
      const score = commonPrefixSegments(h[0], fromPath);
      if (score > bestScore) { bestScore = score; best = h[1]; tie = false; }
      else if (score === bestScore) tie = true;
    }
    return tie ? undefined : best;
  }
}

function commonPrefixSegments(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

function resolveOne(row: ImportRow, index: PathIndex): number | undefined {
  const dir = posix.dirname(row.path);
  let src = row.source;

  if (JS_LANGS.has(row.lang)) {
    src = src.replace(/[?#].*$/, '');
    if (src.startsWith('.')) {
      const target = posix.normalize(posix.join(dir, src)).replace(/\/$/, '');
      // require('..') / import '.' name a directory: its index file.
      if (target === '.' || target === '') return index.lookup('index');
      return index.lookup(target);
    }
    if (src.startsWith('/')) return index.lookup(src.slice(1));
    // tsconfig-style aliases: "@/x", "~/x", "src/x", bare "vs/base/common/x"
    const stripped = src.replace(/^(@|~)\//, '');
    if (!stripped.includes('/')) return undefined; // bare package name
    return index.lookup(stripped) ?? index.lookup('src/' + stripped) ?? index.suffix(stripped, row.path);
  }

  if (row.lang === 'python') {
    const m = /^(\.+)(.*)$/.exec(src);
    if (m) {
      let base = dir;
      for (let i = 1; i < m[1]!.length; i++) base = posix.dirname(base);
      const rest = m[2]!.replace(/\./g, '/');
      return index.lookup(posix.normalize(posix.join(base, rest || '.')));
    }
    const p = src.replace(/\./g, '/');
    const direct = index.lookup(p) ?? index.lookup('src/' + p) ?? index.lookup('lib/' + p);
    if (direct !== undefined) return direct;
    // A bare top-level module (`import datetime`) that is not at a source
    // root is almost always the standard library or a dependency.
    if (!p.includes('/')) return undefined;
    return index.suffix(p, row.path);
  }

  if (row.lang === 'c' || row.lang === 'cpp' || row.lang === 'objc') {
    // <system.h> includes only resolve to an exact project path (a public
    // include dir), never by suffix: <math.h> is not some vendored test/math.h.
    const sys = /^<(.*)>$/.exec(src);
    if (sys) {
      const p = sys[1]!;
      return index.lookup(p) ?? index.lookup('include/' + p) ?? index.lookup('src/' + p);
    }
    return (
      index.lookup(posix.normalize(posix.join(dir, src))) ??
      index.lookup(src) ??
      index.suffix(src, row.path)
    );
  }

  if (row.lang === 'rust') {
    let parts = src.replace(/\{.*$/s, '').replace(/::\*?$/, '').split('::').filter(Boolean);
    let base = '';
    if (parts[0] === 'crate') parts = parts.slice(1);
    else if (parts[0] === 'self') { parts = parts.slice(1); base = dir; }
    else if (parts[0] === 'super') {
      base = dir;
      while (parts[0] === 'super') { parts = parts.slice(1); base = posix.dirname(base); }
    }
    // Trailing segments are usually items inside the module: try shorter paths.
    for (let n = parts.length; n >= 1 && n >= parts.length - 2; n--) {
      const p = parts.slice(0, n).join('/');
      const hit = base ? index.lookup(posix.join(base, p)) : index.suffix(p, row.path);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  if (row.lang === 'go') return undefined; // Go imports name packages (directories), not files.

  // Java / C# / PHP / Ruby / Kotlin / Swift / Dart ...: dotted or slashed names.
  if (row.lang === 'ruby' || row.lang === 'dart') {
    const clean = src.replace(/^package:[^/]+\//, '');
    return (
      index.lookup(posix.normalize(posix.join(dir, clean))) ??
      index.lookup('lib/' + clean) ??
      index.suffix(clean, row.path)
    );
  }
  const p = src.replace(/^\\/, '').replace(/[.\\]|::/g, '/').replace(/\/\*$/, '');
  return index.suffix(p, row.path);
}

/**
 * Resolve import specifiers to indexed files. With `fileIds`, only imports of
 * those files are (re)resolved; otherwise every import is.
 */
export function resolveImports(db: ClastDb, fileIds?: number[], newPaths?: string[]): number {
  const files = db.all<{ id: number; path: string }>(`SELECT id, path FROM files`);
  const index = new PathIndex(files);

  const base = `SELECT i.rowid AS rowid, i.file_id, i.source, f.path, f.lang
                FROM imports i JOIN files f ON f.id = i.file_id`;
  let rows: ImportRow[];
  if (fileIds) {
    rows = [];
    for (const id of fileIds) rows.push(...db.all<ImportRow>(`${base} WHERE i.file_id = ?`, id));
    // Files that just appeared may satisfy imports that could not be resolved before:
    // retry only the unresolved imports that mention such a file's name.
    const seen = new Set(rows.map(r => r.rowid));
    for (const p of newPaths ?? []) {
      const stem = p.slice(p.lastIndexOf('/') + 1).replace(/\.[A-Za-z0-9]+$/, '');
      if (stem.length < 2) continue;
      const like = '%' + stem.replace(/[\\%_]/g, c => '\\' + c) + '%';
      for (const r of db.all<ImportRow>(`${base} WHERE i.resolved_id IS NULL AND i.source LIKE ? ESCAPE '\\'`, like)) {
        if (!seen.has(r.rowid)) {
          seen.add(r.rowid);
          rows.push(r);
        }
      }
    }
  } else {
    rows = db.all<ImportRow>(base);
  }

  let resolved = 0;
  db.transaction(() => {
    for (const row of rows) {
      let target: number | undefined;
      try {
        target = resolveOne(row, index);
      } catch {
        target = undefined;
      }
      if (target === row.file_id) target = undefined;
      db.run(`UPDATE imports SET resolved_id = ? WHERE rowid = ?`, target ?? null, row.rowid);
      if (target !== undefined) resolved++;
    }
  });
  return resolved;
}
