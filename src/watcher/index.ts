import { watch, type FSWatcher } from 'chokidar';
import { extname } from 'node:path';
import { EventEmitter } from 'node:events';
import { getSupportedExtensions } from '../parser/languages.js';
import { buildIgnorePatterns } from './gitignore.js';
import type { ParserManager } from '../parser/index.js';
import type { ClastDatabase } from '../db/index.js';
import type { ClastConfig } from '../config/index.js';

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private projectRoot: string;
  private config: ClastConfig;
  private db: ClastDatabase;
  private parser: ParserManager;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _pendingCount = 0;
  private supportedExts: Set<string>;

  constructor(
    projectRoot: string,
    config: ClastConfig,
    db: ClastDatabase,
    parser: ParserManager
  ) {
    super();
    this.projectRoot = projectRoot;
    this.config = config;
    this.db = db;
    this.parser = parser;
    this.supportedExts = new Set(getSupportedExtensions(config.languages));
  }

  get isActive(): boolean {
    return this.watcher !== null;
  }

  get pendingCount(): number {
    return this._pendingCount;
  }

  start(): void {
    if (this.watcher) return;
    if (!this.config.watch.enabled) return;

    const ignoredPatterns = buildIgnorePatterns(this.projectRoot, this.config.ignoredPaths);

    this.watcher = watch(this.projectRoot, {
      ignored: [
        /(^|[/\\])\./,
        ...ignoredPatterns.map(p => {
          if (!p.includes('*') && !p.includes('/')) {
            return `**/${p}/**`;
          }
          return p;
        }),
      ],
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('add', path => this.handleFileChange(path));
    this.watcher.on('change', path => this.handleFileChange(path));
    this.watcher.on('unlink', path => this.handleFileDelete(path));
    this.watcher.on('error', err => {
      console.error('[clast] Watcher error:', err);
    });
  }

  stop(): void {
    if (!this.watcher) return;

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.watcher.close();
    this.watcher = null;
  }

  private handleFileChange(filePath: string): void {
    const ext = extname(filePath);
    if (!this.supportedExts.has(ext)) return;

    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    this._pendingCount++;
    this.debounceTimers.set(
      filePath,
      setTimeout(() => {
        this.debounceTimers.delete(filePath);
        this._pendingCount--;
        this.processFile(filePath);
      }, this.config.watch.debounceMs)
    );
  }

  private handleFileDelete(filePath: string): void {
    const ext = extname(filePath);
    if (!this.supportedExts.has(ext)) return;

    const existing = this.debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(filePath);
      this._pendingCount--;
    }

    try {
      this.parser.removeFile(filePath, this.projectRoot, this.db);
      this.emit('deleted', { filePath });
    } catch (err) {
      this.emit('error', { filePath, error: err as Error });
    }
  }

  private async processFile(filePath: string): Promise<void> {
    try {
      const parsed = await this.parser.incrementalUpdate(filePath, this.projectRoot, this.db);
      if (parsed) {
        const relPath = filePath.replace(/\\/g, '/');
        const nodes = this.db.queries.getNodesByFile(relPath);
        this.emit('indexed', { filePath, nodesFound: nodes.length });
      }
    } catch (err) {
      this.emit('error', { filePath, error: err as Error });
    }
  }
}
