import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClastDatabase } from '../db/index.js';
import type { ParserManager } from '../parser/index.js';
import type { FileWatcher } from '../watcher/index.js';
import type { CommentGenerator } from '../llm/comment-generator.js';

import { registerSearchTool } from './tools/clast-search.js';
import { registerCallGraphTool } from './tools/clast-call-graph.js';
import { registerFileSummaryTool } from './tools/clast-file-summary.js';
import { registerGetContextTool } from './tools/clast-get-context.js';
import { registerStatusTool } from './tools/clast-status.js';
import { registerReindexTool } from './tools/clast-reindex.js';
import { registerCommentTool } from './tools/clast-comment.js';

export function registerAllTools(
  server: McpServer,
  db: ClastDatabase,
  parser: ParserManager,
  watcher: FileWatcher,
  commentGen: CommentGenerator,
  projectRoot: string
): void {
  registerSearchTool(server, db);
  registerCallGraphTool(server, db);
  registerFileSummaryTool(server, db);
  registerGetContextTool(server, db);
  registerStatusTool(server, db, watcher);
  registerReindexTool(server, db, parser, projectRoot);
  registerCommentTool(server, db, commentGen);
}
