import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClastDatabase } from '../../db/index.js';

export function registerFileSummaryTool(server: McpServer, db: ClastDatabase): void {
  server.tool(
    'clast_file_summary',
    'Get a structured summary of all symbols in a file, grouped by type (imports, classes, functions, exports, etc.). PREFER THIS over reading an entire file when you need to understand its structure — returns all symbols with line numbers without the noise of implementation details.',
    {
      filePath: z.string().describe('Relative file path (forward slashes, e.g. "src/parser/index.ts")'),
    },
    async ({ filePath }) => {
      // Normalize path
      const normalized = filePath.replace(/\\/g, '/');
      const nodes = db.queries.getNodesByFile(normalized);

      if (nodes.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `No indexed data for file "${normalized}". Try clast_reindex first.` }),
          }],
        };
      }

      // Group by type
      const grouped: Record<string, Array<{
        name: string;
        signature: string;
        startLine: number;
        endLine: number;
      }>> = {};

      for (const node of nodes) {
        const group = grouped[node.type] ??= [];
        group.push({
          name: node.name,
          signature: node.signature,
          startLine: node.start_line,
          endLine: node.end_line,
        });
      }

      const summary = {
        filePath: normalized,
        language: nodes[0]?.language,
        totalSymbols: nodes.length,
        symbols: grouped,
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2),
        }],
      };
    }
  );
}
