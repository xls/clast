import { watch, type FSWatcher } from 'chokidar';
import { basename, relative, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Indexer } from '../indexer/index.js';

/**
 * Watches the project and keeps the index current. Events are debounced per
 * file and processed strictly one at a time (the parser and database are not
 * re-entrant).
 */
export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: Array<{ rel: string; kind: 'change' | 'unlink' }> = [];
  private draining = false;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly indexer: Indexer,
    private readonly debounceMs: number
  ) {
    super();
  }

  get isActive(): boolean {
    return this.watcher !== null;
  }

  get pendingCount(): number {
    return this.timers.size + this.queue.length;
  }

  start(): void {
    if (this.watcher) return;
    const root = this.indexer.root;
    const rules = this.indexer.rules;

    this.watcher = watch(root, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: false,
      // Prune ignored directories early so huge trees (node_modules, build
      // output) are never even watched.
      ignored: (path: string, stats?: { isDirectory(): boolean; isFile(): boolean }) => {
        const rel = relative(root, path).split(sep).join('/');
        if (!rel || rel.startsWith('..')) return false;
        const name = basename(path);
        if (name === '.gitignore') return false;
        if (stats?.isFile()) return !rules.isSupported(rel) || rules.isIgnored(rel);
        if (stats?.isDirectory()) return name.startsWith('.') || rules.isIgnored(rel + '/x');
        return false;
      },
    });

    const toRel = (p: string): string => relative(root, p).split(sep).join('/');
    this.watcher.on('add', p => this.schedule(toRel(p), 'change'));
    this.watcher.on('change', p => this.schedule(toRel(p), 'change'));
    this.watcher.on('unlink', p => this.schedule(toRel(p), 'unlink'));
    this.watcher.on('unlinkDir', () => this.scheduleRescan());
    this.watcher.on('error', err => {
      this.emit('error', { filePath: '', error: err as Error });
    });
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.queue = [];
    const w = this.watcher;
    this.watcher = null;
    if (w) await w.close();
  }

  /** A changed .gitignore or a removed directory affects many files: rescan. */
  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.indexer.indexAll().catch(err => this.emit('error', { filePath: '', error: err as Error }));
    }, Math.max(this.debounceMs, 500));
  }

  private schedule(rel: string, kind: 'change' | 'unlink'): void {
    if (basename(rel) === '.gitignore') {
      this.scheduleRescan();
      return;
    }
    if (!this.indexer.rules.isSupported(rel)) return;
    const existing = this.timers.get(rel);
    if (existing) clearTimeout(existing);
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel);
        this.queue.push({ rel, kind });
        void this.drain();
      }, this.debounceMs)
    );
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      // Let a bulk index finish first; it will pick up these files anyway.
      await this.indexer.whenIdle();
      while (this.queue.length) {
        const { rel, kind } = this.queue.shift()!;
        try {
          if (kind === 'unlink') {
            if (this.indexer.removeFile(rel)) this.emit('deleted', { filePath: rel });
          } else if (await this.indexer.indexFile(rel)) {
            this.emit('indexed', { filePath: rel });
          }
        } catch (err) {
          this.emit('error', { filePath: rel, error: err as Error });
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
