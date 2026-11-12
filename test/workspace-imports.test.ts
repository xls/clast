import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { callGraph } from '../src/tools/search.js';
import { unused } from '../src/tools/impact.js';

// Found on a TypeScript monorepo: packages import each other by package name, and an index file
// re-exports the modules next to it. A widely used function showed no callers at all.
let p: Project;

before(async () => {
  p = await createProject({
    'package.json': `{ "name": "root", "private": true }`,
    'packages/llm/package.json': `{
  "name": "@acme/llm",
  "main": "lib/index.js",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }, "./brand": { "default": "./lib/brand.js" } }
}`,
    'packages/llm/src/index.ts': `
export * from './message.ts'
export class LlmRuntime {}
export default LlmRuntime
`,
    'packages/llm/src/message.ts': `
export function createToolResult(input: string): string { return input; }
`,
    'packages/llm/src/brand.ts': `
export function brandId(id: string): string { return id; }
`,
    'packages/tools/package.json': `{ "name": "@acme/tools", "main": "lib/index.js" }`,
    'packages/tools/src/batch.ts': `
import { createToolResult } from '@acme/llm'
import { brandId } from '@acme/llm/brand'
import { useMemo } from 'react'

export class Batch {
  commit(text: string): string { return createToolResult(brandId(text)); }
}

export function useBound(): unknown {
  return useMemo(function bindLocal() { return 1; }, []);
}

class Service { [Symbol.dispose](): void {} }
export const service = new Service();
export const batch = new Batch().commit('x');
`,
  });
});
after(() => p.dispose());

describe('monorepo packages', () => {
  it('resolves an import by package name to that package and follows its index re-exports', async () => {
    const out = await callGraph(p.ctx, { name: 'createToolResult', direction: 'callers' });
    assert.match(out, /callers \(1 resolved/);
    assert.match(out, /Batch\.commit {2}packages\/tools\/src\/batch\.ts:7/);
  });

  it('resolves a sub-path export', async () => {
    const out = await callGraph(p.ctx, { name: 'brandId', direction: 'callers' });
    assert.match(out, /Batch\.commit {2}packages\/tools\/src\/batch\.ts:7/);
  });

  it('does not take a named import for the default export of the index file', async () => {
    const out = await callGraph(p.ctx, { name: 'LlmRuntime', direction: 'callers' });
    assert.doesNotMatch(out, /Batch\.commit/);
  });
});

describe('dead code in framework-style TypeScript', () => {
  it('does not report named function expressions or computed member names', async () => {
    const out = await unused(p.ctx, {});
    assert.doesNotMatch(out, /bindLocal/);
    assert.doesNotMatch(out, /Symbol\.dispose/);
  });
});
