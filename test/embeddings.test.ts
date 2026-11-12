import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, type Project } from './fixture.js';
import { embedAll, embeddingStatus, searchByMeaning } from '../src/embed/index.js';
import { search } from '../src/tools/search.js';

// A stand-in for an embedding model: an OpenAI-compatible endpoint whose vectors put words of the
// same meaning group in the same direction. It tests the plumbing, not the quality of a real model.
const GROUPS: string[][] = [
  ['greet', 'hello', 'welcome', 'salute'],
  ['retry', 'again', 'backoff', 'attempt', 'reschedule'],
  ['colour', 'color', 'hex', 'paint'],
];
function vector(text: string): number[] {
  const v = new Array<number>(GROUPS.length + 1).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    const g = GROUPS.findIndex(group => group.some(k => w.includes(k)));
    if (g >= 0) v[g]! += 1;
  }
  v[GROUPS.length] = 0.01;
  return v;
}

let server: Server;
let calls = 0;
let p: Project;

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const input = JSON.parse(body).input as string[];
      calls += input.length;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vector(t) })) }));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  p = await createProject({
    'src/a.ts': `
export function scheduleNextAttempt(delay: number): void { setTimeout(() => {}, delay * 2); }
export function sayHello(name: string): string { return 'hi ' + name; }
export function parseHex(text: string): number { return parseInt(text, 16); }
`,
    'test/a.test.ts': `export function helloFixture(): string { return 'hello'; }\n`,
  });
  p.ctx.clast.config.embeddings = {
    enabled: true, provider: 'endpoint', model: 'fake', device: 'cpu', endpoint: `http://127.0.0.1:${port}`, apiKey: '',
  };
});
after(async () => {
  p.dispose();
  await new Promise<void>(done => server.close(() => done()));
});

describe('search by meaning', () => {
  it('embeds every function once and reports coverage', async () => {
    const r = await embedAll(p.ctx);
    assert.equal(r.error, undefined);
    assert.equal(r.embedded, 4);
    assert.deepEqual(embeddingStatus(p.ctx), { model: 'endpoint:fake', have: 4, want: 4 });
  });

  it('embeds only what changed on the next run', async () => {
    const before = calls;
    const same = await embedAll(p.ctx);
    assert.equal(same.embedded, 0);
    assert.equal(calls, before);
    writeFileSync(join(p.root, 'src/a.ts'), `
export function scheduleNextAttempt(delay: number): void { setTimeout(() => {}, delay * 3); }
export function sayHello(name: string): string { return 'hi ' + name; }
`);
    await p.ctx.clast.indexer.indexAll();
    const changed = await embedAll(p.ctx);
    assert.equal(changed.embedded, 1);
    assert.equal(changed.removed, 1);
  });

  it('finds code that shares no word with the question', async () => {
    const hits = await searchByMeaning(p.ctx, 'try again later with backoff', 3, { includeTests: false });
    assert.equal(hits?.[0]?.sym.name, 'scheduleNextAttempt');
  });

  it('is merged into clast_search and marked, with tests left out', async () => {
    const out = await search(p.ctx, { query: 'welcome the visitor' });
    assert.match(out, /function sayHello {2}src\/a\.ts:\d+ {2}\[meaning\]/);
    assert.doesNotMatch(out, /helloFixture/);
    assert.match(out, /\[meaning\] = found by what the code is about/);
  });

  it('leaves search as it was when embeddings are off', async () => {
    p.ctx.clast.config.embeddings.enabled = false;
    const out = await search(p.ctx, { query: 'welcome the visitor' });
    assert.doesNotMatch(out, /\[meaning\]/);
    p.ctx.clast.config.embeddings.enabled = true;
  });
});
