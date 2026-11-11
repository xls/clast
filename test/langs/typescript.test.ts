import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, heritageList, importList, occLines, sym, symbolList } from '../helpers.js';

const SRC = `
import { readFile } from 'node:fs';
import Base, { helper as h } from './base.js';
const fs = require('fs');

/** Maximum retries. */
export const MAX_RETRIES = 3;

export interface Shape {
  area(): number;
  name: string;
}

export type Id = string | number;

export enum Color { Red, Green = 'g' }

/**
 * A circle.
 */
export class Circle extends Base implements Shape {
  private radius = 1;
  static create = (r: number) => new Circle(r);

  constructor(r: number) { super(); this.radius = r; }

  // Compute the area.
  area(): number {
    return Math.PI * square(this.radius);
  }
}

function square(x: number): number { return x * x; }

export const double = (x: number) => square(x) + helper(x);

export default function main() {
  const local = 1;
  const inner = () => double(local);
  readFile('x', () => { const hidden = 2; });
  return inner();
}

namespace Util { export function clamp(v: number) { return v; } }
`;

describe('typescript extraction', () => {
  it('extracts symbols with qualified names and kinds', async () => {
    const ex = await extractSource('a.ts', SRC);
    assert.deepEqual(symbolList(ex), [
      'constant fs',
      'constant MAX_RETRIES',
      'interface Shape',
      'method Shape.area',
      'property Shape.name',
      'type Id',
      'enum Color',
      'constant Color.Red',
      'constant Color.Green',
      'class Circle',
      'property Circle.radius',
      'method Circle.create',
      'method Circle.constructor',
      'method Circle.area',
      'function square',
      'function double',
      'function main',
      'function main.inner',
      'namespace Util',
      'function Util.clamp',
    ]);
  });

  it('captures signatures, docs, export flags and ranges', async () => {
    const ex = await extractSource('a.ts', SRC);
    const circle = sym(ex, 'Circle');
    assert.equal(circle.signature, 'export class Circle extends Base implements Shape');
    assert.equal(circle.doc, 'A circle.');
    assert.equal(circle.exported, true);
    assert.ok(circle.docLine > 0);
    assert.ok(circle.docLine < circle.startLine);
    assert.equal(sym(ex, 'Circle.area').doc, 'Compute the area.');
    assert.equal(sym(ex, 'Circle.area').signature, 'area(): number');
    assert.equal(sym(ex, 'square').exported, false);
    assert.equal(sym(ex, 'MAX_RETRIES').doc, 'Maximum retries.');
    assert.equal(sym(ex, 'main').signature, 'export default function main()');
  });

  it('extracts calls attributed to the enclosing symbol', async () => {
    const ex = await extractSource('a.ts', SRC);
    const calls = callList(ex);
    assert.ok(calls.includes('Circle.area -> square'), `missing 'Circle.area -> square'`);
    assert.ok(calls.includes('double -> square'), `missing 'double -> square'`);
    assert.ok(calls.includes('double -> helper'), `missing 'double -> helper'`);
    assert.ok(calls.includes('Circle.create -> Circle'), `missing 'Circle.create -> Circle'`);
    assert.ok(calls.includes('main.inner -> double'), `missing 'main.inner -> double'`);
    assert.ok(calls.includes('main -> inner'), `missing 'main -> inner'`);
    assert.ok(calls.includes('main -> readFile'), `missing 'main -> readFile'`);
  });

  it('extracts imports and heritage', async () => {
    const ex = await extractSource('a.ts', SRC);
    assert.deepEqual(importList(ex), ['node:fs', './base.js', 'fs']);
    assert.deepEqual(ex.imports[1]!.names, ['Base', 'helper']);
    assert.deepEqual(heritageList(ex), ['Circle extends Base', 'Circle implements Shape']);
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('a.ts', SRC);
    assert.equal(occLines(ex, 'square').length, 3);
    assert.deepEqual(occLines(ex, 'Shape'), [9, 21]);
  });

  it('handles JSX components as calls and non-ASCII source', async () => {
    const ex = await extractSource('b.tsx', `// héllo wörld ☃\nexport function App() { return <Layout title="é"><Item /></Layout>; }\nfunction Item() { return <div/>; }`);
    assert.deepEqual(symbolList(ex), ['function App', 'function Item']);
    assert.deepEqual(callList(ex), ['App -> Layout', 'App -> Item']);
    assert.deepEqual(occLines(ex, 'Item'), [2, 3]);
  });
});
