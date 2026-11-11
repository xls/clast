import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Extraction, FileRow, SymbolRow } from '../types.js';
import { ftsWords, splitIdentifier } from '../query/words.js';

/**
 * Bump whenever the schema or the extraction output changes shape. The index
 * is a cache: a version mismatch simply drops and rebuilds it.
 */
export const SCHEMA_VERSION = 4;

/** Kinds that get a full-text row (concept search). Others are found by name. */
const FTS_KINDS = new Set(['function', 'method', 'class', 'interface', 'struct', 'trait', 'enum', 'type', 'namespace', 'macro']);

type SqlValue = string | number | bigint | null | Uint8Array;

function loadSqlite(): typeof import('node:sqlite') {
  // node:sqlite prints an ExperimentalWarning on some Node versions; an MCP
  // server should not spam stderr with it.
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (msg && msg.includes('SQLite')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const require = createRequire(import.meta.url);
    return require('node:sqlite') as typeof import('node:sqlite');
  } catch (err) {
    throw new Error(
      `clast requires Node.js >= 22.13 (built-in node:sqlite). Current: ${process.version}. ${String(err)}`
    );
  } finally {
    process.emitWarning = original;
  }
}

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL,
    lang TEXT NOT NULL,
    line_count INTEGER NOT NULL DEFAULT 0,
    symbol_count INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL
  );

  CREATE TABLE symbols (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    name_lc TEXT NOT NULL,
    qname TEXT NOT NULL,
    kind TEXT NOT NULL,
    signature TEXT NOT NULL DEFAULT '',
    doc TEXT NOT NULL DEFAULT '',
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_col INTEGER NOT NULL DEFAULT 0,
    doc_line INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER,
    exported INTEGER NOT NULL DEFAULT 0
  );

  CREATE VIRTUAL TABLE symbols_fts USING fts5(
    words, sig, doc, path,
    content='', contentless_delete=1,
    tokenize='unicode61'
  );

  CREATE TABLE names (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);

  CREATE TABLE occ (
    name_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    lines TEXT NOT NULL,
    PRIMARY KEY (name_id, file_id)
  ) WITHOUT ROWID;

  CREATE TABLE calls (
    file_id INTEGER NOT NULL,
    caller_id INTEGER,
    name_id INTEGER NOT NULL,
    line INTEGER NOT NULL,
    receiver TEXT,
    count INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE imports (
    file_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    names TEXT NOT NULL DEFAULT '',
    line INTEGER NOT NULL,
    resolved_id INTEGER
  );

  CREATE TABLE heritage (
    symbol_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL
  );

  CREATE TABLE gen_docs (
    path TEXT NOT NULL,
    qname TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (path, qname)
  ) WITHOUT ROWID;
`;

/** Secondary indexes. Kept separate so a cold bulk load can build them at the end. */
const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
  CREATE INDEX IF NOT EXISTS idx_symbols_name_lc ON symbols(name_lc);
  CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id, start_line);
  CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_occ_file ON occ(file_id);
  CREATE INDEX IF NOT EXISTS idx_calls_name ON calls(name_id);
  CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id);
  CREATE INDEX IF NOT EXISTS idx_calls_file ON calls(file_id);
  CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
  CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_id) WHERE resolved_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_heritage_name ON heritage(name);
  CREATE INDEX IF NOT EXISTS idx_heritage_symbol ON heritage(symbol_id);
  CREATE INDEX IF NOT EXISTS idx_heritage_file ON heritage(file_id);
`;

const INDEX_NAMES = ['idx_symbols_name', 'idx_symbols_name_lc', 'idx_symbols_file', 'idx_symbols_parent', 'idx_occ_file', 'idx_calls_name', 'idx_calls_caller', 'idx_calls_file', 'idx_imports_file', 'idx_imports_resolved', 'idx_heritage_name', 'idx_heritage_symbol', 'idx_heritage_file'];

export const SYMBOL_COLUMNS =
  's.id, s.file_id, s.name, s.name_lc, s.qname, s.kind, s.signature, s.doc, s.start_line, s.end_line, ' +
  's.start_col, s.doc_line, s.parent_id, s.exported, f.path, f.lang';
export const SYMBOL_FROM = 'symbols s JOIN files f ON f.id = s.file_id';

export interface FileMeta {
  path: string;
  hash: string;
  mtime: number;
  size: number;
}

export class ClastDb {
  readonly db: DatabaseSync;
  readonly path: string;
  private stmts = new Map<string, StatementSync>();
  private nameIds = new Map<string, number>();
  /** Incremented on every write; lets query caches invalidate cheaply. */
  generation = 0;

  private constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
  }

  static open(dbPath: string): ClastDb {
    const sqlite = loadSqlite();
    const memory = dbPath === ':memory:';
    if (!memory) {
      const dir = dirname(dbPath);
      mkdirSync(dir, { recursive: true });
      // Keep the cache directory out of version control without touching the
      // user's .gitignore.
      const ignoreFile = join(dir, '.gitignore');
      if (!existsSync(ignoreFile)) {
        try { writeFileSync(ignoreFile, '*\n'); } catch { /* read-only dir */ }
      }
    }

    let raw = new sqlite.DatabaseSync(dbPath);
    let version = 0;
    try {
      const row = raw.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined;
      version = row ? Number(row.value) : 0;
    } catch {
      version = 0;
    }

    if (version !== SCHEMA_VERSION) {
      const hasTables =
        (raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get() as { n: number }).n > 0;
      if (hasTables && !memory) {
        // Old or foreign schema: the index is a cache, start over.
        raw.close();
        for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
        raw = new sqlite.DatabaseSync(dbPath);
      }
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec(SCHEMA);
      raw
        .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`)
        .run(String(SCHEMA_VERSION));
    }

    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.exec('PRAGMA temp_store = MEMORY');
    raw.exec('PRAGMA cache_size = -131072');
    raw.exec(INDEXES);
    raw.exec('PRAGMA mmap_size = 268435456');
    return new ClastDb(raw, dbPath);
  }

  close(): void {
    try {
      this.db.exec('PRAGMA optimize');
    } catch { /* ignore */ }
    this.stmts.clear();
    this.db.close();
  }

  /**
   * Bulk-load mode for large index runs: no fsync, no auto-checkpoint, and
   * (for a cold index) secondary indexes are built once at the end. The index
   * is a rebuildable cache, so durability is traded for speed here.
   */
  beginBulk(dropIndexes: boolean): void {
    this.db.exec('PRAGMA synchronous = OFF');
    this.db.exec('PRAGMA wal_autocheckpoint = 0');
    if (dropIndexes) {
      for (const name of INDEX_NAMES) this.db.exec(`DROP INDEX IF EXISTS ${name}`);
      this.stmts.clear();
    }
  }

  endBulk(): void {
    this.db.exec(INDEXES);
    try { this.db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('optimize')`); } catch { /* ignore */ }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.exec('PRAGMA wal_autocheckpoint = 1000');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('ANALYZE');
    this.stmts.clear();
  }

  // --- generic helpers -----------------------------------------------------

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      this.generation++;
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
  }

  // --- names ---------------------------------------------------------------

  nameId(name: string, create: boolean): number | undefined {
    const cached = this.nameIds.get(name);
    if (cached !== undefined) return cached;
    let id = this.get<{ id: number }>(`SELECT id FROM names WHERE name = ?`, name)?.id;
    if (id === undefined) {
      if (!create) return undefined;
      id = this.run(`INSERT INTO names (name) VALUES (?)`, name).lastInsertRowid;
    }
    if (this.nameIds.size > 400_000) this.nameIds.clear();
    this.nameIds.set(name, id);
    return id;
  }

  // --- files ---------------------------------------------------------------

  fileByPath(path: string): FileRow | undefined {
    return this.get<FileRow>(`SELECT * FROM files WHERE path = ?`, path);
  }

  fileById(id: number): FileRow | undefined {
    return this.get<FileRow>(`SELECT * FROM files WHERE id = ?`, id);
  }

  allFiles(): FileRow[] {
    return this.all<FileRow>(`SELECT * FROM files ORDER BY path`);
  }

  touchFile(id: number, mtime: number, size: number): void {
    this.run(`UPDATE files SET mtime = ?, size = ? WHERE id = ?`, mtime, size, id);
  }

  private clearFileData(fileId: number): void {
    this.run(`DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)`, fileId);
    this.run(`DELETE FROM symbols WHERE file_id = ?`, fileId);
    this.run(`DELETE FROM occ WHERE file_id = ?`, fileId);
    this.run(`DELETE FROM calls WHERE file_id = ?`, fileId);
    this.run(`DELETE FROM imports WHERE file_id = ?`, fileId);
    this.run(`DELETE FROM heritage WHERE file_id = ?`, fileId);
  }

  /** Remove a file and everything derived from it. Call inside a transaction. */
  deleteFile(path: string): boolean {
    const row = this.fileByPath(path);
    if (!row) return false;
    this.clearFileData(row.id);
    this.run(`UPDATE imports SET resolved_id = NULL WHERE resolved_id = ?`, row.id);
    this.run(`DELETE FROM files WHERE id = ?`, row.id);
    return true;
  }

  /**
   * Replace all indexed data for a file. Call inside a transaction.
   * Returns the file id.
   */
  writeFile(meta: FileMeta, ex: Extraction): number {
    const existing = this.fileByPath(meta.path);
    let fileId: number;
    const now = Date.now();
    if (existing) {
      fileId = existing.id;
      this.clearFileData(fileId);
      this.run(
        `UPDATE files SET hash = ?, mtime = ?, size = ?, lang = ?, line_count = ?, symbol_count = ?, indexed_at = ? WHERE id = ?`,
        meta.hash, meta.mtime, meta.size, ex.lang, ex.lineCount, ex.symbols.length, now, fileId
      );
    } else {
      fileId = this.run(
        `INSERT INTO files (path, hash, mtime, size, lang, line_count, symbol_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        meta.path, meta.hash, meta.mtime, meta.size, ex.lang, ex.lineCount, ex.symbols.length, now
      ).lastInsertRowid;
    }

    const insertSymbol = this.stmt(
      `INSERT INTO symbols (file_id, name, name_lc, qname, kind, signature, doc, start_line, end_line, start_col, doc_line, parent_id, exported)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFts = this.stmt(`INSERT INTO symbols_fts (rowid, words, sig, doc, path) VALUES (?, ?, ?, ?, ?)`);
    const pathWords = splitIdentifier(meta.path).join(' ');
    const ids: number[] = new Array(ex.symbols.length);
    for (let i = 0; i < ex.symbols.length; i++) {
      const s = ex.symbols[i]!;
      const parentId = s.parent >= 0 ? ids[s.parent] ?? null : null;
      const r = insertSymbol.run(
        fileId, s.name, s.name.toLowerCase(), s.qname, s.kind, s.signature, s.doc,
        s.startLine, s.endLine, s.startCol, s.docLine, parentId, s.exported ? 1 : 0
      );
      const id = Number(r.lastInsertRowid);
      ids[i] = id;
      if (FTS_KINDS.has(s.kind)) {
        insertFts.run(id, ftsWords(s.qname), ftsWords(s.signature), s.doc, pathWords);
      }
    }

    const insertOcc = this.stmt(`INSERT OR REPLACE INTO occ (name_id, file_id, lines) VALUES (?, ?, ?)`);
    for (const [name, lines] of ex.occ) {
      insertOcc.run(this.nameId(name, true)!, fileId, lines);
    }

    const insertCall = this.stmt(
      `INSERT INTO calls (file_id, caller_id, name_id, line, receiver, count) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const c of ex.calls) {
      insertCall.run(
        fileId, c.caller >= 0 ? ids[c.caller] ?? null : null, this.nameId(c.name, true)!, c.line, c.receiver, c.count
      );
    }

    const insertImport = this.stmt(`INSERT INTO imports (file_id, source, names, line) VALUES (?, ?, ?, ?)`);
    for (const im of ex.imports) {
      insertImport.run(fileId, im.source, im.names.join(','), im.line);
    }

    const insertHeritage = this.stmt(`INSERT INTO heritage (symbol_id, file_id, name, kind) VALUES (?, ?, ?, ?)`);
    for (const h of ex.heritage) {
      const sid = ids[h.symbol];
      if (sid !== undefined) insertHeritage.run(sid, fileId, h.name, h.kind);
    }

    return fileId;
  }

  // --- symbols -------------------------------------------------------------

  symbolById(id: number): SymbolRow | undefined {
    return this.get<SymbolRow>(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.id = ?`, id);
  }

  symbolsByName(name: string): SymbolRow[] {
    return this.all<SymbolRow>(`SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.name = ?`, name);
  }

  symbolsInFile(fileId: number): SymbolRow[] {
    return this.all<SymbolRow>(
      `SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM} WHERE s.file_id = ? ORDER BY s.start_line, s.end_line DESC`,
      fileId
    );
  }

  /** Innermost symbol containing a line in a file. */
  enclosingSymbol(fileId: number, line: number): SymbolRow | undefined {
    return this.get<SymbolRow>(
      `SELECT ${SYMBOL_COLUMNS} FROM ${SYMBOL_FROM}
       WHERE s.file_id = ? AND s.start_line <= ? AND s.end_line >= ?
       ORDER BY s.start_line DESC, s.end_line ASC LIMIT 1`,
      fileId, line, line
    );
  }

  /** Number of files that mention a name (cheap popularity signal). */
  refFileCount(name: string): number {
    const id = this.nameId(name, false);
    if (id === undefined) return 0;
    return this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM occ WHERE name_id = ?`, id)?.n ?? 0;
  }

  stats(): { files: number; symbols: number; calls: number; names: number; imports: number; lastIndexed: number | null } {
    const row = this.get<{ files: number; symbols: number; calls: number; names: number; imports: number; last: number | null }>(
      `SELECT (SELECT COUNT(*) FROM files) AS files,
              (SELECT COUNT(*) FROM symbols) AS symbols,
              (SELECT COUNT(*) FROM calls) AS calls,
              (SELECT COUNT(*) FROM names) AS names,
              (SELECT COUNT(*) FROM imports) AS imports,
              (SELECT MAX(indexed_at) FROM files) AS last`
    )!;
    return { files: row.files, symbols: row.symbols, calls: row.calls, names: row.names, imports: row.imports, lastIndexed: row.last };
  }
}
