import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Extraction } from '../types.js';
import type { SourceParser } from '../parser/index.js';

export interface FileTask {
  abs: string;
  rel: string;
  /** Hash currently stored in the index, if any. */
  knownHash?: string;
}

export interface FileResult {
  rel: string;
  /**
   * ok: parsed, `extraction` is set. unchanged: content hash matches the index.
   * skip: not indexable (binary, too large, unsupported). missing: file is gone.
   */
  status: 'ok' | 'unchanged' | 'skip' | 'missing';
  hash: string;
  mtime: number;
  size: number;
  extraction?: Extraction;
}

/** Read, hash and (if changed) parse one file. Never throws. */
export async function processFile(
  parser: SourceParser,
  task: FileTask,
  maxFileSize: number
): Promise<FileResult> {
  const base = { rel: task.rel, hash: '', mtime: 0, size: 0 };
  let buf: Buffer;
  try {
    const st = statSync(task.abs);
    base.mtime = st.mtimeMs;
    base.size = st.size;
    if (!st.isFile()) return { ...base, status: 'missing' };
    if (st.size > maxFileSize) return { ...base, status: 'skip' };
    buf = readFileSync(task.abs);
  } catch {
    return { ...base, status: 'missing' };
  }

  // Binary sniff: NUL byte in the first block.
  const head = buf.subarray(0, 4096);
  if (head.includes(0)) return { ...base, status: 'skip' };

  base.hash = createHash('sha1').update(buf).digest('hex');
  if (task.knownHash && task.knownHash === base.hash) return { ...base, status: 'unchanged' };

  let source = buf.toString('utf-8');
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

  try {
    const extraction = await parser.extract(task.rel, source);
    if (!extraction) return { ...base, status: 'skip' };
    return { ...base, status: 'ok', extraction };
  } catch (err) {
    if (process.env.CLAST_DEBUG) console.error(`[clast] parse failed for ${task.rel}:`, err);
    return { ...base, status: 'skip' };
  }
}
