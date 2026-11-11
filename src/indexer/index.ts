import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative } from 'node:path';
import type { ClastConfig } from '../config/index.js';
import type { ClastDb } from '../db/index.js';
import type { FileRow } from '../types.js';
import { SourceParser } from '../parser/index.js';
import { IgnoreRules, type ScannedFile } from './scan.js';
import { processFile, type FileResult, type FileTask } from './process.js';
import { resolveImports } from './imports.js';

export interface IndexResult {
  scanned: number;
  parsed: number;
  unchanged: number;
  removed: number;
  durationMs: number;
  workers: number;
}

export interface IndexProgress {
  phase: 'idle' | 'scanning' | 'parsing' | 'finalizing';
  done: number;
  total: number;
}

const WORKER_THRESHOLD = 48;
const TASK_BATCH = 12;
const WRITE_BATCH = 150;
const BULK_THRESHOLD = 400;
const BULK_WRITE_BATCH = 800;

/**
 * Keeps the database in sync with the working tree: bulk (re)indexing with a
 * worker pool, single-file updates, and on-demand freshness checks.
 */
export class Indexer {
  readonly root: string;
  readonly rules: IgnoreRules;
  readonly parser = new SourceParser();
  progress: IndexProgress = { phase: 'idle', done: 0, total: 0 };
  lastResult: IndexResult | null = null;
  private running: Promise<IndexResult> | null = null;
  private importsDirty = new Set<number>();
  private structureChanged = false;

  constructor(
    root: string,
    private readonly config: ClastConfig,
    private readonly db: ClastDb
  ) {
    this.root = root;
    this.rules = new IgnoreRules(root, config);
  }

  get isIndexing(): boolean {
    return this.running !== null;
  }

  /** Resolves when the in-flight bulk index (if any) is finished. */
  async whenIdle(timeoutMs?: number): Promise<boolean> {
    if (!this.running) return true;
    if (timeoutMs === undefined) {
      await this.running.catch(() => undefined);
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>(res => { timer = setTimeout(() => res(false), timeoutMs); });
    const done = this.running.then(() => true, () => true);
    const result = await Promise.race([done, timedOut]);
    clearTimeout(timer);
    return result;
  }

  toRel(path: string): string {
    const rel = isAbsolute(path) ? relative(this.root, path) : path;
    return rel.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  /** Bring the whole index up to date. Concurrent calls share one run. */
  indexAll(opts: { force?: boolean } = {}): Promise<IndexResult> {
    if (this.running) return this.running;
    this.running = this.runIndexAll(opts).finally(() => {
      this.running = null;
      this.progress = { phase: 'idle', done: 0, total: 0 };
    });
    return this.running;
  }

  private async runIndexAll(opts: { force?: boolean }): Promise<IndexResult> {
    const start = performance.now();
    this.progress = { phase: 'scanning', done: 0, total: 0 };
    this.rules.invalidate();
    const scanned = await this.rules.scan();

    // A forced rebuild starts from an empty index so it can use the cold bulk path.
    if (opts.force) this.db.clearIndex();
    const known = new Map<string, FileRow>();
    for (const row of this.db.allFiles()) known.set(row.path, row);

    const tasks: FileTask[] = [];
    const seen = new Set<string>();
    for (const f of scanned) {
      seen.add(f.rel);
      const row = known.get(f.rel);
      if (!opts.force && row && row.mtime === f.mtime && row.size === f.size) continue;
      tasks.push({ abs: f.abs, rel: f.rel, knownHash: opts.force ? undefined : row?.hash });
    }

    let removed = 0;
    const gone = [...known.keys()].filter(p => !seen.has(p));
    if (gone.length) {
      this.db.transaction(() => {
        for (const p of gone) if (this.db.deleteFile(p)) removed++;
      });
      this.structureChanged = true;
    }

    const bulk = tasks.length >= BULK_THRESHOLD;
    const cold = known.size === 0;
    const writeBatch = bulk ? BULK_WRITE_BATCH : WRITE_BATCH;
    if (bulk) this.db.beginBulk(cold);

    this.progress = { phase: 'parsing', done: 0, total: tasks.length };
    let parsed = 0;
    let unchanged = 0;
    const touchedIds: number[] = [];
    let pending: FileResult[] = [];

    let writeMs = 0;
    const flush = (): void => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      const t0 = performance.now();
      this.db.transaction(() => {
        for (const r of batch) {
          const outcome = this.apply(r);
          if (outcome.parsed) { parsed++; touchedIds.push(outcome.fileId!); }
          else if (r.status === 'unchanged') unchanged++;
        }
      });
      writeMs += performance.now() - t0;
    };

    const onResult = (r: FileResult): void => {
      pending.push(r);
      this.progress.done++;
      if (pending.length >= writeBatch) flush();
    };

    const workerCount = this.workerCount(tasks.length);
    if (workerCount > 1) {
      await this.runPool(tasks, workerCount, onResult);
    } else {
      for (const task of tasks) {
        onResult(await processFile(this.parser, task, this.config.maxFileSize));
        // Yield so the MCP transport stays responsive during a cold index.
        if (this.progress.done % 25 === 0) await new Promise<void>(res => setImmediate(res));
      }
    }
    flush();
    const tBulk = performance.now();
    if (bulk) this.db.endBulk();
    const endBulkMs = performance.now() - tBulk;

    const parseDoneMs = performance.now() - start;
    this.progress.phase = 'finalizing';
    if (parsed > 0 || removed > 0 || this.structureChanged) {
      // New or removed files can change how *other* files' imports resolve.
      const full = removed > 0 || this.structureChanged || parsed > 200;
      resolveImports(this.db, full ? undefined : touchedIds);
      this.structureChanged = false;
      this.importsDirty.clear();
      try { this.db.db.exec('PRAGMA optimize'); } catch { /* ignore */ }
    }

    const result: IndexResult = {
      scanned: scanned.length,
      parsed,
      unchanged,
      removed,
      durationMs: Math.round(performance.now() - start),
      workers: workerCount,
    };
    if (process.env.CLAST_DEBUG) {
      console.error(`[clast] timing: total ${result.durationMs}ms, parse+write phase ${Math.round(parseDoneMs)}ms, db writes ${Math.round(writeMs)}ms, index build ${Math.round(endBulkMs)}ms`);
    }
    this.lastResult = result;
    this.db.setMeta('last_full_index', String(Date.now()));
    return result;
  }

  /** Write one processing result. Must run inside a transaction. */
  private apply(r: FileResult): { parsed: boolean; fileId?: number } {
    if (r.status === 'ok' && r.extraction) {
      const isNew = !this.db.fileByPath(r.rel);
      const fileId = this.db.writeFile({ path: r.rel, hash: r.hash, mtime: r.mtime, size: r.size }, r.extraction);
      if (isNew) this.structureChanged = true;
      return { parsed: true, fileId };
    }
    if (r.status === 'unchanged') {
      const row = this.db.fileByPath(r.rel);
      if (row) this.db.touchFile(row.id, r.mtime, r.size);
      return { parsed: false };
    }
    // skip / missing: make sure nothing stale remains.
    if (this.db.deleteFile(r.rel)) this.structureChanged = true;
    return { parsed: false };
  }

  private workerCount(taskCount: number): number {
    if (taskCount < WORKER_THRESHOLD) return 1;
    if (!existsSync(workerPath())) return 1;
    const configured = this.config.workers;
    if (configured === 1) return 1;
    const auto = Math.max(1, Math.min(12, availableParallelism() - 1));
    const n = configured > 0 ? configured : auto;
    return Math.max(1, Math.min(n, Math.ceil(taskCount / TASK_BATCH)));
  }

  private runPool(tasks: FileTask[], count: number, onResult: (r: FileResult) => void): Promise<void> {
    return new Promise<void>((resolveAll, rejectAll) => {
      let next = 0;
      let active = 0;
      let failed = false;
      const workers: Worker[] = [];

      const finish = (err?: Error): void => {
        if (failed) return;
        if (err) {
          failed = true;
          for (const w of workers) void w.terminate();
          rejectAll(err);
          return;
        }
        if (active === 0 && next >= tasks.length) {
          for (const w of workers) w.postMessage(null);
          resolveAll();
        }
      };

      const dispatch = (w: Worker): void => {
        if (next >= tasks.length) return finish();
        const batch = tasks.slice(next, next + TASK_BATCH);
        next += batch.length;
        active++;
        w.postMessage(batch);
      };

      for (let i = 0; i < count; i++) {
        const w = new Worker(workerPath(), { workerData: { maxFileSize: this.config.maxFileSize } });
        workers.push(w);
        w.on('message', (results: FileResult[]) => {
          active--;
          try {
            for (const r of results) onResult(r);
          } catch (err) {
            return finish(err as Error);
          }
          dispatch(w);
        });
        w.on('error', err => finish(err));
        // Two batches in flight per worker so it never idles while the main
        // thread is busy writing a transaction.
        dispatch(w);
        dispatch(w);
      }
    });
  }

  /**
   * Re-index a single file inline. Returns true if the index changed.
   * Accepts absolute or project-relative paths.
   */
  async indexFile(path: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const rel = this.toRel(path);
    if (rel.startsWith('..')) return false;
    const abs = join(this.root, rel);
    if (!this.rules.isSupported(rel) || this.rules.isIgnored(rel)) {
      return this.removeFile(rel);
    }
    const row = this.db.fileByPath(rel);
    const result = await processFile(
      this.parser,
      { abs, rel, knownHash: opts.force ? undefined : row?.hash },
      this.config.maxFileSize
    );
    let changed = false;
    let fileId: number | undefined;
    this.db.transaction(() => {
      const outcome = this.apply(result);
      changed = outcome.parsed || (result.status !== 'unchanged' && !!row);
      fileId = outcome.fileId;
    });
    if (fileId !== undefined) {
      if (this.structureChanged) {
        resolveImports(this.db);
        this.structureChanged = false;
      } else {
        resolveImports(this.db, [fileId]);
      }
    }
    return changed;
  }

  removeFile(path: string): boolean {
    const rel = this.toRel(path);
    let removed = false;
    this.db.transaction(() => {
      removed = this.db.deleteFile(rel);
    });
    return removed;
  }

  /**
   * Make sure the given indexed files reflect what is on disk right now
   * (cheap stat check, inline re-parse when stale). Query paths call this
   * before returning line numbers or source text.
   */
  async ensureFresh(paths: Iterable<string>): Promise<number> {
    let updated = 0;
    const seen = new Set<string>();
    for (const rel of paths) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const row = this.db.fileByPath(rel);
      if (!row) continue;
      let st;
      try {
        st = statSync(join(this.root, rel));
      } catch {
        if (this.removeFile(rel)) updated++;
        continue;
      }
      if (st.mtimeMs === row.mtime && st.size === row.size) continue;
      if (await this.indexFile(rel)) updated++;
    }
    return updated;
  }

  scan(): Promise<ScannedFile[]> {
    return this.rules.scan();
  }
}

function workerPath(): string {
  return fileURLToPath(new URL('./worker.js', import.meta.url));
}
