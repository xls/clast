import { parentPort, workerData } from 'node:worker_threads';
import { SourceParser } from '../parser/index.js';
import { processFile, type FileResult, type FileTask } from './process.js';

/**
 * Indexing worker: receives batches of files, reads + parses them, and posts
 * the extraction results back. The main thread owns the database.
 */
const { maxFileSize } = workerData as { maxFileSize: number };
const parser = new SourceParser();

if (parentPort) {
  const port = parentPort;
  port.on('message', async (tasks: FileTask[] | null) => {
    if (tasks === null) {
      process.exit(0);
    }
    const results: FileResult[] = [];
    for (const task of tasks) {
      results.push(await processFile(parser, task, maxFileSize));
    }
    port.postMessage(results);
  });
}
