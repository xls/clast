import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { impact, unused } from '../src/tools/impact.js';

let p: Project;

before(async () => {
  p = await createProject({
    'src/shape.ts': `
export interface Shape { area(): number; }
export class Circle implements Shape {
  constructor(private r: number) {}
  area(): number { return Math.PI * this.r * this.r; }
}
export class Square implements Shape {
  constructor(private s: number) {}
  area(): number { return this.s * this.s; }
}
`,
    'src/report.ts': `
import { Circle, type Shape } from './shape';
export function total(shapes: Shape[]): number {
  let sum = 0;
  for (const s of shapes) sum += s.area();
  return sum;
}
export function describeAll(shapes: Shape[]): string { return 'total ' + total(shapes); }
export function demo(): string { return describeAll([new Circle(1)]); }
`,
    'src/dead.ts': `
import { Component } from 'some-ui-lib';
export function neverCalled(): number { return helperOfDead() + 1; }
function helperOfDead(): number { return 2; }
function recursiveOnly(n: number): number {
  if (n <= 0) return 0;
  return recursiveOnly(n - 1);
}
export function onlyTested(): number { return 3; }
export function namedInConfig(): number { return 4; }
// mentionedInComment is explained here, which does not make it used
export function mentionedInComment(): number { return 5; }
class Wrapper {
  constructor(private inner: { flush(): void }) {}
  flush(): void { this.inner.flush(); }
}
export const w = new Wrapper({ flush() {} });
export class Widget extends Component {
  componentDidMount(): void {}
  ownHelper(): void {}
}
export const widget = new Widget();
`,
    'src/main.ts': `
import { demo } from './report';
export function main(): void { console.log(demo()); }
main();
`,
    'config/handlers.json': `{ "handler": "namedInConfig" }\n`,
    'test/report.test.ts': `
import { total, describeAll } from '../src/report';
import { onlyTested } from '../src/dead';
function testTotal() { total([]); }
function testDescribe() { describeAll([]); }
function testDead() { onlyTested(); }
`,
    'test/shape.test.ts': `
import { Circle } from '../src/shape';
function testCircle() { new Circle(2).area(); }
`,
  });
});
after(() => p.dispose());

describe('clast_impact', () => {
  it('lists what changes together, the direct callers by file, and the tests', async () => {
    const out = await impact(p.ctx, { name: 'Shape.area' });
    assert.match(out, /change together .*\(2\):/);
    assert.match(out, /method Circle\.area/);
    assert.match(out, /method Square\.area/);
    assert.match(out, /direct callers: 1 resolved in 1 file/);
    assert.match(out, /src\/report\.ts: total :5/);
    assert.match(out, /tests to run/);
    assert.match(out, /test\/shape\.test\.ts {2}direct/);
  });

  it('follows callers of callers and finds the tests that reach a symbol indirectly', async () => {
    const out = await impact(p.ctx, { name: 'total' });
    assert.match(out, /src\/report\.ts: describeAll :8/);
    assert.match(out, /indirect callers .*: 2 functions in 2 files/);
    assert.match(out, /test\/report\.test\.ts {2}direct {2}\(testTotal, testDescribe\)/);
    const deep = await impact(p.ctx, { name: 'Circle.area' });
    // Circle.area is reached by total (through the interface), which test/report.test.ts calls.
    assert.match(deep, /test\/shape\.test\.ts {2}direct/);
    assert.match(deep, /test\/report\.test\.ts {2}via total/);
  });

  it('says so when no test reaches the symbol', async () => {
    const out = await impact(p.ctx, { name: 'demo' });
    assert.match(out, /tests: none found/);
  });
});

describe('clast_unused', () => {
  let out = '';
  before(async () => {
    out = await unused(p.ctx, {});
  });
  const sure = (): string => out.split(/\n(?:probably unused|used only by tests|no code reference|not judged|limits)/)[0]!;

  it('reports unreferenced code and what only it uses', () => {
    assert.match(sure(), /function neverCalled {2}:3 {2}exported/);
    assert.match(sure(), /function helperOfDead {2}:4 {2}\(used only by unused neverCalled\)/);
  });

  it('does not count recursion as a use', () => {
    assert.match(sure(), /function recursiveOnly {2}:5-8/);
  });

  it('reports a class nothing constructs or names', () => {
    assert.match(sure(), /class Square {2}:7-10 {2}exported/);
  });

  it('keeps used code out', () => {
    for (const name of ['total', 'describeAll', 'demo', 'Circle', 'Shape', 'area', 'main']) {
      assert.doesNotMatch(out, new RegExp(`(function|method|class|interface) (\\w+\\.)?${name}  `), name);
    }
  });

  it('treats a method that forwards to another object as a user of that name, not as its own definition', () => {
    assert.doesNotMatch(out, /Wrapper\.flush/);
  });

  it('separates code used only by tests and names found in strings or config', () => {
    assert.match(out, /used only by tests \(1, 1 lines\):\nsrc\/dead\.ts .*\n {2}function onlyTested/);
    assert.match(out, /no code reference, but the name appears .*\(1;/);
    assert.match(out, /function namedInConfig {2}:10 {2}exported {2}<- config\/handlers\.json:1/);
  });

  it('ignores mentions in comment lines', () => {
    assert.match(sure(), /function mentionedInComment/);
  });

  it('does not judge methods of classes that extend a library type', () => {
    assert.doesNotMatch(out, /componentDidMount|ownHelper/);
    assert.match(out, /not judged: .*2 subclasses of library types and their methods/);
  });

  it('can leave exported symbols out and narrow by path', async () => {
    const priv = await unused(p.ctx, { exported: false });
    assert.doesNotMatch(priv, /neverCalled/);
    assert.match(priv, /function recursiveOnly/);
    const other = await unused(p.ctx, { path: 'src/report.ts' });
    assert.match(other, /^unused code: 0 symbols/);
  });
});
