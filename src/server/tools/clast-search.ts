import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClastDatabase } from '../../db/index.js';

export function registerSearchTool(server: McpServer, db: ClastDatabase): void {
  server.tool(
    'clast_search',
    'Search the pre-built AST index for functions, classes, methods, and other symbols by name pattern. PREFER THIS over grep/file search when looking for symbol definitions — it is faster and returns structured results with exact file paths, line numbers, and signatures.',
    {
      query: z.string().describe('Search pattern (matches against symbol names, supports partial matches)'),
      type: z.enum([
        'function', 'method', 'class', 'interface', 'enum',
        'import', 'export', 'variable', 'type_alias', 'struct', 'trait', 'module',
      ]).optional().describe('Filter by symbol type'),
      limit: z.number().int().min(1).max(100).default(20).describe('Maximum results to return'),
    },
    async ({ query, type, limit }) => {
      const results = db.queries.searchNodes(query, type, limit);

      const formatted = results.map(n => ({
        name: n.name,
        type: n.type,
        filePath: n.file_path,
        startLine: n.start_line,
        endLine: n.end_line,
        signature: n.signature,
        language: n.language,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(formatted, null, 2),
        }],
      };
    }
  );
}
