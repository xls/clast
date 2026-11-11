import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, heritageList, importList, occLines, sym, symbolList } from '../helpers.js';

const SRC = `package main

import (
	"fmt"
	str "strings"
	_ "embed"
	"github.com/acme/pkg"
)
import "os"

// MaxSize is the limit.
const MaxSize = 10

const (
	// First doc.
	First = iota
	second
)

var x, Y = 1, 2

// handler doc.
var handler = func(a int) int { return helper2(a) }

var table = map[string]int{
	"a": 1,
}

// Server serves.
// Second line.
type Server struct {
	// Name doc.
	Name string
	port, Host int
	*Base
	pkg.Other
	Gen[T]
	nested struct{ hidden int }
}

type (
	// Reader reads.
	Reader interface {
		io.Closer
		Read(p []byte) (int, error)
		close()
	}
	ID = string
	Num int
)

type Number interface {
	~int | ~float64
}

type List[T any] struct{ items []T }

// Start starts.
func (s *Server) Start(ctx context.Context) error {
	local := 1
	var loc2 int
	const c3 = 1
	fmt.Println(local, loc2, str.ToUpper("a"), len("x"))
	s.Base.run()
	go helper[int](1)
	defer func() { os.Exit(1) }()
	f := func() { helper2(2) }
	f()
	_ = Server{Name: "x"}
	_ = &pkg.Thing{}
	_ = []int{1}
	_ = List[int]{}
	_ = string(rune(3))
	return nil
}

func (l List[T]) Len() int { return len(l.items) }

func (List[T]) anon() {}

func Map[T, U any](xs []T, f func(T) U) []U {
	var anonymous struct{ field int }
	_ = anonymous
	return nil
}

func helper2(a int) int { return a }
`;

describe('go extraction', () => {
  it('extracts symbols with qualified names and kinds', async () => {
    const ex = await extractSource('a.go', SRC);
    assert.deepEqual(symbolList(ex), [
      'constant MaxSize',
      'constant First',
      'constant second',
      'variable x',
      'variable Y',
      'function handler',
      'variable table',
      'struct Server',
      'field Server.Name',
      'field Server.port',
      'field Server.Host',
      'field Server.Base',
      'field Server.Other',
      'field Server.Gen',
      'field Server.nested',
      'interface Reader',
      'method Reader.Read',
      'method Reader.close',
      'type ID',
      'type Num',
      'interface Number',
      'struct List',
      'field List.items',
      'method Server.Start',
      'method List.Len',
      'method List.anon',
      'function Map',
      'function helper2',
    ]);
  });

  it('does not turn locals into symbols', async () => {
    const ex = await extractSource('a.go', SRC);
    const names = ex.symbols.map(s => s.name);
    for (const local of ['local', 'loc2', 'c3', 'f', 'anonymous', 'field', 'hidden']) {
      assert.ok(!names.includes(local), `local ${local} must not be a symbol`);
    }
  });

  it('captures signatures', async () => {
    const ex = await extractSource('a.go', SRC);
    assert.equal(sym(ex, 'Server.Start').signature, 'func (s *Server) Start(ctx context.Context) error');
    assert.equal(sym(ex, 'Map').signature, 'func Map[T, U any](xs []T, f func(T) U) []U');
    assert.equal(sym(ex, 'Server').signature, 'type Server struct');
    assert.equal(sym(ex, 'List').signature, 'type List[T any] struct');
    assert.equal(sym(ex, 'Reader').signature, 'type Reader interface');
    assert.equal(sym(ex, 'Reader.Read').signature, 'Read(p []byte) (int, error)');
    assert.equal(sym(ex, 'ID').signature, 'type ID = string');
    assert.equal(sym(ex, 'Num').signature, 'type Num int');
    assert.equal(sym(ex, 'MaxSize').signature, 'const MaxSize = 10');
    assert.equal(sym(ex, 'First').signature, 'const First = iota');
    assert.equal(sym(ex, 'Y').signature, 'var x, Y = 1, 2');
    assert.equal(sym(ex, 'handler').signature, 'var handler = func(a int) int');
    assert.equal(sym(ex, 'table').signature, 'var table = map[string]int');
    assert.equal(sym(ex, 'Server.Host').signature, 'port, Host int');
  });

  it('captures docs for single and grouped declarations', async () => {
    const ex = await extractSource('a.go', SRC);
    assert.equal(sym(ex, 'Server').doc, 'Server serves.\nSecond line.');
    assert.ok(sym(ex, 'Server').docLine > 0 && sym(ex, 'Server').docLine < sym(ex, 'Server').startLine);
    assert.equal(sym(ex, 'Server.Name').doc, 'Name doc.');
    assert.equal(sym(ex, 'Reader').doc, 'Reader reads.');
    assert.equal(sym(ex, 'ID').doc, '');
    assert.equal(sym(ex, 'MaxSize').doc, 'MaxSize is the limit.');
    assert.equal(sym(ex, 'First').doc, 'First doc.');
    assert.equal(sym(ex, 'second').doc, '');
    assert.equal(sym(ex, 'handler').doc, 'handler doc.');
    assert.equal(sym(ex, 'Server.Start').doc, 'Start starts.');
  });

  it('sets exported from capitalisation and line ranges', async () => {
    const ex = await extractSource('a.go', SRC);
    for (const q of ['MaxSize', 'First', 'Y', 'Server', 'Server.Name', 'Server.Host', 'Server.Base', 'Reader.Read', 'Server.Start', 'Map']) {
      assert.equal(sym(ex, q).exported, true, q);
    }
    for (const q of ['second', 'x', 'handler', 'Server.port', 'Reader.close', 'List.anon', 'helper2']) {
      assert.equal(sym(ex, q).exported, false, q);
    }
    const server = sym(ex, 'Server');
    assert.equal(server.endLine - server.startLine, 8);
    assert.equal(ex.symbols[sym(ex, 'Server.Name').parent]!.qname, 'Server');
  });

  it('extracts calls attributed to the enclosing symbol', async () => {
    const ex = await extractSource('a.go', SRC);
    const calls = callList(ex);
    for (const c of [
      'handler -> helper2',
      'Server.Start -> fmt.Println',
      'Server.Start -> str.ToUpper',
      'Server.Start -> s.Base.run',
      'Server.Start -> helper',
      'Server.Start -> os.Exit',
      'Server.Start -> helper2',
      'Server.Start -> f',
      'Server.Start -> Server',
      'Server.Start -> pkg.Thing',
      'Server.Start -> List',
    ]) {
      assert.ok(calls.includes(c), `missing '${c}' in ${calls.join(' | ')}`);
    }
  });

  it('ignores builtins and conversions to predeclared types', async () => {
    const ex = await extractSource('a.go', SRC);
    const names = ex.calls.map(c => c.name);
    for (const b of ['len', 'string', 'rune', 'int']) assert.ok(!names.includes(b), `builtin ${b} recorded`);
  });

  it('extracts imports', async () => {
    const ex = await extractSource('a.go', SRC);
    assert.deepEqual(importList(ex), ['fmt', 'strings', 'embed', 'github.com/acme/pkg', 'os']);
    assert.deepEqual(ex.imports[1]!.names, ['str']);
    assert.deepEqual(ex.imports[3]!.names, ['pkg']);
    assert.equal(ex.imports[4]!.line, 9);
  });

  it('records embedded structs and interfaces as heritage', async () => {
    const ex = await extractSource('a.go', SRC);
    assert.deepEqual(heritageList(ex), [
      'Server extends Base',
      'Server extends Other',
      'Server extends Gen',
      'Reader extends Closer',
    ]);
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('a.go', SRC);
    assert.deepEqual(occLines(ex, 'helper2'), [23, 67, 87]);
    assert.deepEqual(occLines(ex, 'Server'), [31, 59, 69]);
    assert.deepEqual(occLines(ex, 'Name'), [33, 69]);
    assert.deepEqual(occLines(ex, 'fmt'), [63]);
  });

  it('handles grouped vars, local types and generic calls', async () => {
    const ex = await extractSource('b.go', `package b

// Group doc is not a spec doc.
var (
	// A doc.
	A = 1
	b int
)

func run() {
	type point struct{ x, y int }
	var inner = func() { deep() }
	h[int, string](1)
	pkg.Make[int]()
	_ = point{}
}
`);
    assert.deepEqual(symbolList(ex), [
      'variable A',
      'variable b',
      'function run',
      'struct run.point',
      'field run.point.x',
      'field run.point.y',
    ]);
    assert.equal(sym(ex, 'A').doc, 'A doc.');
    assert.equal(sym(ex, 'A').signature, 'var A = 1');
    assert.equal(sym(ex, 'b').doc, '');
    assert.deepEqual(callList(ex), ['run -> deep', 'run -> h', 'run -> pkg.Make', 'run -> point']);
  });

  it('tolerates broken source', async () => {
    const ex = await extractSource('c.go', 'package c\n\nfunc (s *) Broken( {\n\ttype struct\n}\nfunc Ok() { call( }\n');
    assert.ok(Array.isArray(ex.symbols));
    assert.equal(ex.hadError, true);
  });
});
