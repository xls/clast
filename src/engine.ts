import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, resolveDbPath, type ClastConfig } from './config/index.js';
import { ClastDb } from './db/index.js';
import { Indexer } from './indexer/index.js';

/**
 * One indexed project: configuration, database and indexer. Shared by the MCP
 * server, the CLI and tests.
 */
export class Clast {
  readonly root: string;
  readonly config: ClastConfig;
  readonly db: ClastDb;
  readonly indexer: Indexer;
  /** Run when the engine closes: other files kept open next to the index (the embedding store). */
  readonly closers: Array<() => void> = [];

  constructor(root: string, config?: ClastConfig) {
    this.root = resolve(root);
    if (!existsSync(this.root) || !statSync(this.root).isDirectory()) {
      throw new Error(`project root does not exist or is not a directory: ${this.root}`);
    }
    this.config = config ?? loadConfig(this.root);
    this.db = ClastDb.open(resolveDbPath(this.root, this.config));
    this.indexer = new Indexer(this.root, this.config, this.db);
  }

  close(): void {
    for (const c of this.closers.splice(0)) {
      try { c(); } catch { /* already closed */ }
    }
    this.db.close();
  }
}
