import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ClastConfig } from '../config/index.js';

/**
 * Turns text into a vector that stands for its meaning. Two back ends:
 *  - "local": a model run on this machine with transformers.js (no data leaves it). The runtime is
 *    not a dependency of clast (it is several hundred megabytes); `clast-ai embeddings install` puts
 *    it into ~/.clast-ai/embeddings, and the model itself is downloaded on first use.
 *  - "endpoint": any OpenAI-compatible /embeddings API (Ollama, LM Studio, a hosted service).
 */
export interface Embedder {
  /** Identifies the model: vectors of different models must not be compared. */
  readonly id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const EMBED_HOME = join(homedir(), '.clast-ai', 'embeddings');
const RUNTIME = join(EMBED_HOME, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');

export function localRuntimeInstalled(): boolean {
  return existsSync(RUNTIME);
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

class LocalEmbedder implements Embedder {
  readonly id: string;
  private pipe: Promise<(texts: string[], opts: object) => Promise<{ dims: number[]; data: Float32Array }>> | null = null;

  constructor(private readonly model: string, private readonly device: string) {
    this.id = `local:${model}`;
  }

  private load(): NonNullable<LocalEmbedder['pipe']> {
    this.pipe ??= (async () => {
      const mod = (await import(pathToFileURL(RUNTIME).href)) as {
        pipeline: (task: string, model: string, opts: object) => Promise<never>;
        env: { cacheDir: string };
      };
      mod.env.cacheDir = join(homedir(), '.clast-ai', 'models');
      return mod.pipeline('feature-extraction', this.model, { dtype: this.device === 'cpu' ? 'q8' : 'fp32', device: this.device });
    })();
    return this.pipe;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const pipe = await this.load();
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    const dims = out.dims[1]!;
    const result: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) result.push(Float32Array.from(out.data.subarray(i * dims, (i + 1) * dims)));
    return result;
  }
}

class EndpointEmbedder implements Embedder {
  readonly id: string;

  constructor(private readonly endpoint: string, private readonly model: string, private readonly apiKey: string) {
    this.id = `endpoint:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/embeddings`, {
      method: 'POST', headers, body: JSON.stringify({ model: this.model, input: texts }), signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`embedding endpoint answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = (await response.json()) as { data: Array<{ index: number; embedding: number[] }> };
    const rows = [...data.data].sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length) throw new Error(`embedding endpoint returned ${rows.length} vectors for ${texts.length} texts`);
    return rows.map(r => normalize(Float32Array.from(r.embedding)));
  }
}

/** The embedder the configuration asks for, or a reason why there is none. */
export function createEmbedder(config: ClastConfig): { embedder: Embedder } | { error: string } {
  const e = config.embeddings;
  if (!e.enabled) {
    return { error: 'embeddings are off. Turn them on with {"embeddings": {"enabled": true}} in clast.config.json.' };
  }
  if (e.provider === 'endpoint') {
    if (!e.endpoint || !e.model) return { error: 'embeddings.provider is "endpoint" but embeddings.endpoint or embeddings.model is not set.' };
    return { embedder: new EndpointEmbedder(e.endpoint, e.model, e.apiKey) };
  }
  if (!localRuntimeInstalled()) {
    return { error: 'the local embedding runtime is not installed. Run once: clast-ai embeddings install (about 500 MB, plus the model on first use).' };
  }
  return { embedder: new LocalEmbedder(e.model, e.device) };
}
