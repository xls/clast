import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DEFAULT_CONFIG, type ClastConfig } from './defaults.js';

const LlmConfigSchema = z.object({
  endpoint: z.string().default(DEFAULT_CONFIG.llm.endpoint),
  model: z.string().default(DEFAULT_CONFIG.llm.model),
  apiKey: z.string().default(DEFAULT_CONFIG.llm.apiKey),
  maxConcurrent: z.number().int().min(1).max(10).default(DEFAULT_CONFIG.llm.maxConcurrent),
  alwaysGenerate: z.boolean().default(DEFAULT_CONFIG.llm.alwaysGenerate),
});

const WatchConfigSchema = z.object({
  debounceMs: z.number().int().min(20).max(5000).default(DEFAULT_CONFIG.watch.debounceMs),
  enabled: z.boolean().default(DEFAULT_CONFIG.watch.enabled),
});

const EmbeddingsConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.embeddings.enabled),
  provider: z.enum(['local', 'endpoint']).default(DEFAULT_CONFIG.embeddings.provider),
  model: z.string().default(DEFAULT_CONFIG.embeddings.model),
  device: z.string().default(DEFAULT_CONFIG.embeddings.device),
  endpoint: z.string().default(DEFAULT_CONFIG.embeddings.endpoint),
  apiKey: z.string().default(DEFAULT_CONFIG.embeddings.apiKey),
});

const ClastConfigSchema = z.object({
  languages: z.array(z.string()).default(DEFAULT_CONFIG.languages),
  ignoredPaths: z.array(z.string()).default(DEFAULT_CONFIG.ignoredPaths),
  respectGitignore: z.boolean().default(DEFAULT_CONFIG.respectGitignore),
  dbPath: z.string().default(DEFAULT_CONFIG.dbPath),
  maxFileSize: z.number().int().min(1000).max(100_000_000).default(DEFAULT_CONFIG.maxFileSize),
  maxFiles: z.number().int().min(100).max(5_000_000).default(DEFAULT_CONFIG.maxFiles),
  workers: z.number().int().min(0).max(64).default(DEFAULT_CONFIG.workers),
  llm: LlmConfigSchema.default(DEFAULT_CONFIG.llm),
  watch: WatchConfigSchema.default(DEFAULT_CONFIG.watch),
  embeddings: EmbeddingsConfigSchema.default(DEFAULT_CONFIG.embeddings),
});

export type { ClastConfig } from './defaults.js';

export function parseConfig(raw: unknown): ClastConfig {
  return ClastConfigSchema.parse(raw ?? {}) as ClastConfig;
}

export function loadConfig(projectRoot: string): ClastConfig {
  const candidates = [
    join(projectRoot, 'clast.config.json'),
    join(projectRoot, '.claude', 'clast.config.json'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf-8'));
      // The pre-0.2 default pointed at a sql.js database; never reuse that file name.
      if (raw && raw.dbPath === '.clast/clast.db') delete raw.dbPath;
      return parseConfig(raw);
    } catch (err) {
      console.error(`[clast] Ignoring invalid config at ${candidate}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return parseConfig({});
}

export function resolveDbPath(projectRoot: string, config: ClastConfig): string {
  // CLAST_DB_PATH overrides the configured location (useful for CI caches and experiments).
  const override = process.env.CLAST_DB_PATH;
  if (override) return override === ':memory:' || isAbsolute(override) ? override : join(projectRoot, override);
  if (config.dbPath === ':memory:' || isAbsolute(config.dbPath)) return config.dbPath;
  return join(projectRoot, config.dbPath);
}
