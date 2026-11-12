import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { FileWatcher } from '../src/watcher/index.js';
import { findSymbols } from '../src/query/resolve.js';

let p: Project;
let watcher: FileWatcher;

/** Wait for a watcher event that satisfies `match`, or fail after `ms`. */
function waitFor(event: string, match: (payload: { filePath: string }) => boolean, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}"`));
    }, ms);
    const onEvent = (payload: { filePath: string }): void => {
      if (!match(payload)) return;
      clearTimeout(timer);
      watcher.off(event, onEvent);
      resolve();
    };
    watcher.on(event, onEvent);
  });
}

before(async () => {
  p = await createProject();
  watcher = new FileWatcher(p.clast.indexer, 50);
  watcher.start();
  // Give the OS watcher a moment to arm before the first write.
  await new Promise(res => setTimeout(res, 400));
});

after(async () => {
  await watcher.stop();
  p.dispose();
});

describe('file watcher', () => {
  it('indexes new and changed files', async () => {
    assert.ok(watcher.isActive);
    const created = waitFor('indexed', e => e.filePath === 'src/watched.ts');
    p.write('src/watched.ts', `export function watchedOne(): number { return 1; }\n`);
    await created;
    assert.equal(findSymbols(p.clast.db, 'watchedOne').length, 1);

    const changed = waitFor('indexed', e => e.filePath === 'src/watched.ts');
    p.write('src/watched.ts', `export function watchedTwo(): number { return 2; }\n`);
    await changed;
    assert.equal(findSymbols(p.clast.db, 'watchedOne').length, 0);
    assert.equal(findSymbols(p.clast.db, 'watchedTwo').length, 1);
  });

  it('removes deleted files', async () => {
    const deleted = waitFor('deleted', e => e.filePath === 'src/watched.ts');
    p.remove('src/watched.ts');
    await deleted;
    assert.equal(findSymbols(p.clast.db, 'watchedTwo').length, 0);
    assert.equal(p.clast.db.fileByPath('src/watched.ts'), undefined);
  });

  it('ignores files excluded by .gitignore and unsupported types', async () => {
    p.write('ignored_dir/new.ts', `export function neverIndexed(): void {}\n`);
    p.write('notes.txt', `neverIndexed\n`);
    // A change that IS indexed marks the point where earlier events would have been processed.
    const marker = waitFor('indexed', e => e.filePath === 'src/marker.ts');
    p.write('src/marker.ts', `export const MARKER = 1;\n`);
    await marker;
    assert.equal(findSymbols(p.clast.db, 'neverIndexed').length, 0);
    assert.equal(p.clast.db.fileByPath('ignored_dir/new.ts'), undefined);
  });
});
