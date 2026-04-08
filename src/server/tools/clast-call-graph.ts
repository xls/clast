import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClastDatabase } from '../../db/index.js';

export function registerCallGraphTool(server: McpServer, db: ClastDatabase): void {
  server.tool(
    'clast_call_graph',
    'Get the call graph for a function or method: what it calls (callees) and what calls it (callers). Use this BEFORE refactoring to understand impact — shows the full dependency chain with file paths and line numbers. Supports depth 1-5.',
    {
      name: z.string().describe('Function or method name to trace'),
      depth: z.number().int().min(1).max(5).default(2).describe('How many levels deep to traverse'),
      direction: z.enum(['callers', 'callees', 'both']).default('both').describe('Direction to traverse'),
    },
    async ({ name, depth, direction }) => {
      const node = db.queries.getNodeByName(name);
      if (node.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `No symbol found with name "${name}"` }),
          }],
        };
      }

      const result: Record<string, unknown> = {
        symbol: {
          name: node[0]!.name,
          type: node[0]!.type,
          filePath: node[0]!.file_path,
          startLine: node[0]!.start_line,
          endLine: node[0]!.end_line,
          signature: node[0]!.signature,
        },
      };

      if (direction === 'callers' || direction === 'both') {
        const callers = db.queries.getCallersOf(name, depth);
        result.callers = callers.map(n => ({
          name: n.name,
          type: n.type,
          filePath: n.file_path,
          startLine: n.start_line,
          signature: n.signature,
        }));
      }

      if (direction === 'callees' || direction === 'both') {
        const callees = db.queries.getCalleesOf(name, depth);
        result.callees = callees.map(n => ({
          name: n.name,
          type: n.type,
          filePath: n.file_path,
          startLine: n.start_line,
          signature: n.signature,
        }));
      }

      // Also include direct call edge details for the primary node
      if (node[0]) {
        const edges = db.queries.getCallEdgesForNode(node[0].id);
        result.directCalls = {
          outgoing: edges.outgoing.map(e => ({
            calleeName: e.callee_name,
            line: e.line,
            resolved: e.callee_id !== null,
          })),
          incoming: edges.incoming.map(e => ({
            callerId: e.caller_id,
            line: e.line,
          })),
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
