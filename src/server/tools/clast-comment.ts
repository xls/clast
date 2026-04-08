import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClastDatabase } from '../../db/index.js';
import type { CommentGenerator } from '../../llm/comment-generator.js';

export function registerCommentTool(
  server: McpServer,
  db: ClastDatabase,
  commentGen: CommentGenerator
): void {
  server.tool(
    'clast_comment',
    'Get or generate documentation comments for a symbol. By default returns existing comments. Set generate=true to create a new comment via LLM if none exists.',
    {
      name: z.string().describe('Symbol name to get/generate comment for'),
      generate: z.boolean().default(false).describe('If true and no comment exists, generate one via LLM'),
    },
    async ({ name, generate }) => {
      const nodes = db.queries.getNodeByName(name);
      if (nodes.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `No symbol found with name "${name}"` }),
          }],
        };
      }

      const results = [];
      for (const node of nodes) {
        const comments = db.queries.getCommentsForNode(node.id);
        const original = comments.find(c => c.source === 'original');
        const generated = comments.find(c => c.source === 'generated');

        const entry: Record<string, unknown> = {
          name: node.name,
          type: node.type,
          filePath: node.file_path,
          startLine: node.start_line,
        };

        if (original) {
          entry.comment = original.text;
          entry.source = 'original';
        } else if (generated) {
          entry.comment = generated.text;
          entry.source = 'generated';
        } else if (generate) {
          if (!commentGen.isAvailable) {
            entry.error = 'LLM not configured. Set llm.model in clast.config.json.';
          } else {
            const result = await commentGen.generateForNode(node.id);
            if (result) {
              entry.comment = result;
              entry.source = 'generated';
            } else {
              entry.error = 'Failed to generate comment';
            }
          }
        } else {
          entry.comment = null;
          entry.source = null;
        }

        results.push(entry);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(results, null, 2),
        }],
      };
    }
  );
}
