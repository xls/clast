import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { match } from '../src/tools/match.js';

let p: Project;

before(async () => {
  p = await createProject({
    'src/api.ts': `
export async function load(url: string) {
  const a = await fetch(url);
  const b = await fetch(url, { method: 'POST' });
  const c = await fetch(url,
    { method: 'PUT' },   // layout and comments do not matter
  );
  // fetch(url) in a comment is not a call
  const s = "fetch(url) in a string is not a call";
  if (a == null) { return null; }
  if (b == null) {
    log('b');
    return null;
  }
  return same(a, a) || same(a, b);
}
function same(x: unknown, y: unknown) { return x === y; }
function log(m: string) { console.log(m); }
`,
    'src/Service.java': `
class Service {
  void run() {
    try { work(); } catch (IOException e) { }
    try { work(); } catch (IOException e) { /* ignored */ }
    try { work(); } catch (IOException e) { log(e); }
    Thread.sleep(100);
  }
}
`,
    'src/Repo.cs': `
class Repo {
  void Save(object item) {
    if (item == null) throw new ArgumentNullException(nameof(item));
    try { Write(item); Flush(); } catch { }
  }
}
`,
    'src/app.py': `
def read(obj):
    a = getattr(obj, "name", None)
    b = getattr(obj, "size", 0)
    return a, b
`,
    'src/main.go': `
package main
func run() error {
	if err := step(); err != nil {
		return err
	}
	return nil
}
`,
  });
});
after(() => p.dispose());

const lines = (out: string): string[] => out.split('\n').filter(l => /^\s+\d+\s/.test(l));

describe('clast_match', () => {
  it('matches a call by its shape, whatever the layout, and never in strings or comments', async () => {
    const one = await match(p.ctx, { pattern: 'fetch($URL)' });
    assert.match(one, /^`fetch\(\$URL\)`: 1 match in 1 file/);
    assert.match(one, /3 {2}\[load\] fetch\(url\) {4}URL=url/);
    const two = await match(p.ctx, { pattern: 'fetch($URL, $OPTS)' });
    assert.equal(lines(two).length, 2);
    const any = await match(p.ctx, { pattern: 'fetch($$$ARGS)' });
    assert.equal(lines(any).length, 3);
  });

  it('requires the same hole to match the same text', async () => {
    const out = await match(p.ctx, { pattern: 'same($A, $A)' });
    assert.equal(lines(out).length, 1);
    assert.match(out, /A=a/);
  });

  it('matches statements, with a hole for any run of statements', async () => {
    const exact = await match(p.ctx, { pattern: 'if ($X == null) { return null; }' });
    assert.equal(lines(exact).length, 1);
    const any = await match(p.ctx, { pattern: 'if ($X == null) { $$$BODY }' });
    assert.equal(lines(any).length, 2);
  });

  it('finds empty catch blocks in Java, counting a comment-only block as empty', async () => {
    const out = await match(p.ctx, { pattern: 'try { $$$A } catch ($T $E) { }' });
    assert.equal(lines(out).length, 2);
    assert.match(out, /T=IOException/);
  });

  it('parses fragments that need a terminator or a statement context (C#)', async () => {
    const thrown = await match(p.ctx, { pattern: 'throw new ArgumentNullException(nameof($X))' });
    assert.match(thrown, /X=item/);
    const swallowed = await match(p.ctx, { pattern: 'try { $$$A } catch { }', lang: 'csharp' });
    assert.equal(lines(swallowed).length, 1);
  });

  it('works for Python and Go', async () => {
    const py = await match(p.ctx, { pattern: 'getattr($O, $N, None)' });
    assert.equal(lines(py).length, 1);
    assert.match(py, /N="name"/);
    const go = await match(p.ctx, { pattern: 'if err := $CALL; err != nil { return err }' });
    assert.equal(lines(go).length, 1);
  });

  it('says how to write a pattern when it is not code', async () => {
    const out = await match(p.ctx, { pattern: ') nonsense ((' });
    assert.match(out, /^error: the pattern does not parse/);
  });
});
