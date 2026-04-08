import { LlmClient } from './index.js';
import { buildFunctionCommentPrompt, buildClassCommentPrompt } from './prompts.js';
import type { Queries } from '../db/queries.js';
import type { AstNodeRow } from '../db/types.js';
import type { ClastConfig } from '../config/index.js';

export class CommentGenerator {
  private client: LlmClient;
  private queries: Queries;
  private config: ClastConfig;

  constructor(client: LlmClient, queries: Queries, config: ClastConfig) {
    this.client = client;
    this.queries = queries;
    this.config = config;
  }

  get isAvailable(): boolean {
    return this.client.isConfigured;
  }

  /**
   * Generate a comment for a specific node.
   * Returns the generated comment text, or null if generation is disabled/failed.
   */
  async generateForNode(nodeId: number): Promise<string | null> {
    if (!this.client.isConfigured) return null;

    const node = this.queries.getNodeById(nodeId);
    if (!node) return null;

    // Check if original comment exists
    const existingComments = this.queries.getCommentsForNode(nodeId);
    const hasOriginal = existingComments.some(c => c.source === 'original');

    if (hasOriginal && !this.config.llm.alwaysGenerate) {
      // Original comment exists and we're not forcing generation
      return existingComments.find(c => c.source === 'original')?.text ?? null;
    }

    try {
      const prompt = this.buildPrompt(node);
      const response = await this.client.complete([
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ]);

      const comment = response.content.trim();
      if (!comment) return null;

      // Remove existing generated comment if any
      this.queries.deleteCommentsBySource(nodeId, 'generated');

      // Store the generated comment
      this.queries.insertComment(nodeId, comment, 'generated');

      return comment;
    } catch (err) {
      console.error(`[clast] Failed to generate comment for node ${nodeId}:`, err);
      return null;
    }
  }

  /**
   * Batch generate comments for nodes without any comments.
   * Returns counts of successes and failures.
   */
  async batchGenerate(
    limit: number = 100,
    onProgress?: (current: number, total: number) => void
  ): Promise<{ success: number; failed: number; skipped: number }> {
    if (!this.client.isConfigured) {
      return { success: 0, failed: 0, skipped: 0 };
    }

    const nodes = this.queries.getNodesWithoutComments(limit);
    let success = 0;
    let failed = 0;
    let skipped = 0;

    // Process with concurrency limit
    const concurrency = this.config.llm.maxConcurrent;
    const chunks = chunkArray(nodes, concurrency);

    let processed = 0;
    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map(node => this.generateForNode(node.id))
      );

      for (const result of results) {
        processed++;
        onProgress?.(processed, nodes.length);

        if (result.status === 'fulfilled') {
          if (result.value) {
            success++;
          } else {
            skipped++;
          }
        } else {
          failed++;
        }
      }
    }

    return { success, failed, skipped };
  }

  private buildPrompt(node: AstNodeRow): { system: string; user: string } {
    if (node.type === 'class' || node.type === 'interface' || node.type === 'struct' || node.type === 'trait') {
      // Get method names for context
      const children = this.queries.searchNodes(node.name, 'method', 50);
      const methodNames = children
        .filter(c => c.file_path === node.file_path)
        .map(c => c.name);

      return buildClassCommentPrompt(node.name, node.signature, methodNames, node.language);
    }

    return buildFunctionCommentPrompt(node.signature, node.body_text, node.language);
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
