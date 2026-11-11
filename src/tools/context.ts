import type { Clast } from '../engine.js';
import { LineCache } from '../query/format.js';
import { Resolver } from '../query/resolve.js';

/**
 * Per-engine state shared by all tool implementations.
 */
export class ToolContext {
  readonly lines: LineCache;
  private resolverGen = -1;
  private resolverCache: Resolver | null = null;
  /** How long a query waits for an in-flight bulk index before answering from a partial index. */
  waitMs = 8000;

  constructor(readonly clast: Clast) {
    this.lines = new LineCache(clast.root);
  }

  get db() {
    return this.clast.db;
  }

  get indexer() {
    return this.clast.indexer;
  }

  /** Resolver whose caches are valid for the current database generation. */
  get resolver(): Resolver {
    if (!this.resolverCache || this.resolverGen !== this.db.generation) {
      this.resolverCache = new Resolver(this.db);
      this.resolverGen = this.db.generation;
    }
    return this.resolverCache;
  }

  /**
   * Called at the start of every query tool. Waits briefly for a running
   * bulk index; returns a note to prepend when results may be incomplete.
   */
  async ready(): Promise<string> {
    if (!this.indexer.isIndexing) return '';
    const done = await this.indexer.whenIdle(this.waitMs);
    if (done) return '';
    const p = this.indexer.progress;
    return `note: index is still being built (${p.done}/${p.total} files parsed) - results may be incomplete; retry shortly.\n\n`;
  }

  /** Re-index any of these files that changed on disk since they were indexed. */
  async fresh(paths: Iterable<string>): Promise<void> {
    const list = [...paths];
    const updated = await this.indexer.ensureFresh(list);
    if (updated > 0) {
      for (const p of list) this.lines.invalidate(p);
    }
  }
}

/** Accept `"a"`, `["a", "b"]` or `"a, b"` for batched lookups. */
export function toList(value: string | string[] | undefined, splitCommas = false): string[] {
  if (value === undefined) return [];
  const arr = Array.isArray(value) ? value : splitCommas ? value.split(',') : [value];
  return arr.map(s => s.trim()).filter(Boolean);
}
