import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, heritageList, importList, occLines, sym, symbolList } from '../helpers.js';

const SRC = `using System;
using System.Collections.Generic;
using static System.Math;
using Alias = System.Text.StringBuilder;
global using Foo.Bar;

namespace My.App
{
    /// <summary>
    /// A shape with an <see cref="Area"/>.
    /// </summary>
    /// <typeparam name="T">The item type.</typeparam>
    [Serializable]
    public interface IShape<T> : IDisposable where T : class
    {
        double Area();
        string Name { get; }
        private void Hidden() { }
    }

    public enum Color : byte
    {
        /// <summary>Red.</summary>
        Red,
        Green = 2,
    }

    public delegate void Handler<T>(object sender, T args);

    public record Point(int X, int Y) : IShape<Point>;
    public record struct P2(int X);
    public readonly struct Vec : IEquatable<Vec> { public int X; }
    internal record Derived(int X, int Y, int Z) : Point(X, Y);

    /// <summary>Circle.</summary>
    [Obsolete("x")]
    public partial class Circle<T> : Base<T>, IShape<T>, System.IDisposable where T : new()
    {
        public const int MaxSize = 10;
        private readonly int _radius, _other;
        private static readonly ILogger Log = LoggerFactory.Create("c");
        public static event EventHandler Changed;
        public event EventHandler Custom { add { Sub(value); } remove { } }
        // The radius.
        public int Radius { get; set; } = 1;
        public int Twice => Compute(_radius);
        public int Lazy { get { return Load(); } }
        public int this[int i] { get { return Get(i); } }

        /// <summary>Ctor.</summary>
        /// <param name="r">The radius.</param>
        public Circle(int r) : base(r) { _radius = r; }
        public Circle() : this(1) { }
        ~Circle() { Cleanup(); }

        public static Circle<T> operator +(Circle<T> a, Circle<T> b) => a;
        public static implicit operator int(Circle<T> c) => 1;

        [HttpGet]
        [Route("area")]
        public async Task<List<R>> Area<R>(Dictionary<string, R> m) where R : class
        {
            int Local(int x) => Abs(x);
            var o = new System.Text.StringBuilder();
            List<int> l = new();
            var q = Foo<int>(1);
            this.foo.Bar<string>().Baz();
            x?.Maybe();
            y?.Inner.Deep();
            await Task.Run(() => Helper(1));
            using (var d = Open()) { d.Read(); }
            return base.Area();
        }

        public abstract void Nobody();
        void IDisposable.Dispose() { }
        public class Inner { void M() { } }
    }

    public static class Ext
    {
        public static int Len(this string s) => s.Length;
    }

    namespace Deep.Er { class Hidden { } }
}
`;

describe('csharp extraction', () => {
  it('extracts symbols with qualified names and kinds (namespaces are not part of qnames)', async () => {
    const ex = await extractSource('A.cs', SRC);
    assert.deepEqual(symbolList(ex), [
      'interface IShape',
      'method IShape.Area',
      'property IShape.Name',
      'method IShape.Hidden',
      'enum Color',
      'constant Color.Red',
      'constant Color.Green',
      'type Handler',
      'class Point',
      'property Point.X',
      'property Point.Y',
      'struct P2',
      'property P2.X',
      'struct Vec',
      'field Vec.X',
      'class Derived',
      'property Derived.X',
      'property Derived.Y',
      'property Derived.Z',
      'class Circle',
      'constant Circle.MaxSize',
      'field Circle._radius',
      'field Circle._other',
      'field Circle.Log',
      'field Circle.Changed',
      'property Circle.Custom',
      'property Circle.Radius',
      'property Circle.Twice',
      'property Circle.Lazy',
      'property Circle.this[]',
      'method Circle.Circle',
      'method Circle.Circle',
      'method Circle.~Circle',
      'method Circle.operator +',
      'method Circle.operator int',
      'method Circle.Area',
      'function Circle.Area.Local',
      'method Circle.Nobody',
      'method Circle.Dispose',
      'class Circle.Inner',
      'method Circle.Inner.M',
      'class Ext',
      'method Ext.Len',
      'class Hidden',
    ]);
    assert.equal(ex.hadError, false);
  });

  it('builds signatures without attributes, bodies or trailing punctuation', async () => {
    const ex = await extractSource('A.cs', SRC);
    const expected: Record<string, string> = {
      'IShape': 'public interface IShape<T> : IDisposable where T : class',
      'IShape.Area': 'double Area()',
      'IShape.Name': 'string Name { get; }',
      'Color': 'public enum Color : byte',
      'Color.Red': 'Red',
      'Color.Green': 'Green = 2',
      'Handler': 'public delegate void Handler<T>(object sender, T args)',
      'Point': 'public record Point(int X, int Y) : IShape<Point>',
      'Point.X': 'int X',
      'P2': 'public record struct P2(int X)',
      'Vec': 'public readonly struct Vec : IEquatable<Vec>',
      'Vec.X': 'public int X',
      'Derived': 'internal record Derived(int X, int Y, int Z) : Point(X, Y)',
      'Circle': 'public partial class Circle<T> : Base<T>, IShape<T>, System.IDisposable where T : new()',
      'Circle.MaxSize': 'public const int MaxSize = 10',
      'Circle._radius': 'private readonly int _radius',
      'Circle._other': 'private readonly int _other',
      'Circle.Log': 'private static readonly ILogger Log = LoggerFactory.Create("c")',
      'Circle.Changed': 'public static event EventHandler Changed',
      'Circle.Custom': 'public event EventHandler Custom',
      'Circle.Radius': 'public int Radius { get; set; }',
      'Circle.Twice': 'public int Twice',
      'Circle.Lazy': 'public int Lazy',
      'Circle.this[]': 'public int this[int i]',
      'Circle.Circle': 'public Circle(int r) : base(r)',
      'Circle.~Circle': '~Circle()',
      'Circle.operator +': 'public static Circle<T> operator +(Circle<T> a, Circle<T> b)',
      'Circle.operator int': 'public static implicit operator int(Circle<T> c)',
      'Circle.Area': 'public async Task<List<R>> Area<R>(Dictionary<string, R> m) where R : class',
      'Circle.Area.Local': 'int Local(int x)',
      'Circle.Nobody': 'public abstract void Nobody()',
      'Circle.Dispose': 'void IDisposable.Dispose()',
      'Ext.Len': 'public static int Len(this string s)',
    };
    for (const [qname, signature] of Object.entries(expected)) {
      assert.equal(sym(ex, qname).signature, signature, qname);
    }
  });

  it('captures XML docs without markup, line ranges and exported flags', async () => {
    const ex = await extractSource('A.cs', SRC);
    const shape = sym(ex, 'IShape');
    assert.equal(shape.doc, 'A shape with an Area.\nT: The item type.');
    assert.equal(shape.startLine, 13); // range starts at the attribute
    assert.equal(shape.endLine, 19);
    assert.equal(shape.docLine, 9);
    assert.equal(sym(ex, 'Circle').doc, 'Circle.');
    assert.equal(sym(ex, 'Circle.Circle').doc, 'Ctor.\nr: The radius.');
    assert.equal(sym(ex, 'Color.Red').doc, 'Red.');
    assert.equal(sym(ex, 'Circle.Radius').doc, 'The radius.'); // plain // comment
    assert.equal(sym(ex, 'Circle.Area').doc, '');
    assert.equal(sym(ex, 'Circle.Area').startLine, 59);
    assert.equal(sym(ex, 'Circle.Area').endLine, 73);

    const notExported = ex.symbols.filter(s => !s.exported).map(s => s.qname);
    assert.deepEqual(notExported, [
      'IShape.Hidden',
      'Derived', 'Derived.X', 'Derived.Y', 'Derived.Z',
      'Circle._radius', 'Circle._other', 'Circle.Log',
      'Circle.~Circle', 'Circle.Area.Local', 'Circle.Dispose', 'Circle.Inner.M',
      'Hidden',
    ]);
    assert.equal(ex.symbols[sym(ex, 'Circle.Inner.M').parent]!.qname, 'Circle.Inner');
    assert.equal(sym(ex, 'Circle').parent, -1);
  });

  it('extracts calls attributed to the enclosing symbol', async () => {
    const ex = await extractSource('A.cs', SRC);
    const calls = callList(ex);
    for (const expected of [
      'Circle.Log -> LoggerFactory.Create', // field initializer
      'Circle.Custom -> Sub', // event accessor
      'Circle.Twice -> Compute', // expression-bodied property
      'Circle.Lazy -> Load',
      'Circle.this[] -> Get',
      'Circle.Circle -> Base', // : base(r)
      'Circle.Circle -> Circle', // : this(1)
      'Circle.~Circle -> Cleanup',
      'Circle.Area.Local -> Abs', // local function
      'Circle.Area -> StringBuilder', // qualified constructor
      'Circle.Area -> Foo', // generic invocation
      'Circle.Area -> this.foo.Bar',
      'Circle.Area -> ?.Baz', // chained: receiver is a call
      'Circle.Area -> x.Maybe', // null-conditional
      'Circle.Area -> y.Inner.Deep', // null-conditional operators are dropped
      'Circle.Area -> Task.Run',
      'Circle.Area -> Helper', // inside a lambda
      'Circle.Area -> Open',
      'Circle.Area -> d.Read',
      'Circle.Area -> base.Area',
    ]) {
      assert.ok(calls.includes(expected), `missing '${expected}' in\n${calls.join('\n')}`);
    }
    // Target-typed `new()` cannot be resolved and attributes are not calls.
    assert.ok(!ex.calls.some(c => c.name === 'List' || c.name === 'HttpGet' || c.name === 'Obsolete'));
  });

  it('extracts using directives and heritage', async () => {
    const ex = await extractSource('A.cs', SRC);
    assert.deepEqual(importList(ex), [
      'System',
      'System.Collections.Generic',
      'System.Math',
      'System.Text.StringBuilder',
      'Foo.Bar',
    ]);
    assert.deepEqual(ex.imports.map(i => i.names), [[], [], ['Math'], ['Alias'], []]);
    assert.deepEqual(ex.imports.map(i => i.line), [1, 2, 3, 4, 5]);
    assert.deepEqual(heritageList(ex), [
      'IShape extends IDisposable',
      'Point implements IShape',
      'Vec implements IEquatable',
      'Derived extends Point',
      'Circle extends Base',
      'Circle implements IShape',
      'Circle implements IDisposable',
    ]);
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('A.cs', SRC);
    assert.deepEqual(occLines(ex, 'IShape'), [14, 30, 37]);
    assert.deepEqual(occLines(ex, '_radius'), [40, 46, 52]);
    assert.deepEqual(occLines(ex, 'Helper'), [70]);
    assert.deepEqual(occLines(ex, 'StringBuilder'), [4, 64]);
  });

  it('handles file-scoped namespaces, top-level statements and primary constructors', async () => {
    const ex = await extractSource('Program.cs', `using System;
namespace My.App;

var x = Compute(1);
Console.WriteLine(x);

static int Compute(int v) => Math.Abs(v);

class Top(int a) : Base(a), IRunner
{
    class Nested { void M() { Go(); } }
}
`);
    assert.deepEqual(symbolList(ex), [
      'function Compute',
      'class Top',
      'class Top.Nested',
      'method Top.Nested.M',
    ]);
    assert.equal(sym(ex, 'Compute').signature, 'static int Compute(int v)');
    assert.equal(sym(ex, 'Top').signature, 'class Top(int a) : Base(a), IRunner');
    assert.deepEqual(callList(ex), [
      '<file> -> Compute',
      '<file> -> Console.WriteLine',
      'Compute -> Math.Abs',
      'Top.Nested.M -> Go',
    ]);
    assert.deepEqual(importList(ex), ['System']);
    assert.deepEqual(heritageList(ex), ['Top extends Base', 'Top implements IRunner']);
  });

  it('handles partial classes, extension methods, generics and interface members', async () => {
    const ex = await extractSource('B.cs', `
namespace N
{
    public partial class Repo<TKey, TValue> : Dictionary<TKey, List<TValue>>, IRepo<TKey>
        where TKey : notnull
    {
        public partial void Load();
    }

    public partial class Repo<TKey, TValue>
    {
        public partial void Load() { Fetch<TKey>(); }
        public required string Name { get; init; }
        protected virtual TValue? Find(TKey key) => default;
        public static (int Count, string Label) Stats() => (0, "");
    }

    public interface IRepo<in TKey> : IReadable, IWritable
    {
        event EventHandler Saved;
        int Count { get; }
        void Save(TKey key);
        static abstract IRepo<TKey> Create();
    }

    internal static class RepoExtensions
    {
        public static bool Any<T>(this IEnumerable<T> source, Func<T, bool> predicate)
        {
            foreach (var item in source) { if (predicate(item)) return true; }
            return source.Where(predicate).Count() > 0;
        }
    }

    public struct Money : IComparable<Money>
    {
        public decimal Amount { get; }
        public static bool operator ==(Money a, Money b) => a.Equals(b);
        public static explicit operator decimal(Money m) => m.Amount;
    }
}
`);
    assert.deepEqual(symbolList(ex), [
      'class Repo',
      'method Repo.Load',
      'class Repo',
      'method Repo.Load',
      'property Repo.Name',
      'method Repo.Find',
      'method Repo.Stats',
      'interface IRepo',
      'field IRepo.Saved',
      'property IRepo.Count',
      'method IRepo.Save',
      'method IRepo.Create',
      'class RepoExtensions',
      'method RepoExtensions.Any',
      'struct Money',
      'property Money.Amount',
      'method Money.operator ==',
      'method Money.operator decimal',
    ]);
    assert.equal(
      ex.symbols[0]!.signature,
      'public partial class Repo<TKey, TValue> : Dictionary<TKey, List<TValue>>, IRepo<TKey> where TKey : notnull'
    );
    assert.equal(ex.symbols[1]!.signature, 'public partial void Load()');
    assert.equal(sym(ex, 'Repo.Name').signature, 'public required string Name { get; init; }');
    assert.equal(sym(ex, 'Repo.Find').signature, 'protected virtual TValue? Find(TKey key)');
    assert.equal(sym(ex, 'Repo.Stats').signature, 'public static (int Count, string Label) Stats()');
    assert.equal(
      sym(ex, 'RepoExtensions.Any').signature,
      'public static bool Any<T>(this IEnumerable<T> source, Func<T, bool> predicate)'
    );
    assert.equal(sym(ex, 'IRepo.Save').exported, true);
    assert.equal(sym(ex, 'IRepo.Count').exported, true);
    assert.equal(sym(ex, 'IRepo.Saved').exported, true);
    assert.equal(sym(ex, 'RepoExtensions').exported, false);
    assert.equal(sym(ex, 'RepoExtensions.Any').exported, true);
    assert.deepEqual(heritageList(ex), [
      'Repo extends Dictionary',
      'Repo implements IRepo',
      'IRepo extends IReadable',
      'IRepo extends IWritable',
      'Money implements IComparable',
    ]);
    const calls = callList(ex);
    assert.ok(calls.includes('Repo.Load -> Fetch'));
    assert.ok(calls.includes('RepoExtensions.Any -> predicate'));
    assert.ok(calls.includes('RepoExtensions.Any -> source.Where'));
    assert.ok(calls.includes('RepoExtensions.Any -> ?.Count'));
    assert.ok(calls.includes('Money.operator == -> a.Equals'));
  });

  it('does not create symbols for locals and lambdas, and tolerates broken source', async () => {
    const ex = await extractSource('C.cs', `
class Holder
{
    private readonly Func<int, int> _twice = v => Scale(v, 2);
    void Run()
    {
        var s = "x";
        int a = 1, b = 2;
        Action act = () => { var inner = Make(); Use(inner); };
        foreach (var i in Items()) { Use(s, i); }
    }
}
`);
    assert.deepEqual(symbolList(ex), ['class Holder', 'field Holder._twice', 'method Holder.Run']);
    const calls = callList(ex);
    assert.ok(calls.includes('Holder._twice -> Scale'));
    assert.ok(calls.includes('Holder.Run -> Make'));
    assert.ok(calls.includes('Holder.Run -> Use'));
    assert.ok(calls.includes('Holder.Run -> Items'));

    const broken = await extractSource('D.cs', `
public class Broken
{
    public void Ok() { Run(); }
    public void Bad( { int x = ; }
    private int
    public void After() { Done(); }
}
`);
    assert.equal(broken.hadError, true);
    assert.ok(symbolList(broken).includes('class Broken'));
    assert.ok(symbolList(broken).includes('method Broken.Ok'));
    assert.ok(callList(broken).includes('Broken.Ok -> Run'));
  });

  it('resolves receivers to declared types', async () => {
    const ex = await extractSource('E.cs', `
namespace N;

public class Middleware(ILogger<Middleware> logger, int size) : Base(size)
{
    private readonly RequestDelegate _next;
    private readonly Foo[] _many;
    private static readonly Cache Shared = new();
    public IOptions Options { get; }
    public Store? Store { get; set; }
    public event EventHandler Changed;

    public Middleware(RequestDelegate next) { _next = next; }

    public async Task Invoke(HttpContext context, out Bar bar, ref Baz baz, in Qux qux, params Extra[] extras)
    {
        logger.LogInformation("x");
        _next.Invoke(context);
        this._next.Begin();
        context.GetEndpoint();
        bar.B(); baz.Z(); qux.Q();
        Options.Validate();
        Store?.Save();
        Store!.Load();
        Shared.Clear();
        _many.Each();
        Thing a = new();
        a.Start();
        var sb = new System.Text.StringBuilder();
        sb.Append("x");
        var unknown = Make();
        unknown.Go();
        var casted = (Widget)unknown;
        casted.Spin();
        var soft = unknown as Gadget;
        soft.Buzz();
        foreach (Item it in Items()) { it.Run(); }
        foreach (var v in Items()) { v.Run(); }
        if (unknown is Leaf leaf) leaf.Fall();
        if (unknown is Tree { Height: 1 } tree) tree.Grow();
        switch (unknown) { case Rock rock: rock.Roll(); break; }
        try { } catch (IOException e) { e.Log(); }
        using var s1 = new MemoryStream();
        s1.Flush();
        using (Reader r = Open()) { r.Read(); }
        if (map.TryGetValue(1, out Entry entry)) entry.Touch();
        Each((Node node) => node.Visit());
        Each(x => x.Visit());
        new WebApplicationBuilder(1).Build();
        app.Services.GetService();
        context.Inner?.Deep();
        Pool<int>.Rent();
        base.Invoke();
        Helper();
        void Local(Part part) { part.Fit(); logger.LogDebug("y"); }
    }
}

public static class Ext
{
    public static void Use(this IApplicationBuilder app) => app.UseRouting();
}

public record Order(Customer Customer, int Total)
{
    public void Ship() { Customer.Notify(); }
}

public delegate void Handler(Sender sender);
`);
    assert.equal(ex.hadError, false);
    const call = (name: string) => {
      const c = ex.calls.find(x => x.name === name);
      assert.ok(c, `call ${name} not found`);
      return [c.receiver, c.rtype];
    };
    const all = (name: string) => ex.calls.filter(c => c.name === name).map(c => [c.receiver, c.rtype]);
    // Primary-constructor parameters act like fields, also inside local functions.
    assert.deepEqual(call('LogInformation'), ['logger', 'ILogger']);
    assert.deepEqual(call('LogDebug'), ['logger', 'ILogger']);
    // Fields, with and without this.
    assert.deepEqual(all('Invoke'), [['_next', 'RequestDelegate'], ['base', null]]);
    assert.deepEqual(call('Begin'), ['this._next', 'RequestDelegate']);
    assert.deepEqual(call('Clear'), ['Shared', 'Cache']);
    assert.deepEqual(call('Each'), ['_many', null]); // arrays have no class type
    // Parameters incl. out / ref / in and extension receivers.
    assert.deepEqual(call('GetEndpoint'), ['context', 'HttpContext']);
    assert.deepEqual(call('B'), ['bar', 'Bar']);
    assert.deepEqual(call('Z'), ['baz', 'Baz']);
    assert.deepEqual(call('Q'), ['qux', 'Qux']);
    assert.deepEqual(call('UseRouting'), ['app', 'IApplicationBuilder']);
    assert.deepEqual(call('Fit'), ['part', 'Part']);
    // Properties; ?. and ! do not change the receiver.
    assert.deepEqual(call('Validate'), ['Options', 'IOptions']);
    assert.deepEqual(call('Save'), ['Store', 'Store']);
    assert.deepEqual(call('Load'), ['Store', 'Store']);
    assert.deepEqual(call('Notify'), ['Customer', 'Customer']); // positional record parameter
    // Locals: explicit type with target-typed new, var + new / cast / as.
    assert.deepEqual(call('Start'), ['a', 'Thing']);
    assert.deepEqual(call('Append'), ['sb', 'StringBuilder']);
    assert.deepEqual(call('Go'), ['unknown', null]);
    assert.deepEqual(call('Spin'), ['casted', 'Widget']);
    assert.deepEqual(call('Buzz'), ['soft', 'Gadget']);
    // foreach, patterns, catch, using, out variables, typed lambda parameters.
    assert.deepEqual(all('Run'), [['it', 'Item'], ['v', null]]);
    assert.deepEqual(call('Fall'), ['leaf', 'Leaf']);
    assert.deepEqual(call('Grow'), ['tree', 'Tree']);
    assert.deepEqual(call('Roll'), ['rock', 'Rock']);
    assert.deepEqual(call('Log'), ['e', 'IOException']);
    assert.deepEqual(call('Flush'), ['s1', 'MemoryStream']);
    assert.deepEqual(call('Read'), ['r', 'Reader']);
    assert.deepEqual(call('Touch'), ['entry', 'Entry']);
    assert.deepEqual(all('Visit'), [['node', 'Node'], ['x', null]]);
    // Receivers: chains, nested member access, generic static class, bare calls.
    assert.deepEqual(call('Build'), ['?', null]);
    assert.deepEqual(call('GetService'), ['app.Services', null]);
    assert.deepEqual(call('Deep'), ['context.Inner', 'HttpContext#Inner']);
    assert.deepEqual(call('Rent'), ['Pool', null]);
    assert.deepEqual(call('Helper'), [null, null]);
  });

  it('resolves members through a typed receiver whose class is in the same file', async () => {
    const ex = await extractSource('F.cs', `
class App { public IServiceProvider Services { get; } public Router Router; }
class Runner
{
    void Run(App app) { app.Services.GetService(); app.Router.Map(); app.Missing.Call(); }
}
delegate void Handler(Sender sender);
class Late { void M() { sender.Send(); } }
`);
    const all = (name: string) => ex.calls.filter(c => c.name === name).map(c => [c.receiver, c.rtype]);
    assert.deepEqual(all('GetService'), [['app.Services', 'IServiceProvider']]);
    assert.deepEqual(all('Map'), [['app.Router', 'Router']]);
    assert.deepEqual(all('Call'), [['app.Missing', null]]);
    // Delegate parameters are not variables.
    assert.deepEqual(all('Send'), [['sender', null]]);
  });

  it('records attribute usages as references to the Attribute class', async () => {
    const ex = await extractSource('G.cs', `using System;
[Serializable]
public class AuthorizeAttribute : Attribute { }

[Authorize]
[Authorize(Roles = "admin"), Mvc.Route("x")]
public class Home
{
    [return: NotNull]
    [ObsoleteAttribute("old")]
    public string Index([FromBody] Model m) => "";
}
`);
    assert.deepEqual(occLines(ex, 'AuthorizeAttribute'), [3, 5, 6]);
    assert.deepEqual(occLines(ex, 'Authorize'), [5, 6]);
    assert.deepEqual(occLines(ex, 'RouteAttribute'), [6]);
    assert.deepEqual(occLines(ex, 'NotNullAttribute'), [9]);
    assert.deepEqual(occLines(ex, 'FromBodyAttribute'), [11]);
    assert.deepEqual(occLines(ex, 'SerializableAttribute'), [2]);
    assert.deepEqual(occLines(ex, 'ObsoleteAttribute'), [10]);
    assert.deepEqual(occLines(ex, 'ObsoleteAttributeAttribute'), []);
    // Attributes are not calls.
    assert.ok(!ex.calls.some(c => c.name.startsWith('Authorize')));
  });
});
