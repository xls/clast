import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, heritageList, importList, occLines, sym, symbolList } from '../helpers.js';

const SRC = `package com.example.app;

import java.util.List;
import java.util.*;
import static java.util.Objects.requireNonNull;

/**
 * A shape.
 */
@FunctionalInterface
public interface Shape<T> extends Comparable<T>, java.io.Serializable {
    int SIDES = 4;
    double area();
    default String describe() { return "x" + area(); }
}

public enum Color implements Shape<Color> {
    /** Red. */
    RED(1), GREEN(2) { @Override void x() { foo(); } };
    private final int v;
    Color(int v) { this.v = v; }
}

public record Point(int x, @Deprecated int y) implements Shape<Point> {
    public Point { requireNonNull(x); }
    static Point origin() { return new Point(0, 0); }
}

public @interface Marker { String value() default ""; }

/** Circle doc. */
@SuppressWarnings("unchecked")
public final class Circle<T extends Number> extends Base<T> implements Shape<T>, Runnable {
    public static final int MAX_SIZE = 10, MIN_SIZE = 1;
    private static final Logger log = LoggerFactory.getLogger(Circle.class);
    private int radius, other;
    static { init(); }

    /** Ctor. */
    @Inject
    public Circle(int r) { super(r); this.radius = r; }

    Circle() { this(1); }

    // Computes the area.
    @Override
    public <R> List<R> area(Map<String, R> m) throws IOException {
        int local = 1;
        Runnable r = () -> helper(local);
        list.stream().map(String::valueOf).forEach(System.out::println);
        Object o = new java.util.ArrayList<String>();
        Supplier<Circle> s = Circle::new;
        new Thread(new Runnable() {
            int count;
            public void run() { inner(); }
        }).start();
        this.foo.bar().baz();
        return super.area();
    }

    abstract void nobody();

    public static class Inner {
        void m() { class Local { void deep() { go(); } } }
        protected interface Callback { void done(); }
    }
}
`;

describe('java extraction', () => {
  it('extracts symbols with qualified names and kinds', async () => {
    const ex = await extractSource('A.java', SRC);
    assert.deepEqual(symbolList(ex), [
      'interface Shape',
      'constant Shape.SIDES',
      'method Shape.area',
      'method Shape.describe',
      'enum Color',
      'constant Color.RED',
      'constant Color.GREEN',
      'method Color.GREEN.x',
      'field Color.v',
      'method Color.Color',
      'class Point',
      'field Point.x',
      'field Point.y',
      'method Point.Point',
      'method Point.origin',
      'interface Marker',
      'method Marker.value',
      'class Circle',
      'constant Circle.MAX_SIZE',
      'constant Circle.MIN_SIZE',
      'field Circle.log',
      'field Circle.radius',
      'field Circle.other',
      'method Circle.Circle',
      'method Circle.Circle',
      'method Circle.area',
      'method Circle.nobody',
      'class Circle.Inner',
      'method Circle.Inner.m',
      'class Circle.Inner.m.Local',
      'method Circle.Inner.m.Local.deep',
      'interface Circle.Inner.Callback',
      'method Circle.Inner.Callback.done',
    ]);
    assert.equal(ex.hadError, false);
  });

  it('builds signatures without annotations, bodies or trailing punctuation', async () => {
    const ex = await extractSource('A.java', SRC);
    assert.equal(sym(ex, 'Shape').signature, 'public interface Shape<T> extends Comparable<T>, java.io.Serializable');
    assert.equal(sym(ex, 'Shape.SIDES').signature, 'int SIDES = 4');
    assert.equal(sym(ex, 'Shape.area').signature, 'double area()');
    assert.equal(sym(ex, 'Shape.describe').signature, 'default String describe()');
    assert.equal(sym(ex, 'Color').signature, 'public enum Color implements Shape<Color>');
    assert.equal(sym(ex, 'Color.RED').signature, 'RED(1)');
    assert.equal(sym(ex, 'Color.GREEN').signature, 'GREEN(2)');
    assert.equal(sym(ex, 'Color.GREEN.x').signature, 'void x()');
    assert.equal(sym(ex, 'Point').signature, 'public record Point(int x, @Deprecated int y) implements Shape<Point>');
    assert.equal(sym(ex, 'Point.x').signature, 'int x');
    assert.equal(sym(ex, 'Point.y').signature, 'int y');
    assert.equal(sym(ex, 'Point.Point').signature, 'public Point');
    assert.equal(sym(ex, 'Marker').signature, 'public @interface Marker');
    assert.equal(sym(ex, 'Marker.value').signature, 'String value() default ""');
    assert.equal(
      sym(ex, 'Circle').signature,
      'public final class Circle<T extends Number> extends Base<T> implements Shape<T>, Runnable'
    );
    assert.equal(sym(ex, 'Circle.MAX_SIZE').signature, 'public static final int MAX_SIZE = 10');
    assert.equal(sym(ex, 'Circle.MIN_SIZE').signature, 'public static final int MIN_SIZE = 1');
    assert.equal(sym(ex, 'Circle.log').signature, 'private static final Logger log = LoggerFactory.getLogger(Circle.class)');
    assert.equal(sym(ex, 'Circle.radius').signature, 'private int radius');
    assert.equal(sym(ex, 'Circle.other').signature, 'private int other');
    assert.equal(sym(ex, 'Circle.Circle').signature, 'public Circle(int r)');
    assert.equal(sym(ex, 'Circle.area').signature, 'public <R> List<R> area(Map<String, R> m) throws IOException');
    assert.equal(sym(ex, 'Circle.nobody').signature, 'abstract void nobody()');
    assert.equal(sym(ex, 'Circle.Inner').signature, 'public static class Inner');
  });

  it('captures docs, line ranges and exported flags', async () => {
    const ex = await extractSource('A.java', SRC);
    const shape = sym(ex, 'Shape');
    assert.equal(shape.doc, 'A shape.');
    assert.equal(shape.startLine, 10); // range starts at the annotation
    assert.equal(shape.endLine, 15);
    assert.equal(shape.docLine, 7);
    assert.equal(sym(ex, 'Circle').doc, 'Circle doc.');
    assert.equal(sym(ex, 'Circle.Circle').doc, 'Ctor.');
    assert.equal(sym(ex, 'Circle.area').doc, 'Computes the area.');
    assert.equal(sym(ex, 'Color.RED').doc, 'Red.');
    assert.equal(sym(ex, 'Color.GREEN').doc, '');
    assert.equal(sym(ex, 'Circle.nobody').doc, '');

    const exported = ex.symbols.filter(s => s.exported).map(s => s.qname);
    assert.deepEqual(exported, [
      'Shape', 'Shape.SIDES', 'Shape.area', 'Shape.describe',
      'Color', 'Color.RED', 'Color.GREEN',
      'Point', 'Point.x', 'Point.y', 'Point.Point',
      'Marker', 'Marker.value',
      'Circle', 'Circle.MAX_SIZE', 'Circle.MIN_SIZE', 'Circle.Circle', 'Circle.area',
      'Circle.Inner', 'Circle.Inner.Callback.done',
    ]);
    // Parent links follow lexical nesting.
    assert.equal(ex.symbols[sym(ex, 'Circle.Inner.m').parent]!.qname, 'Circle.Inner');
    assert.equal(sym(ex, 'Circle').parent, -1);
  });

  it('extracts calls attributed to the enclosing symbol', async () => {
    const ex = await extractSource('A.java', SRC);
    const calls = callList(ex);
    for (const expected of [
      'Shape.describe -> area',
      'Color.GREEN.x -> foo',
      'Point.Point -> requireNonNull',
      'Point.origin -> Point',
      'Circle.log -> LoggerFactory.getLogger',
      'Circle -> init', // static initializer
      'Circle.Circle -> Base', // super(r)
      'Circle.Circle -> Circle', // this(1)
      'Circle.area -> helper', // inside a lambda
      'Circle.area -> list.stream',
      'Circle.area -> map',
      'Circle.area -> forEach',
      'Circle.area -> String.valueOf', // method reference
      'Circle.area -> System.out.println',
      'Circle.area -> ArrayList', // qualified + generic constructor
      'Circle.area -> Circle', // Circle::new
      'Circle.area -> Thread',
      'Circle.area -> Runnable',
      'Circle.area -> inner', // inside an anonymous class
      'Circle.area -> start',
      'Circle.area -> this.foo.bar',
      'Circle.area -> baz',
      'Circle.area -> super.area',
      'Circle.Inner.m.Local.deep -> go',
    ]) {
      assert.ok(calls.includes(expected), `missing '${expected}' in\n${calls.join('\n')}`);
    }
  });

  it('extracts imports and heritage', async () => {
    const ex = await extractSource('A.java', SRC);
    assert.deepEqual(importList(ex), ['java.util.List', 'java.util.*', 'java.util.Objects.requireNonNull']);
    assert.deepEqual(ex.imports.map(i => i.names), [['List'], ['*'], ['requireNonNull']]);
    assert.deepEqual(ex.imports.map(i => i.line), [3, 4, 5]);
    assert.deepEqual(heritageList(ex), [
      'Shape extends Comparable',
      'Shape extends Serializable',
      'Color implements Shape',
      'Point implements Shape',
      'Circle extends Base',
      'Circle implements Shape',
      'Circle implements Runnable',
    ]);
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('A.java', SRC);
    assert.deepEqual(occLines(ex, 'Shape'), [11, 17, 24, 33]);
    assert.deepEqual(occLines(ex, 'requireNonNull'), [5, 25]);
    assert.deepEqual(occLines(ex, 'radius'), [36, 41]);
    assert.deepEqual(occLines(ex, 'helper'), [49]);
  });

  it('does not create symbols for locals, lambdas or anonymous class members', async () => {
    const ex = await extractSource('B.java', `
class Holder {
    private final Comparator<String> cmp = new Comparator<String>() {
        private int calls;
        @Override public int compare(String a, String b) { return weigh(a) - weigh(b); }
    };
    private final Runnable task = () -> { int n = 0; tick(n); };
    void run() {
        String s = "x";
        for (int i = 0; i < 3; i++) { use(s, i); }
        try (Reader r = open()) { r.read(); } catch (Exception e) { fail(e); }
    }
}
`);
    assert.deepEqual(symbolList(ex), ['class Holder', 'field Holder.cmp', 'field Holder.task', 'method Holder.run']);
    const calls = callList(ex);
    assert.ok(calls.includes('Holder.cmp -> Comparator'));
    assert.ok(calls.includes('Holder.cmp -> weigh'));
    assert.ok(calls.includes('Holder.task -> tick'));
    assert.ok(calls.includes('Holder.run -> use'));
    assert.ok(calls.includes('Holder.run -> open'));
    assert.ok(calls.includes('Holder.run -> r.read'));
    assert.ok(calls.includes('Holder.run -> fail'));
    // A long initializer is cut from the field signature.
    assert.equal(sym(ex, 'Holder.cmp').signature, 'private final Comparator<String> cmp');
  });

  it('handles generics, sealed types, nested generics and array types', async () => {
    const ex = await extractSource('C.java', `
public sealed interface Node<T> permits Leaf, Branch {}
public abstract class Repo<K extends Comparable<K>, V> extends AbstractMap<K, List<V>>
        implements java.io.Closeable, Iterable<Map.Entry<K, V>> {
    protected static final Map<String, List<Integer>> CACHE = new HashMap<>();
    public static <A, B extends A> Map<A, B> pair(A a, B b) { return Map.of(a, b); }
    public abstract Optional<V> find(K key) throws IOException, IllegalStateException;
    String[] names() { return new String[0]; }
    Outer.Inner<V> make() { return new Outer.Inner<>(this); }
}
`);
    assert.deepEqual(symbolList(ex), [
      'interface Node',
      'class Repo',
      'constant Repo.CACHE',
      'method Repo.pair',
      'method Repo.find',
      'method Repo.names',
      'method Repo.make',
    ]);
    assert.equal(sym(ex, 'Node').signature, 'public sealed interface Node<T> permits Leaf, Branch');
    assert.equal(sym(ex, 'Repo.pair').signature, 'public static <A, B extends A> Map<A, B> pair(A a, B b)');
    assert.equal(
      sym(ex, 'Repo.find').signature,
      'public abstract Optional<V> find(K key) throws IOException, IllegalStateException'
    );
    assert.deepEqual(heritageList(ex), [
      'Repo extends AbstractMap',
      'Repo implements Closeable',
      'Repo implements Iterable',
    ]);
    const calls = callList(ex);
    assert.ok(calls.includes('Repo.CACHE -> HashMap'));
    assert.ok(calls.includes('Repo.pair -> Map.of'));
    assert.ok(calls.includes('Repo.make -> Inner'));
  });

  it('tolerates broken source', async () => {
    const ex = await extractSource('D.java', `
public class Broken {
    public void ok() { run(); }
    public void bad( { int x = ; }
    private int count
    void after() { done(); }
}
`);
    assert.equal(ex.hadError, true);
    assert.ok(symbolList(ex).includes('class Broken'));
    assert.ok(symbolList(ex).includes('method Broken.ok'));
    assert.ok(symbolList(ex).includes('method Broken.after'));
    assert.ok(callList(ex).includes('Broken.ok -> run'));
    assert.ok(callList(ex).includes('Broken.after -> done'));

    // Truncated file: the class header is lost but members are still found.
    const cut = await extractSource('E.java', 'public class Cut {\n    public void ok() { run(); }\n    private int');
    assert.equal(cut.hadError, true);
    assert.ok(cut.symbols.some(s => s.name === 'ok' && s.kind === 'method'));
    assert.ok(cut.calls.some(c => c.name === 'run'));
  });
});
