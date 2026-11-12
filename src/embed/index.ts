import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SYMBOL_COLUMNS, SYMBOL_FROM } from '../db/index.js';
import { isTestPath, isVendoredPath } from '../query/format.js';
import { pathMatches } from '../query/resolve.js';
import type { ToolContext } from '../tools/context.js';
import type { SymbolRow } from '../types.js';
import { createEmbedder, type Embedder } from './embedder.js';

// ---------------------------------------------------------------------------
// Search by meaning
// ---------------------------------------------------------------------------
//
// Every function, method and type gets a vector made from its name, signature, comment and the start
// of its body. A question gets one too; the nearest vectors are the code that is about the same
// thing, whatever words it uses. Vectors live in their own file next to the index (.clast/
// embeddings.db), keyed by path and qualified name with a hash of the embedded text: they survive an
// index rebuild, and only code that changed is embedded again.

const KINDS = ['function', 'method', 'class', 'interface', 'struct', 'trait', 'enum'];
const BODY_LINES = 24;
const BODY_CHARS = 1200;
const BATCH = 16;

const require = createRequire(import.meta.url);

interface Store {
  db: DatabaseSync;
  model: string;
}

const stores = new WeakMap<object, Store>();

function open(ctx: ToolContext, model: string): Store {
  const hit = stores.get(ctx.clast);
  if (hit && hit.model === model) return hit;
  if (hit) hit.db.close();
  const { DatabaseSync: Db } = require('node:sqlite') as typeof import('node:sqlite');
  const file = join(dirname(ctx.clast.db.path), 'embeddings.db');
  mkdirSync(dirname(file), { recursive: true });
  const db = new Db(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS vectors (
      path TEXT NOT NULL, qname TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, vec BLOB NOT NULL,
      PRIMARY KEY (path, qname, kind)
    ) WITHOUT ROWID;
  `);
  // Vectors of another model are not comparable: start over.
  const stored = db.prepare(`SELECT value FROM meta WHERE key = 'model'`).get() as { value: string } | undefined;
  if (stored?.value !== model) {
    db.exec(`DELETE FROM vectors`);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(model);
  }
  const store = { db, model };
  stores.set(ctx.clast, store);
  ctx.clast.closers.push(() => {
    stores.delete(ctx.clast);
    memory.delete(ctx.clast);
    db.close();
  });
  return store;
}

/** What is embedded for a symbol: how it is named, declared, documented, and how it starts. */
function textOf(ctx: ToolContext, s: SymbolRow): string {
  const parts = [`${s.kind} ${s.qname}`, s.signature];
  if (s.doc) parts.push(s.doc.slice(0, 500));
  if (s.kind === 'function' || s.kind === 'method') {
    const lines = ctx.lines.lines(s.path);
    if (lines) parts.push(lines.slice(s.start_line - 1, Math.min(s.end_line, s.start_line - 1 + BODY_LINES)).join('\n').slice(0, BODY_CHARS));
  }
  return parts.filter(Boolean).join('\n');
}

/** Unit vector as signed bytes: a quarter of the size, and the ranking barely changes. */
function pack(v: Float32Array): Uint8Array {
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(v[i]! * 127)));
  return new Uint8Array(out.buffer);
}

function candidates(ctx: ToolContext): SymbolRow[] {
  return ctx.db
    .all<SymbolRow>(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.kind IN (${KINDS.map(() => '?').join(',')})`, ...KINDS)
    .filter(s => !isVendoredPath(s.path));
}

export interface EmbedProgress {
  done: number;
  total: number;
}

export interface EmbedResult {
  embedded: number;
  kept: number;
  removed: number;
  seconds: number;
  error?: string;
}

/** Embed what is new or changed and drop what is gone. Safe to interrupt and to run again. */
export async function embedAll(
  ctx: ToolContext,
  onProgress?: (p: EmbedProgress) => void,
  shouldStop?: () => boolean
): Promise<EmbedResult> {
  const started = performance.now();
  const made = createEmbedder(ctx.clast.config);
  if ('error' in made) return { embedded: 0, kept: 0, removed: 0, seconds: 0, error: made.error };
  const embedder = made.embedder;
  const store = open(ctx, embedder.id);
  // The text is read from disk: do not trust lines cached before an edit.
  ctx.lines.invalidate();

  const have = new Map<string, string>();
  for (const r of store.db.prepare(`SELECT path, qname, kind, hash FROM vectors`).all() as Array<{ path: string; qname: string; kind: string; hash: string }>) {
    have.set(`${r.path}\0${r.qname}\0${r.kind}`, r.hash);
  }
  const todo: Array<{ sym: SymbolRow; text: string; hash: string }> = [];
  const seen = new Set<string>();
  for (const s of candidates(ctx)) {
    const key = `${s.path}\0${s.qname}\0${s.kind}`;
    if (seen.has(key)) continue; // overloads share one vector
    seen.add(key);
    const text = textOf(ctx, s);
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 16);
    if (have.get(key) !== hash) todo.push({ sym: s, text, hash });
  }
  let removed = 0;
  const del = store.db.prepare(`DELETE FROM vectors WHERE path = ? AND qname = ? AND kind = ?`);
  for (const key of have.keys()) {
    if (seen.has(key)) continue;
    const [path, qname, kind] = key.split('\0');
    del.run(path!, qname!, kind!);
    removed++;
  }

  const put = store.db.prepare(
    `INSERT INTO vectors (path, qname, kind, hash, vec) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path, qname, kind) DO UPDATE SET hash = excluded.hash, vec = excluded.vec`
  );
  let embedded = 0;
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      if (shouldStop?.()) break;
      const batch = todo.slice(i, i + BATCH);
      const vectors = await embedder.embed(batch.map(b => b.text));
      store.db.exec('BEGIN');
      for (let k = 0; k < batch.length; k++) {
        const b = batch[k]!;
        put.run(b.sym.path, b.sym.qname, b.sym.kind, b.hash, pack(vectors[k]!));
      }
      store.db.exec('COMMIT');
      embedded += batch.length;
      onProgress?.({ done: embedded, total: todo.length });
    }
  } catch (err) {
    try { store.db.exec('ROLLBACK'); } catch { /* no transaction open */ }
    return {
      embedded, kept: seen.size - todo.length, removed, seconds: (performance.now() - started) / 1000,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (embedded || removed) memory.delete(ctx.clast);
  return { embedded, kept: seen.size - todo.length, removed, seconds: (performance.now() - started) / 1000 };
}

/** How many of the symbols that should have a vector have one. */
export function embeddingStatus(ctx: ToolContext): { model: string; have: number; want: number } | null {
  const made = createEmbedder(ctx.clast.config);
  if ('error' in made) return null;
  const store = open(ctx, made.embedder.id);
  const have = (store.db.prepare(`SELECT COUNT(*) AS n FROM vectors`).get() as { n: number }).n;
  return { model: made.embedder.id, have, want: new Set(candidates(ctx).map(s => `${s.path}\0${s.qname}\0${s.kind}`)).size };
}

interface Loaded {
  count: number;
  dims: number;
  data: Int8Array;
  keys: Array<{ path: string; qname: string; kind: string }>;
}

const memory = new WeakMap<object, Loaded>();

function load(ctx: ToolContext, store: Store): Loaded {
  const count = (store.db.prepare(`SELECT COUNT(*) AS n FROM vectors`).get() as { n: number }).n;
  const hit = memory.get(ctx.clast);
  if (hit && hit.count === count) return hit;
  const rows = store.db.prepare(`SELECT path, qname, kind, vec FROM vectors`).all() as Array<{ path: string; qname: string; kind: string; vec: Uint8Array }>;
  const dims = rows.length ? rows[0]!.vec.length : 0;
  const data = new Int8Array(rows.length * dims);
  const keys: Loaded['keys'] = [];
  rows.forEach((r, i) => {
    data.set(new Int8Array(r.vec.buffer, r.vec.byteOffset, dims), i * dims);
    keys.push({ path: r.path, qname: r.qname, kind: r.kind });
  });
  const loaded = { count, dims, data, keys };
  memory.set(ctx.clast, loaded);
  return loaded;
}

export interface MeaningHit {
  sym: SymbolRow;
  /** Cosine similarity, 0 to 1 for anything worth showing. */
  score: number;
}

export interface MeaningFilter {
  path?: string;
  kind?: string | string[];
  lang?: string;
  includeTests?: boolean;
}

let embedderCache: { id: string; embedder: Embedder } | null = null;

/** The symbols whose vectors are nearest to the query's, best first. Null when embeddings are not usable. */
export async function searchByMeaning(ctx: ToolContext, query: string, limit: number, filter: MeaningFilter = {}): Promise<MeaningHit[] | null> {
  const made = createEmbedder(ctx.clast.config);
  if ('error' in made) return null;
  if (embedderCache?.id !== made.embedder.id) embedderCache = { id: made.embedder.id, embedder: made.embedder };
  const store = open(ctx, made.embedder.id);
  const all = load(ctx, store);
  if (all.count === 0) return null;
  const [qv] = await embedderCache.embedder.embed([query]);
  if (!qv || qv.length !== all.dims) return null;
  const q = new Int8Array(pack(qv).buffer);

  const kinds = filter.kind ? new Set(Array.isArray(filter.kind) ? filter.kind : [filter.kind]) : null;
  const scored: Array<{ i: number; score: number }> = [];
  for (let i = 0; i < all.count; i++) {
    const key = all.keys[i]!;
    if (kinds && !kinds.has(key.kind)) continue;
    if (filter.path && !pathMatches(key.path, filter.path)) continue;
    if (filter.includeTests === false && isTestPath(key.path)) continue;
    let dot = 0;
    const base = i * all.dims;
    for (let d = 0; d < all.dims; d++) dot += q[d]! * all.data[base + d]!;
    scored.push({ i, score: dot / (127 * 127) });
  }
  scored.sort((a, b) => b.score - a.score);

  const out: MeaningHit[] = [];
  for (const s of scored) {
    if (out.length >= limit) break;
    const key = all.keys[s.i]!;
    const sym = ctx.db.get<SymbolRow>(
      `SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE f.path = ? AND s.qname = ? AND s.kind = ? LIMIT 1`,
      key.path, key.qname, key.kind
    );
    if (!sym || (filter.lang && sym.lang !== filter.lang)) continue;
    out.push({ sym, score: s.score });
  }
  return out;
}
