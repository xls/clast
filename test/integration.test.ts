import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, type Project } from './fixture.js';
import { searchSymbols } from '../src/query/search.js';
import { findSymbols } from '../src/query/resolve.js';
import { callersOf, calleesOf } from '../src/query/callgraph.js';
import { callGraph, getContext, hierarchy, search } from '../src/tools/search.js';
import { changes, fileSummary, grep, overview, references, reindex, status } from '../src/tools/explore.js';

let p: Project;

before(async () => {
  p = await createProject();
});
after(() => p.dispose());

const names = (rows: Array<{ qname: string }>): string[] => rows.map(r => r.qname);

describe('indexing', () => {
  it('indexes supported files and honours ignore rules', () => {
    const paths = p.clast.db.allFiles().map(f => f.path);
    assert.ok(paths.includes('src/math/area.ts'));
    assert.ok(paths.includes('tools/report.py'));
    assert.ok(!paths.some(x => x.startsWith('ignored_dir/')), '.gitignore directory');
    assert.ok(!paths.includes('src/schema.gen.ts'), '.gitignore glob');
    assert.ok(!paths.some(x => x.startsWith('node_modules/')), 'default ignores');
  });

  it('is incremental: a second run parses nothing', async () => {
    const r = await p.clast.indexer.indexAll();
    assert.equal(r.parsed, 0);
    assert.equal(r.removed, 0);
  });

  it('resolves relative imports to files', () => {
    const rows = p.clast.db.all<{ source: string; target: string | null }>(
      `SELECT i.source, t.path AS target FROM imports i JOIN files f ON f.id = i.file_id
       LEFT JOIN files t ON t.id = i.resolved_id WHERE f.path = 'src/shapes/circle.ts' ORDER BY i.line`
    );
    assert.deepEqual(rows.map(r => r.target), ['src/math/area.ts', 'src/shapes/shape.ts']);
    const py = p.clast.db.get<{ target: string | null }>(
      `SELECT t.path AS target FROM imports i JOIN files f ON f.id = i.file_id
       LEFT JOIN files t ON t.id = i.resolved_id WHERE f.path = 'tools/report.py'`
    );
    assert.equal(py?.target, 'tools/util.py');
  });
});

describe('search', () => {
  const top = (q: string, opts = {}): string[] => names(searchSymbols(p.clast.db, q, opts).hits.map(h => h.sym));

  it('ranks exact matches first and production code above tests', () => {
    assert.equal(top('circleArea')[0], 'circleArea');
    assert.equal(top('main')[0], 'main');
  });

  it('matches prefixes, sub-words, substrings and abbreviations', () => {
    assert.equal(top('cylinder')[0], 'cylinderVolume');
    assert.equal(top('volume')[0], 'cylinderVolume');
    assert.ok(top('Circ').includes('Circle'));
    assert.equal(top('cylVol')[0], 'cylinderVolume');
    assert.equal(top('mkCircle')[0], 'makeCircle');
  });

  it('understands qualified names', () => {
    assert.equal(top('Circle.area')[0], 'Circle.area');
    assert.equal(top('Report.render')[0], 'Report.render');
  });

  it('finds symbols by words in docs and signatures', () => {
    assert.equal(top('human readable description')[0], 'BaseShape.describe');
    assert.equal(top('format single row')[0], 'format_row');
  });

  it('applies kind, path and language filters', () => {
    assert.deepEqual(top('square', { kind: 'class' }), ['Square']);
    assert.deepEqual(top('square', { path: 'src/ui', kind: 'function' }), ['square']);
    assert.ok(top('render', { lang: 'python' }).every(n => n.startsWith('Report')));
  });

  it('renders compact text with signature and doc', async () => {
    const text = await search(p.ctx, { query: 'circleArea' });
    assert.match(text, /function circleArea {2}src\/math\/area\.ts:2-4/);
    assert.match(text, /export function circleArea\(radius: number\): number/);
    assert.match(text, /\/\/ Area of a circle\./);
  });

  it('runs several queries in one call and reports misses', async () => {
    const text = await search(p.ctx, { query: ['makeCircle', 'zzzNoSuchThing'] });
    assert.match(text, /"makeCircle": 1 match/);
    assert.match(text, /"zzzNoSuchThing": no symbols found/);
  });
});

describe('call graph', () => {
  const one = (ref: string) => {
    const s = findSymbols(p.clast.db, ref)[0];
    assert.ok(s, `symbol ${ref}`);
    return s;
  };

  it('finds callers across files, including constructor calls', () => {
    const callers = callersOf(p.clast.db, p.ctx.resolver, one('circleArea'));
    assert.deepEqual(
      callers.map(c => c.caller?.qname).sort(),
      ['Circle.area', 'cylinderVolume', 'testMain']
    );
    assert.ok(callers.every(c => c.certain));
    const ctor = callersOf(p.clast.db, p.ctx.resolver, one('Circle'));
    assert.deepEqual(ctor.map(c => c.caller?.qname), ['makeCircle']);
  });

  it('disambiguates same-named functions using imports and file proximity', () => {
    const mathSquare = one('src/math/area.ts:square');
    const uiSquare = one('src/ui/layout.ts:square');
    assert.deepEqual(
      callersOf(p.clast.db, p.ctx.resolver, mathSquare).map(c => c.caller?.qname).sort(),
      ['Square.area', 'circleArea']
    );
    assert.deepEqual(
      callersOf(p.clast.db, p.ctx.resolver, uiSquare).map(c => c.caller?.qname),
      ['resetLayout']
    );
  });

  it('resolves this.method() through the class hierarchy', () => {
    const callees = calleesOf(p.clast.db, p.ctx.resolver, one('BaseShape.describe'));
    const targets = callees.filter(c => c.target).map(c => c.target!.qname);
    assert.ok(targets.includes('BaseShape.format'));
    // this.area() is abstract here; the implementation family is resolved, not dropped.
    assert.ok(targets.some(t => t.endsWith('.area')));
  });

  it('treats interface methods, overrides and implementations as one target', () => {
    const callers = callersOf(p.clast.db, p.ctx.resolver, one('Circle.area'));
    assert.ok(callers.some(c => c.caller?.qname === 'BaseShape.describe'));
  });

  it('resolves python self calls and module functions', () => {
    const callers = callersOf(p.clast.db, p.ctx.resolver, one('format_row'));
    assert.deepEqual(callers.map(c => c.caller?.qname), ['Report.render_row']);
    const callees = calleesOf(p.clast.db, p.ctx.resolver, one('Report.render'));
    assert.ok(callees.some(c => c.target?.qname === 'Report.render_row'));
  });

  it('renders a transitive caller tree', async () => {
    const text = await callGraph(p.ctx, { name: 'src/math/area.ts:square', direction: 'callers', depth: 3 });
    assert.match(text, /circleArea {2}src\/math\/area\.ts:3/);
    assert.match(text, /cylinderVolume {2}src\/math\/volume\.ts:5/);
    assert.match(text, /main {2}src\/app\.ts:10/);
    assert.ok(!text.includes('resetLayout'), 'unrelated square() callers must not leak in');
  });
});

describe('tools', () => {
  it('get_context returns exact source, callers and callees', async () => {
    const text = await getContext(p.ctx, { name: 'cylinderVolume' });
    assert.match(text, /function cylinderVolume {2}src\/math\/volume\.ts:4-6/);
    assert.match(text, /3\| \/\*\* Volume of a cylinder\. \*\//);
    assert.match(text, /5\| {3}return circleArea\(radius\) \* height;/);
    assert.match(text, /callers \(1 resolved\):\n {2}main {2}src\/app\.ts:10/);
    assert.ok(!text.includes('referenced without a call'), 'import lines are not value references');
    assert.match(text, /calls \(1\):\n {2}circleArea {2}src\/math\/area\.ts:2-4/);
  });

  it('get_context shows hierarchy for classes and suggests on misses', async () => {
    const text = await getContext(p.ctx, { name: 'BaseShape' });
    assert.match(text, /inherits: implements Shape \(src\/shapes\/shape\.ts:1\)/);
    assert.match(text, /subtypes \(2 direct\):/);
    assert.match(text, /Circle {2}src\/shapes\/circle\.ts:4/);
    const miss = await getContext(p.ctx, { name: 'circlArea' });
    assert.match(miss, /no symbol with this name/);
    assert.match(miss, /circleArea/);
  });

  it('get_context links a method to its interface / override twins', async () => {
    const text = await getContext(p.ctx, { name: 'Circle.area' });
    assert.match(text, /same method on related types \(2; callers are shared\)/);
    assert.match(text, /Shape\.area {2}src\/shapes\/shape\.ts:2/);
    assert.match(text, /callers \(1 resolved\):\n {2}BaseShape\.describe/);
  });

  it('hierarchy lists transitive subtypes and method families', async () => {
    const types = await hierarchy(p.ctx, { name: 'Shape' });
    assert.match(types, /subtypes \(3, transitive\):\n {2}class BaseShape {2}src\/shapes\/shape\.ts:6\n {4}class Circle/);
    const up = await hierarchy(p.ctx, { name: 'Circle', direction: 'supertypes' });
    assert.match(up, /extends BaseShape {2}src\/shapes\/shape\.ts:6-17\n {4}implements Shape/);
    const method = await hierarchy(p.ctx, { name: 'BaseShape.area' });
    assert.match(method, /implementations on related types \(3\)/);
    assert.match(method, /method Square\.area/);
  });

  it('call_graph answers for names that are not defined in the project', async () => {
    const text = await callGraph(p.ctx, { name: 'toFixed' });
    assert.match(text, /"toFixed" is not defined in this project/);
    assert.match(text, /BaseShape\.format {2}src\/shapes\/shape\.ts:15/);
  });

  it('search tolerates typos, initials and abbreviations', async () => {
    const text = await search(p.ctx, { query: ['cylnderVolume', 'cv', 'mkCirc'] });
    assert.match(text, /"cylnderVolume": 1 match\nfunction cylinderVolume/);
    assert.match(text, /"cv": 1 match\nfunction cylinderVolume/);
    assert.match(text, /"mkCirc": 1 match\nfunction makeCircle/);
    assert.match(await search(p.ctx, { query: 'x', kind: 'bogus' }), /unknown kind "bogus"\. Valid kinds: function, method/);
  });

  it('get_context supports batching and path:line addressing', async () => {
    const text = await getContext(p.ctx, { name: ['makeCircle', 'src/math/area.ts:7'], includeCalls: false });
    assert.match(text, /function makeCircle/);
    assert.match(text, /function square {2}src\/math\/area\.ts:6-8/);
  });

  it('references lists usages with enclosing symbols', async () => {
    const text = await references(p.ctx, { name: 'DEFAULT_RADIUS' });
    assert.match(text, /"DEFAULT_RADIUS": 3 reference lines in 1 file/);
    assert.match(text, /\[def\] export const DEFAULT_RADIUS = 2;/);
    assert.match(text, /\[main\] const shapes/);
  });

  it('file_summary outlines files, imports and importers', async () => {
    const text = await fileSummary(p.ctx, { path: 'shape.ts' });
    assert.match(text, /src\/shapes\/shape\.ts {2}\(typescript, \d+ lines, \d+ symbols\)/);
    assert.match(text, /imported by \(2\): src\/shapes\/circle\.ts, src\/shapes\/square\.ts/);
    assert.match(text, /6-17\s+export abstract class BaseShape implements Shape/);
    assert.match(text, /10-12\s+describe\(\): string {2}\/\/ Human readable description\./);
  });

  it('file_summary outlines directories and reports ambiguity', async () => {
    const dir = await fileSummary(p.ctx, { path: 'src/shapes' });
    assert.match(dir, /src\/shapes\/ {2}\(3 indexed files/);
    assert.match(dir, /circle\.ts {2}\(\d+ lines\): Circle, makeCircle/);
    const ambiguous = await fileSummary(p.ctx, { path: 'square' });
    assert.match(ambiguous, /matches|src\/shapes\/square\.ts/);
  });

  it('overview maps the project', async () => {
    const text = await overview(p.ctx);
    assert.match(text, /files, \d+ lines, \d+ symbols/);
    assert.match(text, /languages: typescript 8 files/);
    assert.match(text, /src\//);
    assert.match(text, /entry points:\n {2}main {2}src\/app\.ts:7/);
  });

  it('grep finds text and labels the enclosing symbol', async () => {
    const text = await grep(p.ctx, { pattern: 'prints the cylinder' });
    assert.match(text, /1 matching line in 1 file/);
    assert.match(text, /\[main\] console\.log\(cylinderVolume/);
    const re = await grep(p.ctx, { pattern: 'def \\w+_row', regex: true });
    assert.match(re, /2 matching lines in 2 files/);
    assert.match(await grep(p.ctx, { pattern: 'nothing-like-this' }), /no matches/);
  });

  it('status reports counts', async () => {
    const text = await status(p.ctx);
    assert.match(text, /index: 10 files/);
    assert.match(text, /languages: typescript 8, python 2/);
  });
});

describe('freshness', () => {
  it('re-indexes a changed file on demand so lines and source are exact', async () => {
    const before = await getContext(p.ctx, { name: 'makeCircle', includeCalls: false });
    assert.match(before, /src\/shapes\/circle\.ts:14-16/);
    const original = p.clast.db.fileByPath('src/shapes/circle.ts');
    p.write(
      'src/shapes/circle.ts',
      `// header comment\n// another line\n` + (await import('./fixture.js')).FIXTURE['src/shapes/circle.ts']!
    );
    // No reindex call: the query itself notices the stale file.
    const after = await getContext(p.ctx, { name: 'makeCircle', includeCalls: false });
    assert.match(after, /src\/shapes\/circle\.ts:16-18/);
    assert.match(after, /16\| export function makeCircle/);
    assert.notEqual(p.clast.db.fileByPath('src/shapes/circle.ts')!.hash, original!.hash);
  });

  it('skips re-parsing when only the mtime changed', async () => {
    const abs = join(p.root, 'src/math/area.ts');
    const future = new Date(statSync(abs).mtimeMs + 5000);
    utimesSync(abs, future, future);
    const r = await p.clast.indexer.indexAll();
    assert.equal(r.parsed, 0);
    assert.equal(r.unchanged, 1);
  });

  it('picks up new and deleted files on rescan', async () => {
    p.write('src/extra.ts', `export function brandNewHelper(): number { return 1; }\n`);
    p.remove('src/ui/layout.ts');
    const text = await reindex(p.ctx, {});
    assert.match(text, /parsed 1, removed 1/);
    assert.equal(findSymbols(p.clast.db, 'brandNewHelper').length, 1);
    assert.equal(findSymbols(p.clast.db, 'resetLayout').length, 0);
    assert.equal(p.clast.db.all(`SELECT 1 FROM calls c WHERE c.file_id NOT IN (SELECT id FROM files)`).length, 0);
  });

  it('single-file reindex handles removal', async () => {
    p.write('src/temp.ts', `export function temporary(): void {}\n`);
    assert.match(await reindex(p.ctx, { path: 'src/temp.ts' }), /reindexed src\/temp\.ts: 1 symbol/);
    p.remove('src/temp.ts');
    assert.match(await reindex(p.ctx, { path: 'src/temp.ts' }), /not indexable/);
    assert.equal(findSymbols(p.clast.db, 'temporary').length, 0);
  });
});

describe('changes', () => {
  it('maps a git diff to symbols, callers and tests', async t => {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: p.root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      git('init', '-q');
      git('add', '-A');
      git('-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    } catch {
      t.skip('git not available');
      return;
    }
    p.write(
      'src/math/area.ts',
      `/** Area of a circle. */
export function circleArea(radius: number): number {
  const r = Math.abs(radius);
  return Math.PI * square(r);
}

export function square(x: number): number {
  return x * x;
}
`
    );
    const text = await changes(p.ctx, {});
    assert.match(text, /changes vs HEAD: 1 file, 1 symbol touched/);
    assert.match(text, /function circleArea {2}:2-5/);
    assert.match(text, /circleArea <- /);
    assert.match(text, /cylinderVolume/);
    assert.match(text, /tests exercising changed symbols \(1\):\n {2}src\/app\.test\.ts/);
  });
});
