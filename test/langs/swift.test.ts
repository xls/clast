import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, heritageList, importList, occLines, sym, symbolList } from '../helpers.js';
import type { Extraction } from '../../src/types.js';

const SRC = `import Foundation
import struct Foo.Bar
@testable import Alamofire

/// A shape.
@available(iOS 13, *)
public protocol Shape: AnyObject, Sendable {
    associatedtype Item
    var area: Double { get }
    static var count: Int { get set }
    func draw(in ctx: Context) -> Canvas
    init(side: Int)
    subscript(i: Int) -> Item { get }
}

extension Shape {
    /// Default.
    func describe() -> String { return "x" + String(area) }
}

public enum Color: String, Codable {
    /// Red.
    case red = "r", green
    case custom(r: Int, g: Int)
    indirect case nested(Color)
    static let all: [Color] = [.red]
    var name: String { rawValue }
}

/// Circle doc.
@MainActor
public final class Circle<T: Numeric>: Base<T>, Shape {
    public static let maxSize = 10
    private let session: Session
    fileprivate var radius: Int = 0, other: Int
    lazy var cache = Cache()
    weak var delegate: Delegate?
    public private(set) var state: State = .idle
    var area: Double {
        get { return compute() }
        set { store(newValue) }
    }
    var observed: Int = 0 { didSet { changed() } }

    /// Ctor.
    @discardableResult
    public init(r: Int) { super.init(r); self.radius = r }
    convenience init?() { self.init(r: 1) }
    deinit { cleanup() }

    /// Makes.
    @discardableResult
    public func make<R>(_ m: [String: R], using enc: Encoder = JSONEncoder()) -> Builder where R: Codable {
        let local: Foo = Foo()
        let b = Builder()
        b.add(1)
        local.run()
        self.session.request(url).validate().resume()
        session.cancel()
        delegate?.done()
        items.map { $0.name }.forEach { print($0) }
        queue.async { [weak self] in self?.finish() }
        enc.encode(m)
        JSONDecoder().decode(T.self, from: data)
        super.make()
        guard let s = thing as? Session else { return b }
        s.go()
        return b
    }
    func load() async throws -> Loader { try await fetch() }
    subscript(index: Int) -> Element { return items[index] }
    static func == (lhs: Circle, rhs: Circle) -> Bool { true }
    typealias Handler = (Int) -> Void
    struct Inner { var v: Int; func m() { go() } }
}

extension Circle: CustomStringConvertible where T: Equatable {
    var description: String { fmt() }
    private func helper() { self.session.suspend() }
}
extension Foreign.Nested: Hashable { func h() {} }

actor Store { var n = 0; func inc() { n += 1 } }
struct Point { let x: Int; var y = 0; mutating func move() {} }
typealias Completion = (Result<Int, Error>) -> Void
let globalConst = 1
var globalVar: Session = Session.default
private func topLevel(_ a: Int, b: String...) -> [Int]? { helper(a); return nil }
`;

function calls(ex: Extraction, name: string): Array<[string | null, string | null]> {
  return ex.calls.filter(c => c.name === name).map(c => [c.receiver, c.rtype]);
}

describe('swift extraction', () => {
  it('extracts symbols with qualified names and kinds', async () => {
    const ex = await extractSource('a.swift', SRC);
    assert.deepEqual(symbolList(ex), [
      'interface Shape',
      'type Shape.Item',
      'property Shape.area',
      'property Shape.count',
      'method Shape.draw',
      'method Shape.init',
      'method Shape.subscript',
      'method Shape.describe', // default implementation in an extension
      'enum Color',
      'constant Color.red',
      'constant Color.green',
      'constant Color.custom',
      'constant Color.nested',
      'property Color.all',
      'property Color.name',
      'class Circle',
      'property Circle.maxSize',
      'property Circle.session',
      'property Circle.radius',
      'property Circle.other',
      'property Circle.cache',
      'property Circle.delegate',
      'property Circle.state',
      'property Circle.area',
      'property Circle.observed',
      'method Circle.init',
      'method Circle.init',
      'method Circle.deinit',
      'method Circle.make',
      'method Circle.load',
      'method Circle.subscript',
      'method Circle.==',
      'type Circle.Handler',
      'struct Circle.Inner',
      'property Circle.Inner.v',
      'method Circle.Inner.m',
      'property Circle.description', // extension members are named after the extended type
      'method Circle.helper',
      'method Foreign.Nested.h',
      'class Store', // actor
      'property Store.n',
      'method Store.inc',
      'struct Point',
      'property Point.x',
      'property Point.y',
      'method Point.move',
      'type Completion',
      'constant globalConst',
      'variable globalVar',
      'function topLevel',
    ]);
    assert.equal(ex.hadError, false);
  });

  it('builds signatures without attributes or bodies', async () => {
    const ex = await extractSource('a.swift', SRC);
    assert.equal(sym(ex, 'Shape').signature, 'public protocol Shape: AnyObject, Sendable');
    assert.equal(sym(ex, 'Shape.area').signature, 'var area: Double { get }');
    assert.equal(sym(ex, 'Shape.draw').signature, 'func draw(in ctx: Context) -> Canvas');
    assert.equal(sym(ex, 'Shape.init').signature, 'init(side: Int)');
    assert.equal(sym(ex, 'Shape.subscript').signature, 'subscript(i: Int) -> Item');
    assert.equal(sym(ex, 'Color').signature, 'public enum Color: String, Codable');
    assert.equal(sym(ex, 'Color.red').signature, 'case red = "r"');
    assert.equal(sym(ex, 'Color.green').signature, 'case green');
    assert.equal(sym(ex, 'Color.custom').signature, 'case custom(r: Int, g: Int)');
    assert.equal(sym(ex, 'Color.name').signature, 'var name: String');
    assert.equal(sym(ex, 'Circle').signature, 'public final class Circle<T: Numeric>: Base<T>, Shape');
    assert.equal(sym(ex, 'Circle.session').signature, 'private let session: Session');
    assert.equal(sym(ex, 'Circle.radius').signature, 'fileprivate var radius: Int = 0');
    assert.equal(sym(ex, 'Circle.other').signature, 'fileprivate var other: Int');
    assert.equal(sym(ex, 'Circle.cache').signature, 'lazy var cache = Cache()');
    assert.equal(sym(ex, 'Circle.area').signature, 'var area: Double');
    assert.equal(sym(ex, 'Circle.observed').signature, 'var observed: Int = 0');
    assert.equal(sym(ex, 'Circle.init').signature, 'public init(r: Int)');
    assert.equal(sym(ex, 'Circle.deinit').signature, 'deinit');
    assert.equal(
      sym(ex, 'Circle.make').signature,
      'public func make<R>(_ m: [String: R], using enc: Encoder = JSONEncoder()) -> Builder where R: Codable'
    );
    assert.equal(sym(ex, 'Circle.==').signature, 'static func == (lhs: Circle, rhs: Circle) -> Bool');
    assert.equal(sym(ex, 'Circle.Handler').signature, 'typealias Handler = (Int) -> Void');
    assert.equal(sym(ex, 'Store').signature, 'actor Store');
    assert.equal(sym(ex, 'globalVar').signature, 'var globalVar: Session = Session.default');
    assert.equal(sym(ex, 'topLevel').signature, 'private func topLevel(_ a: Int, b: String...) -> [Int]?');
  });

  it('reads return types from signatures', async () => {
    const ex = await extractSource('a.swift', SRC);
    assert.equal(sym(ex, 'Shape.draw').ret, 'Canvas');
    assert.equal(sym(ex, 'Shape.describe').ret, 'String');
    assert.equal(sym(ex, 'Circle.make').ret, 'Builder'); // generic, default argument, where clause
    assert.equal(sym(ex, 'Circle.subscript').ret, 'Element');
    assert.equal(sym(ex, 'Circle.==').ret, 'Bool');
    assert.equal(sym(ex, 'Circle.init').ret, null);
    assert.equal(sym(ex, 'topLevel').ret, null); // optional array

    // Long parameter lists are elided in the middle so the return type stays in the signature.
    const long = await extractSource('l.swift', `
class Session {
    open func request(_ convertible: any URLConvertible, method: HTTPMethod = .get, parameters: Parameters? = nil, encoding: any ParameterEncoding = URLEncoding.default, headers: HTTPHeaders? = nil, interceptor: (any RequestInterceptor)? = nil, requestModifier: RequestModifier? = nil) -> DataRequest { make() }
}
`);
    const request = sym(long, 'Session.request');
    assert.ok(request.signature.length <= 240);
    assert.ok(request.signature.startsWith('open func request(_ convertible: any URLConvertible, method: HTTPMethod = .get,'));
    assert.ok(request.signature.endsWith(', ...) -> DataRequest'), request.signature);
    assert.equal(request.ret, 'DataRequest');
  });

  it('captures docs, line ranges and exported flags', async () => {
    const ex = await extractSource('a.swift', SRC);
    const shape = sym(ex, 'Shape');
    assert.equal(shape.doc, 'A shape.');
    assert.equal(shape.docLine, 5);
    assert.equal(shape.startLine, 6); // range starts at the attribute
    assert.equal(shape.endLine, 14);
    assert.equal(sym(ex, 'Shape.describe').doc, 'Default.');
    assert.equal(sym(ex, 'Color.red').doc, 'Red.');
    assert.equal(sym(ex, 'Circle').doc, 'Circle doc.');
    assert.equal(sym(ex, 'Circle.init').doc, 'Ctor.');
    assert.equal(sym(ex, 'Circle.make').doc, 'Makes.');
    assert.equal(sym(ex, 'Circle.load').doc, '');

    const hidden = ex.symbols.filter(s => !s.exported).map(s => s.qname);
    // private / fileprivate only; private(set) restricts the setter, not the symbol.
    assert.deepEqual(hidden, ['Circle.session', 'Circle.radius', 'Circle.other', 'Circle.helper', 'topLevel']);
    assert.equal(ex.symbols[sym(ex, 'Circle.Inner.m').parent]!.qname, 'Circle.Inner');
    assert.equal(sym(ex, 'Circle.helper').parent, -1); // extensions are naming scopes
  });

  it('extracts calls attributed to the enclosing symbol', async () => {
    const ex = await extractSource('a.swift', SRC);
    const list = callList(ex);
    for (const expected of [
      'Shape.describe -> String',
      'Circle.cache -> Cache', // property initialiser
      'Circle.area -> compute', // getter
      'Circle.area -> store', // setter
      'Circle.observed -> changed', // didSet
      'Circle.init -> super.init',
      'Circle.init -> self.init',
      'Circle.deinit -> cleanup',
      'Circle.make -> JSONEncoder', // default argument
      'Circle.make -> Foo',
      'Circle.make -> Builder',
      'Circle.make -> b.add',
      'Circle.make -> local.run',
      'Circle.make -> self.session.request',
      'Circle.make -> ?.validate',
      'Circle.make -> ?.resume',
      'Circle.make -> session.cancel',
      'Circle.make -> delegate.done', // optional chaining
      'Circle.make -> items.map', // trailing closure
      'Circle.make -> ?.forEach',
      'Circle.make -> print', // inside a closure
      'Circle.make -> queue.async',
      'Circle.make -> self.finish', // self?.finish()
      'Circle.make -> enc.encode',
      'Circle.make -> JSONDecoder',
      'Circle.make -> ?.decode',
      'Circle.make -> super.make',
      'Circle.make -> s.go',
      'Circle.load -> fetch', // try await
      'Circle.Inner.m -> go',
      'Circle.description -> fmt',
      'Circle.helper -> self.session.suspend',
      'topLevel -> helper',
    ]) {
      assert.ok(list.includes(expected), `missing '${expected}' in\n${list.join('\n')}`);
    }
    // Subscript access is not a call.
    assert.equal(ex.calls.some(c => c.name === 'items'), false);
  });

  it('resolves receivers to declared types and links chains', async () => {
    const ex = await extractSource('a.swift', SRC);
    assert.deepEqual(calls(ex, 'add'), [['b', 'Builder']]); // let b = Builder()
    assert.deepEqual(calls(ex, 'run'), [['local', 'Foo']]); // let local: Foo
    assert.deepEqual(calls(ex, 'request'), [['self.session', 'Session']]); // stored property
    assert.deepEqual(calls(ex, 'cancel'), [['session', 'Session']]);
    assert.deepEqual(calls(ex, 'suspend'), [['self.session', 'Session']]); // from an extension of the class
    assert.deepEqual(calls(ex, 'done'), [['delegate', 'Delegate']]); // Delegate?
    assert.deepEqual(calls(ex, 'encode'), [['enc', 'Encoder']]); // parameter
    assert.deepEqual(calls(ex, 'decode'), [['?', 'JSONDecoder']]); // JSONDecoder().decode()
    assert.deepEqual(calls(ex, 'go'), [['s', 'Session'], [null, null]]); // guard let s = x as? Session
    assert.deepEqual(calls(ex, 'finish'), [['self', null]]);
    const via = (name: string) => {
      const c = ex.calls.find(x => x.name === name)!;
      return c.via >= 0 ? ex.calls[c.via]!.name : null;
    };
    assert.equal(via('resume'), 'validate');
    assert.equal(via('validate'), 'request');
    assert.equal(via('forEach'), 'map');
    assert.ok(ex.fieldTypes.some(f => f.join() === 'Circle,session,Session'));
    assert.ok(ex.fieldTypes.some(f => f.join() === 'Circle,cache,Cache'));
    assert.ok(ex.fieldTypes.some(f => f.join() === 'Circle,delegate,Delegate'));
  });

  it('extracts imports and heritage', async () => {
    const ex = await extractSource('a.swift', SRC);
    assert.deepEqual(importList(ex), ['Foundation', 'Foo', 'Alamofire']);
    assert.deepEqual(ex.imports.map(i => i.names), [[], ['Bar'], []]);
    assert.deepEqual(ex.imports.map(i => i.line), [1, 2, 3]);
    assert.deepEqual(heritageList(ex), [
      'Shape extends AnyObject',
      'Shape extends Sendable',
      'Color implements String',
      'Color implements Codable',
      'Circle extends Base',
      'Circle implements Shape',
      'Circle implements CustomStringConvertible', // extension Circle: CustomStringConvertible
    ]);
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('a.swift', SRC);
    assert.deepEqual(occLines(ex, 'Shape'), [7, 16, 32]);
    assert.deepEqual(occLines(ex, 'session'), [34, 58, 59, 79]);
    assert.deepEqual(occLines(ex, 'helper'), [79, 88]);
  });

  it('handles protocols with default implementations, generics and enums with associated values', async () => {
    const ex = await extractSource('b.swift', `
private protocol Repo {
    associatedtype Model: Codable
    func find(id: Int) async throws -> Model?
    var all: [Model] { get }
}
extension Repo where Model: Equatable {
    func first() -> Model? { all.first }
    func has(_ m: Model) -> Bool { find(m) != nil }
}
struct Box<Wrapped>: Repo {
    typealias Model = Wrapped
    enum State<E: Error> { case idle, failed(E), loaded(value: Wrapped, at: Date) }
    func find(id: Int) async throws -> Wrapped? { nil }
    func map<U>(_ f: (Wrapped) throws -> U) rethrows -> Box<U> { Box<U>(try f(value)) }
    static func make() -> Self { .init() }
}
final class UserRepo: NSObject, Repo, @unchecked Sendable {}
class Plain: Codable {}
`);
    assert.deepEqual(symbolList(ex), [
      'interface Repo',
      'type Repo.Model',
      'method Repo.find',
      'property Repo.all',
      'method Repo.first',
      'method Repo.has',
      'struct Box',
      'type Box.Model',
      'enum Box.State',
      'constant Box.State.idle',
      'constant Box.State.failed',
      'constant Box.State.loaded',
      'method Box.find',
      'method Box.map',
      'method Box.make',
      'class UserRepo',
      'class Plain',
    ]);
    assert.equal(sym(ex, 'Box.State.loaded').signature, 'case loaded(value: Wrapped, at: Date)');
    assert.equal(sym(ex, 'Box').signature, 'struct Box<Wrapped>: Repo');
    // Members of a private protocol are not exported.
    assert.deepEqual(ex.symbols.filter(s => !s.exported).map(s => s.qname), ['Repo', 'Repo.Model', 'Repo.find', 'Repo.all']);
    assert.equal(sym(ex, 'Box.make').ret, 'Box'); // Self
    assert.deepEqual(heritageList(ex), [
      'Box implements Repo',
      'UserRepo extends NSObject',
      'UserRepo implements Repo',
      'UserRepo implements Sendable',
      'Plain implements Codable', // a well-known protocol is not a superclass
    ]);
    const list = callList(ex);
    assert.ok(list.includes('Repo.has -> find'));
    assert.ok(list.includes('Box.map -> Box')); // Box<U>(...)
    assert.ok(list.includes('Box.map -> f'));
    assert.ok(list.includes('Box.make -> ?.init')); // implicit member
  });

  it('types closures, optional bindings and constructor initialisers', async () => {
    const ex = await extractSource('c.swift', `
class Owner {
    let repo = Repository()
    var pending: Task<Void, Never>?
    static let shared = Owner()
    var computed: Engine { Engine() }
    func work(_ items: [Item], with handler: any Handler, opt: Thing!) {
        let d = Foo<Int>(x: 1)
        d.use()
        repo.load()
        self.computed.start()
        handler.handle()
        opt.poke()
        if let s = any as? Session, let t: Thing = other() { s.go(); t.tick() }
        for item: Item in items { item.run() }
        run { (v: Value, w) in v.use(); w.skip() }
        obj.method(arg) { $0.touch() }
        handler2?(1)
        self.items[0].reset()
        URLSession(configuration: .default).dataTask(with: url).resume()
        Owner.shared.work([], with: h, opt: nil)
        Foo.init(x: 2)
        let \`default\` = Thing()
        \`default\`.poke()
    }
}
`);
    assert.deepEqual(symbolList(ex), [
      'class Owner',
      'property Owner.repo',
      'property Owner.pending',
      'property Owner.shared',
      'property Owner.computed',
      'method Owner.work',
    ]);
    assert.deepEqual(calls(ex, 'use'), [['d', 'Foo'], ['v', 'Value']]);
    assert.deepEqual(calls(ex, 'load'), [['repo', 'Repository']]);
    assert.deepEqual(calls(ex, 'start'), [['self.computed', 'Engine']]);
    assert.deepEqual(calls(ex, 'handle'), [['handler', 'Handler']]); // any Handler
    assert.deepEqual(calls(ex, 'poke'), [['opt', 'Thing'], ['default', 'Thing']]);
    assert.deepEqual(calls(ex, 'go'), [['s', 'Session']]);
    assert.deepEqual(calls(ex, 'tick'), [['t', 'Thing']]);
    assert.deepEqual(calls(ex, 'run'), [['item', 'Item'], [null, null]]);
    assert.deepEqual(calls(ex, 'skip'), [['w', null]]);
    assert.deepEqual(calls(ex, 'touch'), [['$0', null]]);
    assert.deepEqual(calls(ex, 'handler2'), [[null, null]]);
    assert.deepEqual(calls(ex, 'reset'), [['?', null]]);
    assert.deepEqual(calls(ex, 'dataTask'), [['?', 'URLSession']]);
    assert.deepEqual(calls(ex, 'work'), [['Owner.shared', null]]);
    assert.deepEqual(calls(ex, 'Foo'), [[null, null]]); // Foo<Int>(...) and Foo.init(...)
    assert.equal(ex.calls.find(c => c.name === 'Foo')!.count, 2);
  });

  it('tolerates conditional compilation and broken source', async () => {
    const ex = await extractSource('d.swift', `
struct A {
    func before() { one() }
    #if os(iOS)
    func ios() { two() }
    #else
    private(set) var z: Int = 1
    #endif
    @objc open class func cls() { three() }
}
`);
    for (const s of ['struct A', 'method A.before', 'method A.ios', 'property A.z', 'method A.cls']) {
      assert.ok(symbolList(ex).includes(s), `missing ${s} in ${symbolList(ex).join(', ')}`);
    }
    assert.equal(sym(ex, 'A.cls').signature, 'open class func cls()');
    assert.ok(callList(ex).includes('A.ios -> two'));
    assert.ok(callList(ex).includes('A.cls -> three'));

    const broken = await extractSource('e.swift', `
class Broken {
    func ok() { run() }
    func bad( { let x = }
    func after() { done() }
}
`);
    assert.equal(broken.hadError, true);
    assert.ok(symbolList(broken).includes('method Broken.ok'));
    assert.ok(callList(broken).includes('Broken.ok -> run'));
    assert.ok(callList(broken).includes('Broken.after -> done'));

    const cut = await extractSource('f.swift', 'class Cut {\n    func ok() { run() }\n    var');
    // (The grammar loses the class header of a truncated file; the member is still found.)
    assert.ok(cut.symbols.some(s => s.name === 'ok'));
    assert.ok(cut.calls.some(c => c.name === 'run'));
  });
});
