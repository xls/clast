import { LlmClient } from './index.js';
import { buildFunctionCommentPrompt, buildClassCommentPrompt } from './prompts.js';
import type { ClastDb } from '../db/index.js';
import type { ClastConfig } from '../config/index.js';
import { CONTAINER_KINDS, type SymbolRow } from '../types.js';
import type { LineCache } from '../query/format.js';

/**
 * Generates documentation for undocumented symbols with an OpenAI-compatible
 * endpoint. Generated text is stored by (path, qualified name) so it survives
 * re-indexing of the file.
 */
export class CommentGenerator {
  private client: LlmClient;

  constructor(
    private readonly db: ClastDb,
    private readonly config: ClastConfig,
    private readonly lines: LineCache
  ) {
    this.client = new LlmClient(config.llm.endpoint, config.llm.model, config.llm.apiKey);
  }

  get isAvailable(): boolean {
    return this.client.isConfigured;
  }

  /** Previously generated doc for a symbol, if any. */
  stored(sym: SymbolRow): string | null {
    const row = this.db.get<{ text: string }>(
      `SELECT text FROM gen_docs WHERE path = ? AND qname = ?`, sym.path, sym.qname
    );
    return row?.text ?? null;
  }

  /**
   * Returns the doc for a symbol: the original comment when present (unless
   * alwaysGenerate), else a stored or freshly generated one. Null on failure.
   */
  async generate(sym: SymbolRow, force = false): Promise<string | null> {
    if (sym.doc && !this.config.llm.alwaysGenerate && !force) return sym.doc;
    if (!force) {
      const existing = this.stored(sym);
      if (existing) return existing;
    }
    if (!this.client.isConfigured) return null;

    let prompt: { system: string; user: string };
    if (CONTAINER_KINDS.has(sym.kind)) {
      const members = this.db
        .all<{ name: string }>(
          `SELECT name FROM symbols WHERE parent_id = ? AND kind IN ('method', 'function') LIMIT 60`, sym.id
        )
        .map(m => m.name);
      prompt = buildClassCommentPrompt(sym.name, sym.signature, members, sym.lang);
    } else {
      const src = this.lines.lines(sym.path);
      const body = src ? src.slice(sym.start_line - 1, Math.min(sym.end_line, sym.start_line + 80)).join('\n') : '';
      prompt = buildFunctionCommentPrompt(sym.signature, body, sym.lang);
    }

    try {
      const response = await this.client.complete([
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ]);
      const text = response.content.trim();
      if (!text) return null;
      this.db.run(
        `INSERT INTO gen_docs (path, qname, text, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(path, qname) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
        sym.path, sym.qname, text, Date.now()
      );
      return text;
    } catch (err) {
      console.error(`[clast] comment generation failed for ${sym.qname}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }
}
