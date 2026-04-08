import { z } from 'zod';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClastDatabase } from '../../db/index.js';
import type { ParserManager } from '../../parser/index.js';

export function registerReindexTool(
  server: McpServer,
  db: ClastDatabase,
  parser: ParserManager,
  projectRoot: string
): void {
  server.tool(
    'clast_reindex',
    'Force re-index a specific file or the entire repository. Use when the index seems stale or after large changes.',
    {
      filePath: z.string().optional().describe('Specific file to reindex (relative path). Omit to reindex the entire repo.'),
    },
    async ({ filePath }) => {
      if (filePath) {
        const absPath = join(projectRoot, filePath);
        const parsed = await parser.incrementalUpdate(absPath, projectRoot, db);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              file: filePath,
              reindexed: parsed,
              message: parsed ? 'File reindexed successfully' : 'File unchanged or unsupported',
            }),
          }],
        };
      }

      const result = await parser.fullIndex(projectRoot, db);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            filesProcessed: result.filesProcessed,
            nodesFound: result.nodesFound,
            edgesResolved: result.edgesResolved,
            durationMs: result.durationMs,
            message: `Full reindex completed in ${result.durationMs}ms`,
          }),
        }],
      };
    }
  );
}
