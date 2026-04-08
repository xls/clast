import type { Database } from 'sql.js';

const SCHEMA_VERSION = 1;

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS _clast_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    file_path TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    language TEXT NOT NULL,
    last_indexed INTEGER NOT NULL,
    node_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS ast_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    signature TEXT NOT NULL DEFAULT '',
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_col INTEGER NOT NULL,
    end_col INTEGER NOT NULL,
    parent_id INTEGER,
    language TEXT NOT NULL,
    body_text TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (file_path) REFERENCES files(file_path) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES ast_nodes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_name ON ast_nodes(name);
  CREATE INDEX IF NOT EXISTS idx_nodes_type ON ast_nodes(type);
  CREATE INDEX IF NOT EXISTS idx_nodes_file ON ast_nodes(file_path);
  CREATE INDEX IF NOT EXISTS idx_nodes_name_type ON ast_nodes(name, type);

  CREATE TABLE IF NOT EXISTS call_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_id INTEGER NOT NULL,
    callee_id INTEGER,
    callee_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    FOREIGN KEY (caller_id) REFERENCES ast_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (callee_id) REFERENCES ast_nodes(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_edges_caller ON call_edges(caller_id);
  CREATE INDEX IF NOT EXISTS idx_edges_callee ON call_edges(callee_id);
  CREATE INDEX IF NOT EXISTS idx_edges_callee_name ON call_edges(callee_name);

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('original', 'generated')),
    generated_at INTEGER,
    FOREIGN KEY (node_id) REFERENCES ast_nodes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_comments_node ON comments(node_id);
`;

export function initializeSchema(db: Database): void {
  db.run('PRAGMA foreign_keys = ON');

  const currentVersion = getSchemaVersion(db);

  if (currentVersion < SCHEMA_VERSION) {
    // sql.js doesn't support multi-statement exec with CREATE TABLE IF NOT EXISTS well,
    // so we split and execute each statement
    const statements = CREATE_TABLES.split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      db.run(stmt);
    }
    setSchemaVersion(db, SCHEMA_VERSION);
  }
}

function getSchemaVersion(db: Database): number {
  try {
    const result = db.exec(
      `SELECT value FROM _clast_meta WHERE key = 'schema_version'`
    );
    if (result.length > 0 && result[0]!.values.length > 0) {
      return parseInt(String(result[0]!.values[0]![0]), 10);
    }
    return 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(db: Database, version: number): void {
  db.run(
    `INSERT OR REPLACE INTO _clast_meta (key, value) VALUES ('schema_version', ?)`,
    [String(version)]
  );
}
