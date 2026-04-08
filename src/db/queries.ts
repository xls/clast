import type { Database } from 'sql.js';
import type { FileRow, AstNodeRow, CallEdgeRow, CommentRow, StatusRow } from './types.js';

export class Queries {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  private run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as (string | number | null | Uint8Array)[]);
  }

  private get<T>(sql: string, params: unknown[] = []): T | undefined {
    const result = this.db.exec(sql, params as (string | number | null | Uint8Array)[]);
    if (result.length === 0 || result[0]!.values.length === 0) return undefined;
    const columns = result[0]!.columns;
    const values = result[0]!.values[0]!;
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]!] = values[i];
    }
    return obj as T;
  }

  private all<T>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params as (string | number | null | Uint8Array)[]);
    if (result.length === 0) return [];
    const columns = result[0]!.columns;
    return result[0]!.values.map(values => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]!] = values[i];
      }
      return obj as T;
    });
  }

  private getLastInsertId(): number {
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    if (result.length > 0 && result[0]!.values.length > 0) {
      return Number(result[0]!.values[0]![0]);
    }
    return 0;
  }

  // --- File operations ---

  upsertFile(filePath: string, hash: string, language: string, nodeCount: number): void {
    this.run(
      `INSERT OR REPLACE INTO files (file_path, hash, language, last_indexed, node_count)
       VALUES (?, ?, ?, ?, ?)`,
      [filePath, hash, language, Date.now(), nodeCount]
    );
  }

  deleteFile(filePath: string): void {
    // Manually cascade since sql.js foreign key cascade can be unreliable
    this.run(`DELETE FROM comments WHERE node_id IN (SELECT id FROM ast_nodes WHERE file_path = ?)`, [filePath]);
    this.run(`DELETE FROM call_edges WHERE caller_id IN (SELECT id FROM ast_nodes WHERE file_path = ?)`, [filePath]);
    this.run(`DELETE FROM call_edges WHERE callee_id IN (SELECT id FROM ast_nodes WHERE file_path = ?)`, [filePath]);
    this.run(`DELETE FROM ast_nodes WHERE file_path = ?`, [filePath]);
    this.run(`DELETE FROM files WHERE file_path = ?`, [filePath]);
  }

  getFileHash(filePath: string): string | null {
    const row = this.get<{ hash: string }>(`SELECT hash FROM files WHERE file_path = ?`, [filePath]);
    return row?.hash ?? null;
  }

  getAllFiles(): FileRow[] {
    return this.all<FileRow>(`SELECT * FROM files`);
  }

  // --- Node operations ---

  insertNode(node: Omit<AstNodeRow, 'id'>): number {
    this.run(
      `INSERT INTO ast_nodes (file_path, name, type, signature, start_line, end_line, start_col, end_col, parent_id, language, body_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        node.file_path, node.name, node.type, node.signature,
        node.start_line, node.end_line, node.start_col, node.end_col,
        node.parent_id, node.language, node.body_text,
      ]
    );
    return this.getLastInsertId();
  }

  insertNodes(nodes: Omit<AstNodeRow, 'id'>[]): number[] {
    const ids: number[] = [];
    this.run('BEGIN TRANSACTION');
    try {
      for (const node of nodes) {
        ids.push(this.insertNode(node));
      }
      this.run('COMMIT');
    } catch (err) {
      this.run('ROLLBACK');
      throw err;
    }
    return ids;
  }

  getNodeById(id: number): AstNodeRow | undefined {
    return this.get<AstNodeRow>(`SELECT * FROM ast_nodes WHERE id = ?`, [id]);
  }

  getNodeByName(name: string): AstNodeRow[] {
    return this.all<AstNodeRow>(
      `SELECT * FROM ast_nodes WHERE name = ? ORDER BY file_path, start_line`,
      [name]
    );
  }

  getNodesByFile(filePath: string): AstNodeRow[] {
    return this.all<AstNodeRow>(
      `SELECT * FROM ast_nodes WHERE file_path = ? ORDER BY start_line`,
      [filePath]
    );
  }

  searchNodes(query: string, type?: string, limit: number = 20): AstNodeRow[] {
    const pattern = `%${query}%`;
    if (type) {
      return this.all<AstNodeRow>(
        `SELECT * FROM ast_nodes WHERE name LIKE ? AND type = ? LIMIT ?`,
        [pattern, type, limit]
      );
    }
    return this.all<AstNodeRow>(
      `SELECT * FROM ast_nodes WHERE name LIKE ? LIMIT ?`,
      [pattern, limit]
    );
  }

  // --- Edge operations ---

  insertEdge(edge: Omit<CallEdgeRow, 'id'>): number {
    this.run(
      `INSERT INTO call_edges (caller_id, callee_id, callee_name, file_path, line)
       VALUES (?, ?, ?, ?, ?)`,
      [edge.caller_id, edge.callee_id, edge.callee_name, edge.file_path, edge.line]
    );
    return this.getLastInsertId();
  }

  insertEdges(edges: Omit<CallEdgeRow, 'id'>[]): void {
    this.run('BEGIN TRANSACTION');
    try {
      for (const edge of edges) {
        this.insertEdge(edge);
      }
      this.run('COMMIT');
    } catch (err) {
      this.run('ROLLBACK');
      throw err;
    }
  }

  getCallersOf(nameOrId: string | number, depth: number = 2): AstNodeRow[] {
    const whereClause = typeof nameOrId === 'number'
      ? 'callee_id = ?'
      : 'callee_name = ?';

    const sql = `
      WITH RECURSIVE caller_chain(id, depth) AS (
        SELECT caller_id, 1
        FROM call_edges
        WHERE ${whereClause}
        UNION
        SELECT ce.caller_id, cc.depth + 1
        FROM call_edges ce
        JOIN caller_chain cc ON ce.callee_id = cc.id
        WHERE cc.depth < ?
      )
      SELECT DISTINCT an.* FROM ast_nodes an
      JOIN caller_chain cc ON an.id = cc.id
      ORDER BY an.file_path, an.start_line
    `;
    return this.all<AstNodeRow>(sql, [nameOrId, depth]);
  }

  getCalleesOf(nameOrId: string | number, depth: number = 2): AstNodeRow[] {
    const whereClause = typeof nameOrId === 'number'
      ? 'an.id = ?'
      : 'an.name = ?';

    const sql = `
      WITH RECURSIVE callee_chain(id, name, depth) AS (
        SELECT ce.callee_id, ce.callee_name, 1
        FROM call_edges ce
        JOIN ast_nodes an ON ce.caller_id = an.id
        WHERE ${whereClause}
        UNION
        SELECT ce2.callee_id, ce2.callee_name, cc.depth + 1
        FROM call_edges ce2
        JOIN callee_chain cc ON ce2.caller_id = cc.id
        WHERE cc.depth < ? AND cc.id IS NOT NULL
      )
      SELECT DISTINCT an.* FROM ast_nodes an
      JOIN callee_chain cc ON an.id = cc.id
      WHERE cc.id IS NOT NULL
      ORDER BY an.file_path, an.start_line
    `;
    return this.all<AstNodeRow>(sql, [nameOrId, depth]);
  }

  getCallEdgesForNode(nodeId: number): { outgoing: CallEdgeRow[]; incoming: CallEdgeRow[] } {
    const outgoing = this.all<CallEdgeRow>(
      `SELECT * FROM call_edges WHERE caller_id = ?`,
      [nodeId]
    );
    const incoming = this.all<CallEdgeRow>(
      `SELECT * FROM call_edges WHERE callee_id = ?`,
      [nodeId]
    );
    return { outgoing, incoming };
  }

  // --- Comment operations ---

  insertComment(nodeId: number, text: string, source: 'original' | 'generated'): number {
    this.run(
      `INSERT INTO comments (node_id, text, source, generated_at)
       VALUES (?, ?, ?, ?)`,
      [nodeId, text, source, source === 'generated' ? Date.now() : null]
    );
    return this.getLastInsertId();
  }

  getCommentsForNode(nodeId: number): CommentRow[] {
    return this.all<CommentRow>(`SELECT * FROM comments WHERE node_id = ?`, [nodeId]);
  }

  deleteCommentsBySource(nodeId: number, source: 'original' | 'generated'): void {
    this.run(`DELETE FROM comments WHERE node_id = ? AND source = ?`, [nodeId, source]);
  }

  // --- Context (combined) ---

  getNodeWithContext(name: string): {
    nodes: AstNodeRow[];
    comments: CommentRow[];
    callers: AstNodeRow[];
    callees: AstNodeRow[];
  } {
    const nodes = this.getNodeByName(name);
    if (nodes.length === 0) {
      return { nodes: [], comments: [], callers: [], callees: [] };
    }

    const allComments: CommentRow[] = [];
    for (const node of nodes) {
      allComments.push(...this.getCommentsForNode(node.id));
    }

    const callers = this.getCallersOf(name, 1);
    const callees = this.getCalleesOf(name, 1);

    return { nodes, comments: allComments, callers, callees };
  }

  // --- Status ---

  getStatus(): StatusRow {
    const result = this.get<StatusRow>(`
      SELECT
        (SELECT COUNT(*) FROM files) as files_indexed,
        (SELECT COUNT(*) FROM ast_nodes) as total_nodes,
        (SELECT COUNT(*) FROM call_edges) as total_edges,
        (SELECT COUNT(*) FROM comments) as total_comments,
        (SELECT MAX(last_indexed) FROM files) as last_indexed
    `);
    return result ?? {
      files_indexed: 0,
      total_nodes: 0,
      total_edges: 0,
      total_comments: 0,
      last_indexed: null,
    };
  }

  // --- Bulk operations ---

  deleteNodesForFile(filePath: string): void {
    this.run(`DELETE FROM comments WHERE node_id IN (SELECT id FROM ast_nodes WHERE file_path = ?)`, [filePath]);
    this.run(`DELETE FROM call_edges WHERE caller_id IN (SELECT id FROM ast_nodes WHERE file_path = ?)`, [filePath]);
    this.run(`DELETE FROM ast_nodes WHERE file_path = ?`, [filePath]);
  }

  resolveEdges(): number {
    // Count unresolved before
    const before = this.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM call_edges WHERE callee_id IS NULL`
    );
    const beforeCount = before?.cnt ?? 0;

    this.run(`
      UPDATE call_edges
      SET callee_id = (
        SELECT an.id FROM ast_nodes an
        WHERE an.name = call_edges.callee_name
        LIMIT 1
      )
      WHERE callee_id IS NULL
    `);

    const after = this.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM call_edges WHERE callee_id IS NULL`
    );
    const afterCount = after?.cnt ?? 0;

    return beforeCount - afterCount;
  }

  getNodesWithoutComments(limit: number = 100): AstNodeRow[] {
    return this.all<AstNodeRow>(`
      SELECT an.* FROM ast_nodes an
      LEFT JOIN comments c ON an.id = c.node_id
      WHERE c.id IS NULL
        AND an.type IN ('function', 'method', 'class', 'interface', 'struct', 'trait')
      LIMIT ?
    `, [limit]);
  }

  /** Flush the in-memory database to a Uint8Array for saving to disk. */
  export(): Uint8Array {
    return this.db.export();
  }
}
