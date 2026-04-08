import initSqlJs, { type Database } from 'sql.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { initializeSchema } from './schema.js';
import { Queries } from './queries.js';

export class ClastDatabase {
  private db: Database;
  private dbPath: string;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  public queries: Queries;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    initializeSchema(this.db);
    this.queries = new Queries(this.db);

    // Auto-save every 10 seconds
    this.saveTimer = setInterval(() => this.save(), 10000);
  }

  static async open(dbPath: string): Promise<ClastDatabase> {
    mkdirSync(dirname(dbPath), { recursive: true });

    const SQL = await initSqlJs();

    let db: Database;
    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    return new ClastDatabase(db, dbPath);
  }

  save(): void {
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
      console.error('[clast] Failed to save database:', err);
    }
  }

  close(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
    this.db.close();
  }

  get raw(): Database {
    return this.db;
  }
}

export { Queries } from './queries.js';
export type { FileRow, AstNodeRow, CallEdgeRow, CommentRow, StatusRow } from './types.js';
