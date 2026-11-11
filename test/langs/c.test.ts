import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, importList, occLines, sym, symbolList } from '../helpers.js';

const SRC = `#include <stdio.h>
#include "server.h"

#define MAX_CLIENTS 10
/* Square of x. */
#define SQ(x) ((x) * \\
  (x))

/* A point. */
typedef struct {
  int x;
  char *name, buf[4];
  void (*cb)(int);
} Point;

typedef struct node {
  struct node *next;
} node_t, *node_p;

typedef struct list { int len; } list;

typedef int (*cmp_fn)(const void *a, const void *b);
typedef unsigned long ulong;

enum color { RED, GREEN = 2 };
typedef enum { OFF, ON } toggle_t;
union value { int i; float f; };

static int counter = 0;
const char *names[] = { "a", "b" };
extern int external_counter;
int a, *b;
struct server server;
void (*handler)(int sig);

/* Adds two numbers. */
int add(int a, int b);
static void *helper(void);

char **(*weird(int x))(void) { return 0; }

// Adds two numbers,
// for real.
static inline int add(int a, int b) {
  int local = 1;
  struct tmp { int inner; } t;
  s->cb(a);
  p.q.fn(b);
  return helper2(a) + local;
}

void run(void)
{
  add(1, 2);
  add(3, 4);
  printf("%d", SQ(2));
}
`;

describe('c extraction', () => {
  it('extracts symbols with qualified names and kinds', async () => {
    const ex = await extractSource('a.c', SRC);
    assert.equal(ex.lang, 'c');
    assert.deepEqual(symbolList(ex), [
      'macro MAX_CLIENTS',
      'macro SQ',
      'struct Point',
      'field Point.x',
      'field Point.name',
      'field Point.buf',
      'field Point.cb',
      'type node_t',
      'type node_p',
      'struct node',
      'field node.next',
      'struct list',
      'field list.len',
      'type cmp_fn',
      'type ulong',
      'enum color',
      'constant color.RED',
      'constant color.GREEN',
      'enum toggle_t',
      'constant toggle_t.OFF',
      'constant toggle_t.ON',
      'struct value',
      'field value.i',
      'field value.f',
      'variable counter',
      'constant names',
      'variable a',
      'variable b',
      'variable server',
      'variable handler',
      'declaration add',
      'declaration helper',
      'function weird',
      'function add',
      'function run',
    ]);
  });

  it('captures signatures', async () => {
    const ex = await extractSource('a.c', SRC);
    assert.equal(sym(ex, 'MAX_CLIENTS').signature, '#define MAX_CLIENTS 10');
    assert.equal(sym(ex, 'SQ').signature, '#define SQ(x)');
    assert.equal(sym(ex, 'Point').signature, 'typedef struct { ... } Point');
    assert.equal(sym(ex, 'node').signature, 'typedef struct node');
    assert.equal(sym(ex, 'node_p').signature, 'typedef struct node { ... } *node_p');
    assert.equal(sym(ex, 'cmp_fn').signature, 'typedef int (*cmp_fn)(const void *a, const void *b)');
    assert.equal(sym(ex, 'ulong').signature, 'typedef unsigned long ulong');
    assert.equal(sym(ex, 'Point.cb').signature, 'void (*cb)(int)');
    assert.equal(sym(ex, 'color.GREEN').signature, 'GREEN = 2');
    assert.equal(sym(ex, 'counter').signature, 'static int counter');
    assert.equal(sym(ex, 'names').signature, 'const char *names[]');
    assert.equal(sym(ex, 'weird').signature, 'char **(*weird(int x))(void)');
    assert.equal(sym(ex, 'run').signature, 'void run(void)');
    const [proto, def] = ex.symbols.filter(s => s.name === 'add');
    assert.equal(proto!.signature, 'int add(int a, int b)');
    assert.equal(def!.signature, 'static inline int add(int a, int b)');
  });

  it('captures docs, static/exported and ranges', async () => {
    const ex = await extractSource('a.c', SRC);
    assert.equal(sym(ex, 'SQ').doc, 'Square of x.');
    assert.equal(sym(ex, 'Point').doc, 'A point.');
    const [proto, def] = ex.symbols.filter(s => s.name === 'add');
    assert.equal(proto!.kind, 'declaration');
    assert.equal(proto!.doc, 'Adds two numbers.');
    assert.equal(proto!.exported, true);
    assert.equal(def!.kind, 'function');
    assert.equal(def!.doc, 'Adds two numbers,\nfor real.');
    assert.equal(def!.exported, false);
    assert.ok(def!.docLine > 0 && def!.docLine < def!.startLine);
    assert.equal(def!.endLine - def!.startLine, 6);
    assert.equal(sym(ex, 'helper').exported, false);
    assert.equal(sym(ex, 'counter').exported, false);
    assert.equal(sym(ex, 'server').exported, true);
    assert.equal(sym(ex, 'run').exported, true);
    assert.equal(sym(ex, 'Point').endLine - sym(ex, 'Point').startLine, 4);
  });

  it('does not index locals or extern forward declarations', async () => {
    const ex = await extractSource('a.c', SRC);
    for (const name of ['local', 't', 'tmp', 'inner', 'external_counter']) {
      assert.ok(!ex.symbols.some(s => s.name === name), `unexpected symbol ${name}`);
    }
  });

  it('extracts calls attributed to the enclosing function', async () => {
    const ex = await extractSource('a.c', SRC);
    assert.deepEqual(callList(ex), [
      'add -> s.cb',
      'add -> p.q.fn',
      'add -> helper2',
      'run -> add',
      'run -> printf',
      'run -> SQ',
    ]);
    assert.equal(ex.calls.find(c => c.name === 'add')!.count, 2);
  });

  it('extracts includes', async () => {
    const ex = await extractSource('a.c', SRC);
    assert.deepEqual(importList(ex), ['stdio.h', 'server.h']);
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('a.c', SRC);
    assert.deepEqual(occLines(ex, 'helper'), [38]);
    assert.deepEqual(occLines(ex, 'node'), [16, 17]);
    assert.deepEqual(occLines(ex, 'cb'), [13, 47]);
    assert.equal(occLines(ex, 'add').length, 4);
  });

  it('finds doc comments that directly follow a preprocessor line', async () => {
    const ex = await extractSource('b.c', [
      '#include "x.h"',
      '/* doc one */',
      'int foo(void) { return 1; }',
      '#define A 1',
      '// doc two',
      '// more',
      'int bar(void);',
      '#define FOO_H',
      '#define FLAG',
      '',
    ].join('\n'));
    assert.deepEqual(symbolList(ex), ['function foo', 'macro A', 'declaration bar', 'macro FLAG']);
    assert.equal(sym(ex, 'foo').doc, 'doc one');
    assert.equal(sym(ex, 'bar').doc, 'doc two\nmore');
  });

  it('handles declarations nested in preprocessor conditionals and named struct variables', async () => {
    const ex = await extractSource('c.c', [
      '#ifndef GUARD_H',
      '#define GUARD_H',
      '#ifdef __cplusplus',
      'extern "C" {',
      '#endif',
      'struct cfg { int v; } cfg_inst = { 1 };',
      'static struct { int hidden; } anon;',
      'enum { ANON_A, ANON_B };',
      'int api(void);',
      '#endif',
      '',
    ].join('\n'));
    const list = symbolList(ex);
    for (const s of ['variable cfg_inst', 'struct cfg', 'field cfg.v', 'variable anon', 'constant ANON_A', 'constant ANON_B', 'declaration api']) {
      assert.ok(list.includes(s), `missing '${s}' in ${list.join(', ')}`);
    }
    assert.ok(!list.some(s => s.includes('hidden') || s.includes('GUARD_H')));
    assert.equal(sym(ex, 'cfg_inst').signature, 'struct cfg { ... } cfg_inst');
    assert.equal(sym(ex, 'cfg').signature, 'struct cfg');
  });

  it('degrades gracefully on macro-heavy and broken code', async () => {
    const ex = await extractSource('d.c', [
      'void NOTHROW * ATTR(malloc) ALLOC_SIZE(1)',
      'je_malloc(size_t size) {',
      '  int local;',
      '  return imalloc(size);',
      '}',
      'TEST_BEGIN(test_thing)',
      '{',
      '  expect(1);',
      '}',
      'TEST_END',
      'static int ok(void) { return 0; }',
      'int broken( {',
      '',
    ].join('\n'));
    const list = symbolList(ex);
    assert.ok(list.includes('function je_malloc'), list.join(', '));
    assert.ok(list.includes('function test_thing'), list.join(', '));
    assert.ok(list.includes('function ok'), list.join(', '));
    assert.ok(!list.some(s => s.endsWith(' local')));
    for (const s of ex.symbols) assert.match(s.name, /^[A-Za-z_]\w*$/);
    assert.ok(callList(ex).includes('je_malloc -> imalloc'));
    assert.equal(sym(ex, 'je_malloc').signature, 'void NOTHROW * ATTR(malloc) ALLOC_SIZE(1) je_malloc(size_t size)');
  });

  it('sniffs .h files that look like C++', async () => {
    const cHeader = '#ifndef A_H\n#define A_H\n/* a class of things: public or private */\nstruct foo { int klass; };\nint f(void);\n#endif\n';
    assert.equal((await extractSource('plain.h', cHeader)).lang, 'c');
    assert.equal((await extractSource('a.h', 'class Foo {\n public:\n  int bar();\n};\n')).lang, 'cpp');
    assert.equal((await extractSource('b.h', 'namespace x {\nint f();\n}\n')).lang, 'cpp');
    assert.equal((await extractSource('c.h', 'template <typename T>\nT id(T v) { return v; }\n')).lang, 'cpp');
    assert.equal((await extractSource('d.h', '#include <string>\nint f(void);\n')).lang, 'cpp');
    assert.equal((await extractSource('e.h', 'void f(std::string s);\n')).lang, 'cpp');
    // Only .h is ambiguous.
    assert.equal((await extractSource('f.c', 'int class_count; /* Foo::bar */\n')).lang, 'c');
    const ex = await extractSource('a.h', 'class Foo {\n public:\n  int bar();\n};\n');
    assert.deepEqual(symbolList(ex), ['class Foo', 'method Foo.bar']);
  });
});
