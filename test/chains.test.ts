import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { findSymbols } from '../src/query/resolve.js';
import { callersOf, calleesOf } from '../src/query/callgraph.js';
import { directSubtypes } from '../src/query/hierarchy.js';
import { callGraph, getContext } from '../src/tools/search.js';

const FILES: Record<string, string> = {
  'src/builder.ts': `export class Product {
  constructor(readonly items: string[]) {}
  run(): void {}
}

export class Builder {
  private items: string[] = [];
  add(x: string): Builder { this.items.push(x); return this; }
  build(): Product { return new Product(this.items); }
}

export function make(): Builder { return new Builder(); }
`,
  // An unrelated class with the same method names: chains must not land here.
  'src/other.ts': `export class Queue {
  add(x: number): void {}
  run(): void {}
  build(): void {}
}
`,
  'src/main.ts': `import { Builder, make } from './builder.js';
import { Queue as JobQueue } from './other.js';

export function viaFactory(): void {
  make().add('a').add('b').build().run();
}

export function viaConstructor(): void {
  new Builder().add('c').build().run();
}

export function untyped(thing: any): void {
  thing.run();
}

export class Jobs extends JobQueue {
  flush(): void { this.run(); }
}

export function useAlias(): void {
  const q = new JobQueue();
  q.add(1);
}
`,
  'lib/app.js': `function createApp() { return {}; }
module.exports = createApp;
`,
  'lib/server.js': `const app = require('./app');
const { helper: h } = require('./util');

function start() {
  h();
  return app();
}
module.exports = start;
`,
  'lib/util.js': `exports.helper = function helper() {};
`,
};

let p: Project;
before(async () => {
  p = await createProject(FILES);
});
after(() => p.dispose());

const one = (ref: string) => {
  const s = findSymbols(p.clast.db, ref)[0];
  assert.ok(s, `symbol ${ref}`);
  return s;
};
const callerNames = (ref: string, opts: { certainOnly?: boolean } = {}): string[] => [
  ...new Set(
    callersOf(p.clast.db, p.ctx.resolver, one(ref))
      .filter(c => !opts.certainOnly || c.certain)
      .map(c => c.caller?.qname ?? '<file>')
  ),
].sort();

describe('call chains and return types', () => {
  it('reads return types off signatures', () => {
    assert.equal(one('Builder.add').ret, 'Builder');
    assert.equal(one('Builder.build').ret, 'Product');
    assert.equal(one('make').ret, 'Builder');
    assert.equal(one('Product.run').ret, null);
  });

  it('types each link of a chain from the previous call', () => {
    // make() -> Builder; .add() -> Builder; .build() -> Product; .run() is Product.run, not Queue.run.
    assert.deepEqual(callerNames('Product.run', { certainOnly: true }), ['viaConstructor', 'viaFactory']);
    assert.deepEqual(callerNames('Builder.build', { certainOnly: true }), ['viaConstructor', 'viaFactory']);
    assert.deepEqual(callerNames('Builder.add', { certainOnly: true }), ['viaConstructor', 'viaFactory']);
  });

  it('does not attribute typed chains to same-named methods elsewhere', () => {
    const queueRun = callersOf(p.clast.db, p.ctx.resolver, one('Queue.run'));
    assert.deepEqual(queueRun.filter(c => c.certain).map(c => c.caller?.qname), ['Jobs.flush']);
    // The untyped call is kept as a possible caller, clearly marked.
    const weak = queueRun.filter(c => c.weak).map(c => c.caller?.qname);
    assert.deepEqual(weak, ['untyped']);
    assert.ok(!queueRun.some(c => c.caller?.qname === 'viaFactory'));
  });

  it('lists unknown-receiver call sites separately in the tools', async () => {
    const text = await callGraph(p.ctx, { name: 'Product.run', direction: 'callers' });
    assert.match(text, /callers \(2 resolved, 1 on receivers of unknown type/);
    assert.match(text, /untyped {2}src\/main\.ts:13 {2}\? \(receiver type unknown\)/);
    const ctxText = await getContext(p.ctx, { name: 'Product.run' });
    assert.match(ctxText, /callers \(2 resolved, 1 on receivers of unknown type\)/);
  });

  it('resolves callees through the chain', () => {
    const callees = calleesOf(p.clast.db, p.ctx.resolver, one('viaFactory'));
    const targets = callees.filter(c => c.target && c.certain).map(c => c.target!.qname).sort();
    assert.deepEqual(targets, ['Builder.add', 'Builder.build', 'Product.run', 'make']);
  });
});

describe('import aliases and default exports', () => {
  it('follows `import { X as Y }` for inheritance and constructor calls', () => {
    const subs = directSubtypes(p.clast.db, p.ctx.resolver, one('Queue'));
    assert.deepEqual(subs.map(s => s.sym.qname), ['Jobs']);
    assert.ok(subs[0]!.certain);
    assert.deepEqual(callerNames('Queue', { certainOnly: true }), ['useAlias']);
    // q = new JobQueue() types q through the alias as well.
    assert.deepEqual(callerNames('Queue.add', { certainOnly: true }), ['useAlias']);
  });

  it('links require() bindings to module.exports and destructured members', () => {
    assert.deepEqual(callerNames('createApp', { certainOnly: true }), ['start']);
    assert.deepEqual(callerNames('lib/util.js:helper', { certainOnly: true }), ['start']);
    // require bindings are imports, not symbols of the importing file.
    assert.equal(findSymbols(p.clast.db, 'lib/server.js:app').length, 0);
  });
});
