import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClastDatabase } from '../../db/index.js';
import type { FileWatcher } from '../../watcher/index.js';

export function registerStatusTool(
  server: McpServer,
  db: ClastDatabase,
  watcher: FileWatcher
): void {
  server.tool(
    'clast_status',
    'Show the current indexing status: files indexed, total symbols, total call edges, watcher state, and pending updates.',
    {},
    async () => {
      const status = db.queries.getStatus();

      const result = {
        filesIndexed: status.files_indexed,
        totalNodes: status.total_nodes,
        totalEdges: status.total_edges,
        totalComments: status.total_comments,
        lastIndexed: status.last_indexed
          ? new Date(status.last_indexed).toISOString()
          : null,
        watcherActive: watcher.isActive,
        pendingFiles: watcher.pendingCount,
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
