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

  constructor(root: string, config?: ClastConfig) {
    this.root = resolve(root);
    this.config = config ?? loadConfig(this.root);
    this.db = ClastDb.open(resolveDbPath(this.root, this.config));
    this.indexer = new Indexer(this.root, this.config, this.db);
  }

  close(): void {
    this.db.close();
  }
}
