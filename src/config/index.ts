import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type ClastConfig } from './defaults.js';

const LlmConfigSchema = z.object({
  endpoint: z.string().default(DEFAULT_CONFIG.llm.endpoint),
  model: z.string().default(DEFAULT_CONFIG.llm.model),
  apiKey: z.string().default(DEFAULT_CONFIG.llm.apiKey),
  maxConcurrent: z.number().int().min(1).max(10).default(DEFAULT_CONFIG.llm.maxConcurrent),
  alwaysGenerate: z.boolean().default(DEFAULT_CONFIG.llm.alwaysGenerate),
});

const WatchConfigSchema = z.object({
  debounceMs: z.number().int().min(50).max(5000).default(DEFAULT_CONFIG.watch.debounceMs),
  enabled: z.boolean().default(DEFAULT_CONFIG.watch.enabled),
});

const ClastConfigSchema = z.object({
  languages: z.array(z.string()).default(DEFAULT_CONFIG.languages),
  ignoredPaths: z.array(z.string()).default(DEFAULT_CONFIG.ignoredPaths),
  dbPath: z.string().default(DEFAULT_CONFIG.dbPath),
  llm: LlmConfigSchema.default(DEFAULT_CONFIG.llm),
  watch: WatchConfigSchema.default(DEFAULT_CONFIG.watch),
  maxBodySize: z.number().int().min(100).max(50000).default(DEFAULT_CONFIG.maxBodySize),
});

export type { ClastConfig } from './defaults.js';

export function loadConfig(projectRoot: string): ClastConfig {
  const candidates = [
    join(projectRoot, 'clast.config.json'),
    join(projectRoot, '.claude', 'clast.config.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, 'utf-8'));
        return ClastConfigSchema.parse(raw) as ClastConfig;
      } catch (err) {
        console.error(`[clast] Failed to parse config at ${candidate}:`, err);
      }
    }
  }

  return ClastConfigSchema.parse({}) as ClastConfig;
}

export function resolveDbPath(projectRoot: string, config: ClastConfig): string {
  if (config.dbPath.startsWith('/') || config.dbPath.match(/^[a-zA-Z]:\\/)) {
    return config.dbPath;
  }
  return join(projectRoot, config.dbPath);
}
