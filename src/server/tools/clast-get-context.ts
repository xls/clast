import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClastDatabase } from '../../db/index.js';

export function registerGetContextTool(server: McpServer, db: ClastDatabase): void {
  server.tool(
    'clast_get_context',
    'Get full context for a symbol: definition, comments/documentation, callers, callees, and parent class. PREFER THIS over reading entire files when you need to understand a specific function or class before editing. Returns everything needed to make informed code changes.',
    {
      name: z.string().describe('Symbol name to look up'),
      includeBody: z.boolean().default(false).describe('Include the full function/class body text'),
    },
    async ({ name, includeBody }) => {
      const ctx = db.queries.getNodeWithContext(name);

      if (ctx.nodes.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `No symbol found with name "${name}"` }),
          }],
        };
      }

      const result = ctx.nodes.map(node => {
        const nodeComments = ctx.comments.filter(c => c.node_id === node.id);
        const entry: Record<string, unknown> = {
          name: node.name,
          type: node.type,
          filePath: node.file_path,
          location: `${node.file_path}:${node.start_line}-${node.end_line}`,
          signature: node.signature,
          language: node.language,
        };

        if (includeBody) {
          entry.body = node.body_text;
        }

        // Comments: prioritize original, also show generated
        const originalComment = nodeComments.find(c => c.source === 'original');
        const generatedComment = nodeComments.find(c => c.source === 'generated');

        if (originalComment) {
          entry.comment = originalComment.text;
          entry.commentSource = 'original';
        }
        if (generatedComment) {
          entry.generatedDescription = generatedComment.text;
        }

        // Parent (for methods inside classes)
        if (node.parent_id) {
          const parent = db.queries.getNodeById(node.parent_id);
          if (parent) {
            entry.parentClass = {
              name: parent.name,
              type: parent.type,
              filePath: parent.file_path,
              startLine: parent.start_line,
            };
          }
        }

        return entry;
      });

      // Callers and callees (deduplicated across all matching nodes)
      const callers = ctx.callers.map(n => ({
        name: n.name,
        type: n.type,
        filePath: n.file_path,
        startLine: n.start_line,
        signature: n.signature,
      }));

      const callees = ctx.callees.map(n => ({
        name: n.name,
        type: n.type,
        filePath: n.file_path,
        startLine: n.start_line,
        signature: n.signature,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            definitions: result,
            callers,
            callees,
          }, null, 2),
        }],
      };
    }
  );
}
