#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';

import { loadConfig, resolveDbPath } from '../config/index.js';
import { ClastDatabase } from '../db/index.js';
import { ParserManager } from '../parser/index.js';
import { FileWatcher } from '../watcher/index.js';
import { LlmClient } from '../llm/index.js';
import { CommentGenerator } from '../llm/comment-generator.js';
import { registerAllTools } from './register-tools.js';

async function main() {
  // Determine project root
  const projectRoot = resolve(
    process.env.CLAST_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd()
  );

  console.error(`[clast] Project root: ${projectRoot}`);

  // Load configuration
  const config = loadConfig(projectRoot);
  console.error(`[clast] Config loaded. Languages: ${config.languages.join(', ')}`);

  // Open database (async — sql.js uses WASM)
  const dbPath = resolveDbPath(projectRoot, config);
  console.error(`[clast] Database: ${dbPath}`);
  const db = await ClastDatabase.open(dbPath);

  // Create parser (async — web-tree-sitter uses WASM)
  const parser = new ParserManager(config);
  await parser.init();

  // Create watcher
  const watcher = new FileWatcher(projectRoot, config, db, parser);

  // Create LLM client + comment generator
  const llmClient = new LlmClient(config.llm.endpoint, config.llm.model, config.llm.apiKey);
  const commentGen = new CommentGenerator(llmClient, db.queries, config);

  if (llmClient.isConfigured) {
    console.error(`[clast] LLM configured: ${config.llm.model} @ ${config.llm.endpoint}`);
  } else {
    console.error('[clast] LLM not configured (comment generation disabled)');
  }

  // Create MCP server
  const server = new McpServer({
    name: 'clast',
    version: '0.1.0',
  });

  // Register all tools
  registerAllTools(server, db, parser, watcher, commentGen, projectRoot);

  // Perform initial index
  console.error('[clast] Starting initial index...');
  const indexResult = await parser.fullIndex(projectRoot, db, (file, current, total) => {
    if (current % 50 === 0 || current === total) {
      console.error(`[clast] Indexing: ${current}/${total} files`);
    }
  });
  console.error(
    `[clast] Index complete: ${indexResult.filesProcessed} files, ` +
    `${indexResult.nodesFound} nodes, ${indexResult.edgesResolved} edges resolved ` +
    `(${indexResult.durationMs}ms)`
  );

  // Start file watcher
  watcher.start();
  watcher.on('indexed', ({ filePath, nodesFound }: { filePath: string; nodesFound: number }) => {
    console.error(`[clast] Updated: ${filePath} (${nodesFound} nodes)`);
  });
  watcher.on('deleted', ({ filePath }: { filePath: string }) => {
    console.error(`[clast] Removed: ${filePath}`);
  });
  watcher.on('error', ({ filePath, error }: { filePath: string; error: Error }) => {
    console.error(`[clast] Error processing ${filePath}:`, error.message);
  });

  if (watcher.isActive) {
    console.error('[clast] File watcher active');
  }

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[clast] MCP server running on stdio');

  // Graceful shutdown
  const shutdown = () => {
    console.error('[clast] Shutting down...');
    watcher.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[clast] Fatal error:', err);
  process.exit(1);
});
