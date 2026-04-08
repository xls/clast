import type { Queries } from '../db/queries.js';

/**
 * Resolves unresolved call edges in the database.
 *
 * After all files are parsed and nodes inserted, call edges may have
 * callee_id = null because the callee wasn't inserted yet. This resolver
 * attempts to match callee_name to ast_nodes.name.
 *
 * Resolution strategy (best-effort):
 * 1. Exact name match within the same file
 * 2. Exact name match across all files
 * 3. Leave unresolved if no match
 */
export function resolveCallEdges(queries: Queries): number {
  return queries.resolveEdges();
}
