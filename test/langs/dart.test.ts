import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, heritageList, importList, occLines, sym, symbolList } from '../helpers.js';
import type { Extraction } from '../../src/types.js';

const SRC = `library my.lib;
import 'dart:async';
import 'package:http/http.dart' as http show Client, Response hide Foo;
import 'src/x.dart' deferred as x;
export 'src/client.dart' show Client;
part 'a.g.dart';

/// A shape.
/// Second line.
@immutable
abstract class Shape<T> extends Base<T> with Mixin1, Mixin2 implements Comparable<T>, io.Closeable {
  static const int maxSize = 10;
  final Client _client;
  late final Foo foo = Foo();
  var cache = Cache.named(1);
  int a = 1, b;
  static final Map<String, int> table = {};

  /// Ctor.
  Shape(this._client, {required int x, super.key}) : assert(x > 0), b = x, super(x);
  Shape.named(int y) : this(Client(), x: y);
  const Shape._();
  factory Shape.create(String s) => Circle(s);
  factory Shape.redirect() = Circle;

  double get area;
  set area(double v) { store(v); }
  String get name => compute();

  /// Sends.
  @override
  Future<Response> send(Request request, [int n = 0]) async {
    final Foo local = Foo();
    var b = Builder();
    final c = new Cache.named(2);
    b.add(1);
    local.run();
    _client.send(request).then((r) => r.body).catchError(print);
    this.foo.bar();
    await http.get(url);
    b..add(2)..remove(3);
    foo?.baz();
    super.send(request);
    Shape.named(1).go();
    const Duration(seconds: 1);
    return helper(request);
  }
  static Shape<T> of<T>(Context ctx) => ctx.find();
  bool operator ==(Object other) => true;
  void abstractM();
}

mixin Walker on Animal implements Legs { void walk() { step(); } }
mixin class Both {}
extension StringX on String { bool get blank => trim().isEmpty; int twice() => length * 2; }
enum Color implements Comparable<Color> { red, green(2); final int v; const Color([this.v = 0]); void m() {} }
typedef Callback = void Function(int);
typedef int Compare(Object a, Object b);
const topConst = 1;
final Client topClient = Client();
int _private = 0;
void topLevel(int a, {String? b}) { helper(a); }
Future<Client> make() async => Client();
String get topGetter => 'x';
`;

function calls(ex: Extraction, name: string): Array<[string | null, string | null]> {
  return ex.calls.filter(c => c.name === name).map(c => [c.receiver, c.rtype]);
}

describe('dart extraction', () => {
  it('extracts symbols with qualified names and kinds', async () => {
    const ex = await extractSource('a.dart', SRC);
    assert.deepEqual(symbolList(ex), [
      'class Shape',
      'constant Shape.maxSize',
      'field Shape._client',
      'field Shape.foo',
      'field Shape.cache',
      'field Shape.a',
      'field Shape.b',
      'field Shape.table',
      'method Shape.Shape',
      'method Shape.named',
      'method Shape._',
      'method Shape.create',
      'method Shape.redirect',
      'property Shape.area',
      'property Shape.area',
      'property Shape.name',
      'method Shape.send',
      'method Shape.of',
      'method Shape.==',
      'method Shape.abstractM',
      'trait Walker',
      'method Walker.walk',
      'class Both',
      'property String.blank',
      'method String.twice',
      'enum Color',
      'constant Color.red',
      'constant Color.green',
      'field Color.v',
      'method Color.Color',
      'method Color.m',
      'type Callback',
      'type Compare',
      'constant topConst',
      'variable topClient',
      'variable _private',
      'function topLevel',
      'function make',
      'property topGetter',
    ]);
    assert.equal(ex.hadError, false);
  });

  it('builds signatures and reads return types', async () => {
    const ex = await extractSource('a.dart', SRC);
    assert.equal(
      sym(ex, 'Shape').signature,
      'abstract class Shape<T> extends Base<T> with Mixin1, Mixin2 implements Comparable<T>, io.Closeable'
    );
    assert.equal(sym(ex, 'Shape.maxSize').signature, 'static const int maxSize = 10');
    assert.equal(sym(ex, 'Shape._client').signature, 'final Client _client');
    assert.equal(sym(ex, 'Shape.a').signature, 'int a = 1');
    assert.equal(sym(ex, 'Shape.b').signature, 'int b');
    assert.equal(sym(ex, 'Shape.Shape').signature, 'Shape(this._client, {required int x, super.key})');
    assert.equal(sym(ex, 'Shape.named').signature, 'Shape.named(int y)');
    assert.equal(sym(ex, 'Shape._').signature, 'const Shape._()');
    assert.equal(sym(ex, 'Shape.create').signature, 'factory Shape.create(String s)');
    assert.equal(sym(ex, 'Shape.redirect').signature, 'factory Shape.redirect() = Circle');
    assert.equal(sym(ex, 'Shape.name').signature, 'String get name');
    assert.equal(sym(ex, 'Shape.send').signature, 'Future<Response> send(Request request, [int n = 0])');
    assert.equal(sym(ex, 'Shape.of').signature, 'static Shape<T> of<T>(Context ctx)');
    assert.equal(sym(ex, 'Shape.==').signature, 'bool operator ==(Object other)');
    assert.equal(sym(ex, 'Walker').signature, 'mixin Walker on Animal implements Legs');
    assert.equal(sym(ex, 'Both').signature, 'mixin class Both');
    assert.equal(sym(ex, 'Color.green').signature, 'green(2)');
    assert.equal(sym(ex, 'Callback').signature, 'typedef Callback = void Function(int)');
    assert.equal(sym(ex, 'topClient').signature, 'final Client topClient = Client()');
    assert.equal(sym(ex, 'topLevel').signature, 'void topLevel(int a, {String? b})');
    assert.equal(sym(ex, 'make').signature, 'Future<Client> make()');

    // The return type precedes the name; Future<T> is unwrapped.
    assert.equal(sym(ex, 'Shape.send').ret, 'Response');
    assert.equal(sym(ex, 'Shape.of').ret, 'Shape');
    assert.equal(sym(ex, 'make').ret, 'Client');
    assert.equal(sym(ex, 'topLevel').ret, null);
  });

  it('captures docs, ranges covering the body and exported flags', async () => {
    const ex = await extractSource('a.dart', SRC);
    const shape = sym(ex, 'Shape');
    assert.equal(shape.doc, 'A shape.\nSecond line.');
    assert.equal(shape.docLine, 8);
    assert.equal(sym(ex, 'Shape.Shape').doc, 'Ctor.');
    // The annotation sits between the doc comment and the method.
    const send = sym(ex, 'Shape.send');
    assert.equal(send.doc, 'Sends.');
    assert.equal(send.startLine, 32);
    assert.equal(send.endLine, 47); // signature + body
    assert.equal(ex.symbols[send.parent]!.qname, 'Shape');
    assert.equal(sym(ex, 'Shape.of').doc, '');

    const hidden = ex.symbols.filter(s => !s.exported).map(s => s.qname);
    assert.deepEqual(hidden, ['Shape._client', 'Shape._', '_private']);
  });

  it('attributes calls in method bodies to the method', async () => {
    const ex = await extractSource('a.dart', SRC);
    const list = callList(ex);
    for (const expected of [
      'Shape.foo -> Foo', // field initialiser
      'Shape.cache -> Cache.named',
      'Shape.Shape -> Base', // super(x)
      'Shape.named -> Shape', // this(...)
      'Shape.named -> Client',
      'Shape.create -> Circle',
      'Shape.redirect -> Circle',
      'Shape.area -> store', // setter body
      'Shape.name -> compute', // getter body
      'Shape.send -> Foo',
      'Shape.send -> Builder',
      'Shape.send -> Cache.named', // new Cache.named(2)
      'Shape.send -> b.add',
      'Shape.send -> local.run',
      'Shape.send -> _client.send',
      'Shape.send -> ?.then',
      'Shape.send -> ?.catchError',
      'Shape.send -> this.foo.bar',
      'Shape.send -> http.get',
      'Shape.send -> b.remove', // cascade
      'Shape.send -> foo.baz', // ?.
      'Shape.send -> super.send',
      'Shape.send -> Shape.named',
      'Shape.send -> ?.go',
      'Shape.send -> Duration', // const constructor
      'Shape.send -> helper',
      'Shape.of -> ctx.find',
      'Walker.walk -> step',
      'String.blank -> trim',
      'topClient -> Client',
      'topLevel -> helper',
      'make -> Client',
    ]) {
      assert.ok(list.includes(expected), `missing '${expected}' in\n${list.join('\n')}`);
    }
    // Nothing in a body leaks to the class.
    assert.deepEqual(list.filter(c => c.startsWith('Shape -> ')), []);
  });

  it('resolves receivers to declared types and links chains', async () => {
    const ex = await extractSource('a.dart', SRC);
    assert.deepEqual(calls(ex, 'add'), [['b', 'Builder']]); // var b = Builder(), also via the cascade
    assert.deepEqual(calls(ex, 'remove'), [['b', 'Builder']]);
    assert.deepEqual(calls(ex, 'run'), [['local', 'Foo']]);
    assert.deepEqual(calls(ex, 'send'), [['_client', 'Client'], ['super', null]]); // field of the class
    assert.deepEqual(calls(ex, 'bar'), [['this.foo', 'Foo']]);
    assert.deepEqual(calls(ex, 'baz'), [['foo', 'Foo']]);
    assert.deepEqual(calls(ex, 'find'), [['ctx', 'Context']]); // parameter
    assert.deepEqual(calls(ex, 'get'), [['http', null]]);
    // a.send(r).then(...).catchError(...): each call is linked to the one producing its receiver.
    const via = (name: string) => {
      const c = ex.calls.find(x => x.name === name)!;
      return c.via >= 0 ? ex.calls[c.via]!.name : null;
    };
    assert.equal(via('catchError'), 'then');
    assert.equal(via('then'), 'send');
    assert.equal(via('go'), 'named');
    assert.deepEqual(ex.fieldTypes, [
      ['Shape', '_client', 'Client'],
      ['Shape', 'foo', 'Foo'],
      ['Shape', 'cache', 'Cache'],
      ['Shape', 'table', 'Map'],
      ['Shape', 'name', 'String'],
    ]);
  });

  it('extracts imports, exports and parts', async () => {
    const ex = await extractSource('a.dart', SRC);
    assert.deepEqual(importList(ex), ['dart:async', 'package:http/http.dart', 'src/x.dart', 'src/client.dart', 'a.g.dart']);
    assert.deepEqual(ex.imports.map(i => i.names), [['*'], ['http', 'Client', 'Response'], ['x'], ['Client'], []]);
    assert.deepEqual(ex.imports.map(i => i.line), [2, 3, 4, 5, 6]);
  });

  it('extracts heritage', async () => {
    const ex = await extractSource('a.dart', SRC);
    assert.deepEqual(heritageList(ex), [
      'Shape extends Base',
      'Shape implements Mixin1',
      'Shape implements Mixin2',
      'Shape implements Comparable',
      'Shape implements Closeable',
      'Walker extends Animal',
      'Walker implements Legs',
      'Color implements Comparable',
    ]);
    assert.equal(ex.heritage.find(h => h.name === 'Closeable')!.qualifier, 'io');
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('a.dart', SRC);
    assert.deepEqual(occLines(ex, 'Shape'), [11, 20, 21, 22, 23, 24, 44, 48]);
    assert.deepEqual(occLines(ex, '_client'), [13, 20, 38]);
    assert.deepEqual(occLines(ex, 'helper'), [46, 62]);
  });

  it('handles local functions, closures, loops, catch clauses and cascades', async () => {
    const ex = await extractSource('b.dart', `
void f(List<Item> items, http.Client c, {required Foo foo}) {
  a!.foo();
  list[0].bar();
  var m = Foo<int>();
  final n = http.Client();
  n.close();
  final o = Foo.create();
  o.use();
  void inner(Zed z) { z.abs(); }
  for (final Item it in items) { it.run(); }
  try { g(); } on FooException catch (e, s) { e.log(); }
  x = a.b() + c.d();
  obj..name = 'x'..child.add(1)..[0] = 2;
  Foo()..init();
  a?.b?.c();
  'str'.length.toString();
  fn(1)(2);
  final cb = (Thing t, int i) { t.go(); };
  return new prefix.Bar().baz();
}
`);
    assert.deepEqual(symbolList(ex), ['function f', 'function f.inner']);
    assert.deepEqual(calls(ex, 'foo'), [['a', null]]);
    assert.deepEqual(calls(ex, 'bar'), [['?', null]]);
    assert.deepEqual(calls(ex, 'Foo'), [[null, null]]);
    assert.deepEqual(calls(ex, 'Client'), [['http', null]]);
    assert.deepEqual(calls(ex, 'close'), [['n', 'Client']]); // prefix.Class()
    assert.deepEqual(calls(ex, 'use'), [['o', 'Foo']]); // Foo.named()
    assert.deepEqual(calls(ex, 'abs'), [['z', 'Zed']]);
    assert.equal(callList(ex).includes('f.inner -> z.abs'), true);
    assert.deepEqual(calls(ex, 'run'), [['it', 'Item']]);
    assert.deepEqual(calls(ex, 'log'), [['e', 'FooException']]);
    assert.deepEqual(calls(ex, 'b'), [['a', null]]);
    assert.deepEqual(calls(ex, 'd'), [['c', 'Client']]);
    assert.deepEqual(calls(ex, 'add'), [['obj.child', null]]);
    assert.deepEqual(calls(ex, 'init'), [['?', 'Foo']]);
    assert.deepEqual(calls(ex, 'c'), [['a.b', null]]);
    assert.deepEqual(calls(ex, 'toString'), [['?', null]]);
    assert.deepEqual(calls(ex, 'fn'), [[null, null]]);
    assert.deepEqual(calls(ex, 'go'), [['t', 'Thing']]);
    assert.deepEqual(calls(ex, 'Bar'), [[null, null]]);
    assert.deepEqual(calls(ex, 'baz'), [['?', 'Bar']]);
  });

  it('handles constructors, accessors, operators and generators in classes', async () => {
    const ex = await extractSource('c.dart', `
class A extends B {
  A.named() : this._(1);
  A._(int x) : super.named(x);
  A(Repo repo) : _repo = repo { repo.open(); }
  final Repo _repo;
  Repo get repo => _repo;
  set repo(Repo value) { touch(); }
  static A? instance;
  void Function()? cb;
  @override
  @visibleForTesting
  /// Doc after annotations.
  Stream<int> m() async* { yield 1; _repo.load(); this.repo.save(); }
  A operator +(A o) => this;
  external void ext();
}
extension on List<int> { int sum() => fold(0, add); }
extension type Id(int value) { bool get ok => value > 0; }
`);
    assert.deepEqual(symbolList(ex), [
      'class A',
      'method A.named',
      'method A._',
      'method A.A',
      'field A._repo',
      'property A.repo',
      'property A.repo',
      'field A.instance',
      'field A.cb',
      'method A.m',
      'method A.+',
      'method A.ext',
      'method List.sum',
      'class Id',
      'property Id.ok',
    ]);
    assert.equal(sym(ex, 'A.A').signature, 'A(Repo repo)');
    assert.equal(sym(ex, 'A.m').doc, 'Doc after annotations.');
    assert.equal(sym(ex, 'A.cb').signature, 'void Function()? cb');
    assert.equal(sym(ex, 'A.ext').signature, 'external void ext()');
    const list = callList(ex);
    assert.ok(list.includes('A.named -> A._'));
    assert.ok(list.includes('A._ -> B.named'));
    assert.ok(list.includes('A.A -> repo.open'));
    assert.ok(list.includes('A.repo -> touch'));
    assert.ok(list.includes('List.sum -> fold'));
    assert.deepEqual(calls(ex, 'open'), [['repo', 'Repo']]);
    assert.deepEqual(calls(ex, 'load'), [['_repo', 'Repo']]);
    assert.deepEqual(calls(ex, 'save'), [['this.repo', 'Repo']]); // typed through the getter
    assert.deepEqual(heritageList(ex), ['A extends B']);
  });

  it('handles part files and tolerates broken source', async () => {
    const part = await extractSource('p.dart', `part of 'lib.dart';
class _Impl with Helper { void run() => go(); }
`);
    assert.deepEqual(symbolList(part), ['class _Impl', 'method _Impl.run']);
    assert.equal(sym(part, '_Impl').exported, false);
    assert.deepEqual(heritageList(part), ['_Impl implements Helper']);
    assert.deepEqual(callList(part), ['_Impl.run -> go']);

    // A broken statement inside a body: the surrounding declarations survive.
    const ex = await extractSource('d.dart', `
class Broken {
  void ok() { run(); }
  void bad() { int x = ; other(; }
  void after() { done(); }
}
`);
    assert.equal(ex.hadError, true);
    assert.ok(symbolList(ex).includes('class Broken'));
    assert.ok(symbolList(ex).includes('method Broken.ok'));
    assert.ok(callList(ex).includes('Broken.ok -> run'));
    assert.ok(symbolList(ex).includes('method Broken.after'));
    assert.ok(callList(ex).includes('Broken.after -> done'));

    // A broken member list: the grammar loses the class header, members are still found.
    const lost = await extractSource('f.dart', `
class Lost {
  void ok() { run(); }
  void bad( { int x = ; }
}
`);
    assert.equal(lost.hadError, true);
    assert.ok(lost.symbols.some(s => s.name === 'ok'));
    assert.ok(lost.calls.some(c => c.name === 'run'));

    const cut = await extractSource('e.dart', 'class Cut {\n  void ok() { run(); }\n  int');
    assert.ok(cut.symbols.some(s => s.name === 'ok'));
    assert.ok(cut.calls.some(c => c.name === 'run'));
  });
});
