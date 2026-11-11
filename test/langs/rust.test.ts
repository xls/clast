import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, heritageList, importList, occLines, sym, symbolList } from '../helpers.js';

const SRC = `//! Crate doc.
use std::collections::HashMap;
use std::{fmt, io::{self, Read as R}, sync::*};
use crate::a::b as c;
pub use self::x::Y;
mod foo;
extern crate serde;

/// Doc for S.
/// Second line.
#[derive(Debug)]
pub struct S<T: Clone> {
    /// Field doc.
    pub a: T,
    b: u32,
}

pub struct Tup(pub u32, String);
struct Unit;

// E doc.
pub enum E {
    A,
    B(u32),
    /// C doc.
    C { x: u8 },
}

union U { a: u32, b: f32 }

pub trait Tr: Clone + fmt::Debug {
    type Item;
    const N: usize;
    fn req(&self) -> u32;
    fn def(&self) { self.req(); }
}

impl<T: Clone> S<T> {
    pub const K: u32 = 1;

    /// New doc.
    pub fn new(a: T) -> Self
    where
        T: Clone,
    {
        let v = Vec::<u8>::new();
        const LOCAL: u8 = 1;
        helper(1);
        a.clone().conv::<u8>();
        println!("x {}", bar(2));
        let c = |x| inner(x);
        fn nested() { deep(); }
        let _ = Some(c(1));
        S { a, b: 0 }
    }
}

impl<T: Clone> Tr for S<T> {
    type Item = u8;
    const N: usize = 1;
    fn req(&self) -> u32 { E::B(1); self.b }
}

impl fmt::Display for Unit {}

pub(crate) mod m {
    pub fn f() {}
    pub mod n {
        const X: u8 = 1;
        static mut Y: u8 = 2;
        pub type Z = u8;
    }
}

#[macro_export]
macro_rules! mac { () => { fn template() {} }; }
macro_rules! private_mac { () => {}; }

pub async unsafe fn g<T>(x: T) -> T where T: Clone { x }

extern "C" { fn ext(a: i32); }
`;

describe('rust extraction', () => {
  it('extracts symbols with qualified names and kinds', async () => {
    const ex = await extractSource('a.rs', SRC);
    assert.deepEqual(symbolList(ex), [
      'struct S',
      'field S.a',
      'field S.b',
      'struct Tup',
      'struct Unit',
      'enum E',
      'constant E.A',
      'constant E.B',
      'constant E.C',
      'struct U',
      'field U.a',
      'field U.b',
      'trait Tr',
      'type Tr.Item',
      'constant Tr.N',
      'method Tr.req',
      'method Tr.def',
      'constant S.K',
      'method S.new',
      'function S.new.nested',
      'type S.Item',
      'constant S.N',
      'method S.req',
      'namespace m',
      'function m.f',
      'namespace m.n',
      'constant m.n.X',
      'constant m.n.Y',
      'type m.n.Z',
      'macro mac',
      'macro private_mac',
      'function g',
      'function ext',
    ]);
  });

  it('captures signatures', async () => {
    const ex = await extractSource('a.rs', SRC);
    assert.equal(sym(ex, 'S').signature, 'pub struct S<T: Clone>');
    assert.equal(sym(ex, 'S.a').signature, 'pub a: T');
    assert.equal(sym(ex, 'Tup').signature, 'pub struct Tup(pub u32, String)');
    assert.equal(sym(ex, 'Unit').signature, 'struct Unit');
    assert.equal(sym(ex, 'E').signature, 'pub enum E');
    assert.equal(sym(ex, 'E.B').signature, 'B(u32)');
    assert.equal(sym(ex, 'E.C').signature, 'C');
    assert.equal(sym(ex, 'U').signature, 'union U');
    assert.equal(sym(ex, 'Tr').signature, 'pub trait Tr: Clone + fmt::Debug');
    assert.equal(sym(ex, 'Tr.req').signature, 'fn req(&self) -> u32');
    assert.equal(sym(ex, 'Tr.N').signature, 'const N: usize');
    assert.equal(sym(ex, 'S.K').signature, 'pub const K: u32 = 1');
    assert.equal(sym(ex, 'S.new').signature, 'pub fn new(a: T) -> Self where T: Clone');
    assert.equal(sym(ex, 'm').signature, 'pub(crate) mod m');
    assert.equal(sym(ex, 'm.n.Y').signature, 'static mut Y: u8 = 2');
    assert.equal(sym(ex, 'm.n.Z').signature, 'pub type Z = u8');
    assert.equal(sym(ex, 'mac').signature, 'macro_rules! mac');
    assert.equal(sym(ex, 'g').signature, 'pub async unsafe fn g<T>(x: T) -> T where T: Clone');
    assert.equal(sym(ex, 'ext').signature, 'fn ext(a: i32)');
  });

  it('captures docs, also behind attributes', async () => {
    const ex = await extractSource('a.rs', SRC);
    assert.equal(sym(ex, 'S').doc, 'Doc for S.\nSecond line.');
    assert.equal(sym(ex, 'S.a').doc, 'Field doc.');
    assert.equal(sym(ex, 'S.b').doc, '');
    assert.equal(sym(ex, 'E').doc, 'E doc.');
    assert.equal(sym(ex, 'E.C').doc, 'C doc.');
    assert.equal(sym(ex, 'S.new').doc, 'New doc.');
    assert.ok(sym(ex, 'S.new').docLine > 0);
    assert.equal(sym(ex, 'Tup').doc, '');
  });

  it('keeps the beginning of long docs and stops at blank lines', async () => {
    const long = Array.from({ length: 90 }, (_, i) => `/// line ${i}`).join('\n');
    const ex = await extractSource('d.rs', `/// detached\n\n${long}\npub fn documented() {}\n`);
    const doc = sym(ex, 'documented').doc;
    assert.ok(doc.startsWith('line 0\nline 1\n'), doc.slice(0, 40));
    assert.ok(!doc.includes('detached'));
  });

  it('sets exported from visibility and line ranges', async () => {
    const ex = await extractSource('a.rs', SRC);
    for (const q of ['S', 'S.a', 'Tup', 'E', 'E.A', 'Tr', 'Tr.req', 'Tr.Item', 'S.K', 'S.new', 'm', 'm.f', 'm.n.Z', 'mac', 'g']) {
      assert.equal(sym(ex, q).exported, true, q);
    }
    for (const q of ['S.b', 'Unit', 'U', 'S.req', 'S.new.nested', 'm.n.X', 'private_mac', 'ext']) {
      assert.equal(sym(ex, q).exported, false, q);
    }
    const s = sym(ex, 'S');
    assert.equal(s.startLine, 12);
    assert.equal(s.endLine, 16);
    assert.equal(ex.symbols[sym(ex, 'S.a').parent]!.qname, 'S');
    assert.equal(ex.symbols[sym(ex, 'S.new.nested').parent]!.qname, 'S.new');
  });

  it('does not turn locals or macro templates into symbols', async () => {
    const ex = await extractSource('a.rs', SRC);
    const names = ex.symbols.map(s => s.name);
    for (const n of ['v', 'c', 'LOCAL', 'template', 'x']) assert.ok(!names.includes(n), `${n} must not be a symbol`);
  });

  it('extracts calls attributed to the enclosing symbol', async () => {
    const ex = await extractSource('a.rs', SRC);
    const calls = callList(ex);
    for (const c of [
      'Tr.def -> self.req',
      'S.new -> Vec.new',
      'S.new -> helper',
      'S.new -> ?.conv',
      'S.new -> a.clone',
      'S.new -> println',
      'S.new -> bar',
      'S.new -> inner',
      'S.new -> c',
      'S.new -> S',
      'S.new.nested -> deep',
      'S.req -> E.B',
    ]) {
      assert.ok(calls.includes(c), `missing '${c}' in ${calls.join(' | ')}`);
    }
    assert.ok(!ex.calls.some(c => c.name === 'Some'), 'Some(..) is not a call');
    assert.ok(!ex.calls.some(c => c.name === 'derive' || c.name === 'Debug'), 'attributes are not calls');
  });

  it('extracts imports, flattening use groups', async () => {
    const ex = await extractSource('a.rs', SRC);
    assert.deepEqual(importList(ex), [
      'std::collections::HashMap',
      'std::fmt',
      'std::io',
      'std::io::Read',
      'std::sync::*',
      'crate::a::b',
      'self::x::Y',
      'self::foo',
      'serde',
    ]);
    assert.deepEqual(ex.imports[0]!.names, ['HashMap']);
    assert.deepEqual(ex.imports[2]!.names, ['io']);
    assert.deepEqual(ex.imports[3]!.names, ['R=Read']); // alias=original
    assert.deepEqual(ex.imports[5]!.names, ['c']);
    assert.equal(ex.imports[3]!.line, 3);
  });

  it('records supertraits and trait impls as heritage', async () => {
    const ex = await extractSource('a.rs', SRC);
    assert.deepEqual(heritageList(ex), [
      'Tr extends Clone',
      'Tr extends Debug',
      'S implements Tr',
      'Unit implements Display',
    ]);
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('a.rs', SRC);
    assert.deepEqual(occLines(ex, 'helper'), [48]);
    assert.deepEqual(occLines(ex, 'Tr'), [31, 58]);
    assert.deepEqual(occLines(ex, 'req'), [34, 35, 61]);
    assert.deepEqual(occLines(ex, 'Unit'), [19, 64]);
  });

  it('extracts items and calls from macro arguments', async () => {
    const ex = await extractSource('m.rs', `cfg_rt! {
    /// Spawn doc.
    #[track_caller]
    pub(crate) fn spawn<T: Send>(x: T) -> Vec<T> where T: Clone {
        inner(x);
        x.method(1);
        log!("a");
    }

    #[cfg(all(feature = "x", not(test)))]
    pub struct Foo { a: u32 }

    impl<T: Into<Vec<u8>>> fmt::Debug for Foo {
        fn fmt(&self) -> impl Iterator<Item = u8> { helper(1) }
    }

    pub trait Tq { fn sig(&self); }
    pub const LIMIT: usize = 10;
    mod zed;
}
`);
    assert.deepEqual(symbolList(ex).sort(), [
      'constant LIMIT',
      'function spawn',
      'method Foo.fmt',
      'method Tq.sig',
      'struct Foo',
      'trait Tq',
    ]);
    const spawn = sym(ex, 'spawn');
    assert.equal(spawn.signature, 'pub(crate) fn spawn<T: Send>(x: T) -> Vec<T> where T: Clone');
    assert.equal(spawn.doc, 'Spawn doc.');
    assert.equal(spawn.exported, true);
    assert.equal(sym(ex, 'Foo.fmt').signature, 'fn fmt(&self) -> impl Iterator<Item = u8>');
    assert.deepEqual(callList(ex).sort(), [
      '<file> -> cfg_rt',
      'Foo.fmt -> helper',
      'spawn -> inner',
      'spawn -> log',
      'spawn -> x.method',
    ]);
    assert.deepEqual(importList(ex), ['self::zed']);
    assert.deepEqual(heritageList(ex), ['Foo implements Debug']);
    // Recovered items span from their first token to the end of the body.
    assert.equal(spawn.startLine, 4);
    assert.equal(spawn.endLine, 8);
    assert.equal(spawn.docLine, 2);
    assert.equal(sym(ex, 'Foo').startLine, 11);
    assert.equal(sym(ex, 'LIMIT').startLine, 18);
    assert.equal(sym(ex, 'LIMIT').signature, 'pub const LIMIT: usize = 10');
  });

  it('recovers multi-line signatures, receivers and type hints from macro arguments', async () => {
    const ex = await extractSource('n.rs', `cfg_rt! {
    /// Spawns a task.
    ///
    /// More.
    #[track_caller]
    pub fn spawn<F>(future: F, meta: &mut SpawnMeta<'_>, h: Arc<Handle>) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
    {
        meta.name();
        h.spawn_task(1);
        self.queue.push(2);
        a.b.c.deep(3);
        make().chained(4);
        Builder::create(5);
        std::mem::swap(6);
        bare(7);
    }
}

pin_project! {
    /// Sleep doc.
    pub struct Sleep {
        #[pin]
        entry: TimerEntry,
        // a, comment: with punctuation
        pub(crate) inner: Option<Box<Inner>>,
        count: u32,
    }
}

impl Sleep {
    fn reset(&mut self) { self.entry.reset(); self.inner.clear(); self.count.pow(2); }
}
`);
    const spawn = sym(ex, 'spawn');
    assert.equal(spawn.startLine, 6);
    assert.equal(spawn.endLine, 18);
    assert.equal(spawn.signature,
      "pub fn spawn<F>(future: F, meta: &mut SpawnMeta<'_>, h: Arc<Handle>) -> JoinHandle<F::Output> where F: Future + Send + 'static");
    assert.equal(spawn.doc, 'Spawns a task.\n\nMore.');
    const sleep = sym(ex, 'Sleep');
    assert.equal(sleep.startLine, 23);
    assert.equal(sleep.endLine, 29);
    assert.equal(sleep.doc, 'Sleep doc.');

    const call = (name: string) => {
      const c = ex.calls.find(x => x.name === name);
      assert.ok(c, `call ${name} not found`);
      return c;
    };
    assert.equal(call('name').receiver, 'meta');
    assert.equal(call('name').rtype, 'SpawnMeta');
    assert.equal(call('spawn_task').rtype, 'Handle');
    assert.equal(call('push').receiver, 'self.queue');
    assert.equal(call('deep').receiver, '?');
    assert.equal(call('chained').receiver, '?');
    assert.equal(call('create').receiver, 'Builder');
    assert.equal(call('swap').receiver, 'std::mem');
    assert.equal(call('bare').receiver, null);
    assert.equal(call('reset').rtype, 'TimerEntry');
    assert.equal(call('clear').rtype, 'Inner');
    assert.equal(call('pow').rtype, null);
  });

  it('recovers macro_rules definitions from macro arguments', async () => {
    const ex = await extractSource('s.rs', `doc! {macro_rules! select {
    ($($t:tt)*) => {
        mod __util { pub fn hidden() {} }
        const BRANCHES: u32 = 1;
        $crate::helper!(1)
    };
}}

wrap! {
    /// Join doc.
    #[macro_export]
    macro_rules! join {
        () => {};
    }

    #[cfg(feature = "a")]
    pub fn dup() { one(); }
    #[cfg(not(feature = "a"))]
    pub fn dup() { two(); }
}

#[cfg(unix)]
fn plat() {}
#[cfg(windows)]
fn plat() {}
`);
    assert.deepEqual(symbolList(ex), [
      'macro select',
      'macro join',
      'function dup',
      'function dup',
      'function plat',
      'function plat',
    ]);
    const select = sym(ex, 'select');
    assert.equal(select.signature, 'macro_rules! select');
    assert.equal(select.startLine, 1);
    assert.equal(select.endLine, 7);
    assert.equal(select.exported, false);
    const join = sym(ex, 'join');
    assert.equal(join.exported, true);
    assert.equal(join.doc, 'Join doc.');
    assert.equal(join.startLine, 12);
    assert.equal(join.endLine, 14);
    const dups = ex.symbols.filter(s => s.name === 'dup');
    assert.deepEqual(dups.map(s => [s.startLine, s.endLine]), [[17, 17], [19, 19]]);
    assert.deepEqual(callList(ex).filter(c => c.startsWith('dup')), ['dup -> one', 'dup -> two']);
  });

  it('resolves receivers to declared types', async () => {
    const ex = await extractSource('h.rs', `pub struct Worker {
    queue: Arc<Mutex<Queue>>,
    handle: &'static Handle,
    id: u32,
}

impl Worker {
    pub fn run(&self, cx: &mut Context, mut park: Parker, opt: Option<Box<dyn Unpark>>, n: usize) -> Self {
        self.queue.push(1);
        self.handle.shutdown();
        self.id.count_ones();
        cx.defer();
        park.park_timeout();
        opt.unpark();
        n.pow(2);
        let typed: Stats = make();
        let built = Builder::new(1)?;
        let dflt = crate::cfg::Config::default();
        let lit = Core { a: 1 };
        let shared = Arc::new(Shared::with_capacity(4));
        let me = Self::fresh();
        let variant = Some(x);
        let unknown = helper();
        let conn = Conn::open(addr).await?;
        typed.incr();
        built.build();
        dflt.validate();
        lit.tick();
        shared.close();
        me.again();
        variant.take();
        unknown.guess();
        conn.send();
        let f = |task: Notified, other| { task.schedule(); other.thing(); };
        a.b().chain();
        me
    }
}
`);
    const rtype = (name: string) => {
      const c = ex.calls.find(x => x.name === name);
      assert.ok(c, `call ${name} not found`);
      return c.rtype;
    };
    assert.equal(rtype('push'), 'Queue');
    assert.equal(rtype('shutdown'), 'Handle');
    assert.equal(rtype('count_ones'), null);
    assert.equal(rtype('defer'), 'Context');
    assert.equal(rtype('park_timeout'), 'Parker');
    assert.equal(rtype('unpark'), 'Unpark');
    assert.equal(rtype('pow'), null);
    assert.equal(rtype('incr'), 'Stats');
    assert.equal(rtype('build'), 'Builder');
    assert.equal(rtype('validate'), 'Config');
    assert.equal(rtype('tick'), 'Core');
    assert.equal(rtype('close'), 'Shared');
    assert.equal(rtype('again'), 'Worker');
    assert.equal(rtype('take'), null);
    assert.equal(rtype('guess'), null);
    assert.equal(rtype('send'), 'Conn');
    assert.equal(rtype('schedule'), 'Notified');
    assert.equal(rtype('thing'), null);
    const calls = callList(ex);
    assert.ok(calls.includes('Worker.run -> ?.chain'), calls.join(' | '));
    assert.ok(calls.includes('Worker.run -> Builder.new'), calls.join(' | '));
  });

  it('handles impls for references, paths and generic traits', async () => {
    const ex = await extractSource('i.rs', `struct Q;
impl<'a> From<&'a str> for crate::m::Q { fn from(s: &'a str) -> Self { Q } }
impl<'a, T> Iterator for &'a mut Wrapper<T> { fn next(&mut self) -> Option<u8> { None } }
impl dyn Shape { fn area(&self) -> f64 { self.w * self.h } }
unsafe impl Send for Q {}
fn top() { let f = Q::make; std::mem::drop(f); crate::util::run::<u8>(); }
`);
    assert.deepEqual(symbolList(ex), [
      'struct Q',
      'method Q.from',
      'method Wrapper.next',
      'method Shape.area',
      'function top',
    ]);
    assert.deepEqual(heritageList(ex), ['Q implements From', 'Q implements Send']);
    assert.deepEqual(callList(ex), ['top -> std::mem.drop', 'top -> crate::util.run']);
  });

  it('tolerates broken source', async () => {
    const ex = await extractSource('c.rs', 'pub fn broken( { struct ; impl for {}\nfn ok() { call( }\n');
    assert.ok(Array.isArray(ex.symbols));
    assert.equal(ex.hadError, true);
  });
});
