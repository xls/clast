import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, heritageList, importList, occLines, sym, symbolList } from '../helpers.js';

const SRC = `#include <string>
#include "shape.h"

namespace geo {
namespace detail {

/// A shape container.
template <typename T>
class Box : public Base<T>, private ns::Other {
 public:
  Box();
  explicit Box(int x) : x_(x) { init(); }
  ~Box();
  // Area of the box.
  virtual double area() const = 0;
  static int count;
  int x_ = 0, y_;
  bool operator==(const Box& o) const { return x_ == o.x_; }
  operator bool() const;
  template <class U> void conv(U u);
  using value_type = T;
  typedef int size_type;
  enum class Mode { On, Off };
  struct Inner { int z; };
  friend class Friend;
  friend void swap(Box& a, Box& b);
  Box(const Box&) = delete;
  int get() override { return x_; }
};

}  // namespace detail

namespace {
int hidden() { return 1; }
}  // namespace

// Bigger of two.
template <typename T>
T maxOf(T a, T b) { return a > b ? a : b; }

static void local_only() {}

void detail::Box::resize(int n) {
  int tmp = n;
  std::sort(v.begin(), v.end());
  auto p = new Thing(1);
  ns::make<int>(2);
  make_shared<Box>();
  this->run();
  ptr->go();
}

}  // namespace geo

Box::~Box() {}
Box::Box() : x_(0) { setup(); }
bool Box::operator<(const Box& o) const { return true; }
Box& Box::self() { return *this; }
int Box::count = 0;

using Alias = std::vector<int>;
constexpr int kMax = 5;
extern "C" { int cfunc(void); }
namespace x::y { void f(); }
int proto(int);
auto lam = [](int x) { return twice(x); };
struct Outer::Nested { int v; void m() {} };
Status DBImpl::Get(const ReadOptions& options) { return Status::OK(); }
`;

describe('cpp extraction', () => {
  it('extracts symbols with qualified names and kinds', async () => {
    const ex = await extractSource('a.cc', SRC);
    assert.equal(ex.lang, 'cpp');
    assert.equal(ex.hadError, false);
    assert.deepEqual(symbolList(ex), [
      'namespace geo',
      'namespace geo.detail',
      'class geo.detail.Box',
      'method geo.detail.Box.Box',
      'method geo.detail.Box.Box',
      'method geo.detail.Box.~Box',
      'method geo.detail.Box.area',
      'field geo.detail.Box.count',
      'field geo.detail.Box.x_',
      'field geo.detail.Box.y_',
      'method geo.detail.Box.operator==',
      'method geo.detail.Box.operator bool',
      'method geo.detail.Box.conv',
      'type geo.detail.Box.value_type',
      'type geo.detail.Box.size_type',
      'enum geo.detail.Box.Mode',
      'constant geo.detail.Box.Mode.On',
      'constant geo.detail.Box.Mode.Off',
      'struct geo.detail.Box.Inner',
      'field geo.detail.Box.Inner.z',
      'method geo.detail.Box.Box',
      'method geo.detail.Box.get',
      'function geo.hidden',
      'function geo.maxOf',
      'function geo.local_only',
      'method geo.detail.Box.resize',
      'method Box.~Box',
      'method Box.Box',
      'method Box.operator<',
      'method Box.self',
      'variable Box.count',
      'type Alias',
      'constant kMax',
      'declaration cfunc',
      'namespace x.y',
      'declaration x.y.f',
      'declaration proto',
      'function lam',
      'struct Outer.Nested',
      'field Outer.Nested.v',
      'method Outer.Nested.m',
      'method DBImpl.Get',
    ]);
  });

  it('captures signatures', async () => {
    const ex = await extractSource('a.cc', SRC);
    assert.equal(sym(ex, 'geo').signature, 'namespace geo');
    assert.equal(sym(ex, 'x.y').signature, 'namespace x::y');
    assert.equal(sym(ex, 'geo.detail.Box').signature, 'template <typename T> class Box : public Base<T>, private ns::Other');
    const ctors = ex.symbols.filter(s => s.qname === 'geo.detail.Box.Box').map(s => s.signature);
    assert.deepEqual(ctors, ['Box()', 'explicit Box(int x)', 'Box(const Box&) = delete']);
    assert.equal(sym(ex, 'geo.detail.Box.~Box').signature, '~Box()');
    assert.equal(sym(ex, 'geo.detail.Box.area').signature, 'virtual double area() const = 0');
    assert.equal(sym(ex, 'geo.detail.Box.operator==').signature, 'bool operator==(const Box& o) const');
    assert.equal(sym(ex, 'geo.detail.Box.conv').signature, 'template <class U> void conv(U u)');
    assert.equal(sym(ex, 'geo.detail.Box.value_type').signature, 'using value_type = T');
    assert.equal(sym(ex, 'geo.detail.Box.Mode').signature, 'enum class Mode');
    assert.equal(sym(ex, 'geo.detail.Box.get').signature, 'int get() override');
    assert.equal(sym(ex, 'geo.maxOf').signature, 'template <typename T> T maxOf(T a, T b)');
    assert.equal(sym(ex, 'geo.detail.Box.resize').signature, 'void detail::Box::resize(int n)');
    assert.equal(sym(ex, 'Box.Box').signature, 'Box::Box()');
    assert.equal(sym(ex, 'Box.operator<').signature, 'bool Box::operator<(const Box& o) const');
    assert.equal(sym(ex, 'Box.self').signature, 'Box& Box::self()');
    assert.equal(sym(ex, 'Box.count').signature, 'int Box::count');
    assert.equal(sym(ex, 'Alias').signature, 'using Alias = std::vector<int>');
    assert.equal(sym(ex, 'kMax').signature, 'constexpr int kMax');
    assert.equal(sym(ex, 'lam').signature, 'auto lam = [](int x)');
    assert.equal(sym(ex, 'Outer.Nested').signature, 'struct Outer::Nested');
  });

  it('captures docs, export flags and template ranges', async () => {
    const ex = await extractSource('a.cc', SRC);
    const box = sym(ex, 'geo.detail.Box');
    assert.equal(box.doc, 'A shape container.');
    assert.equal(box.startLine, 8); // the template<> line
    assert.equal(box.endLine, 29);
    assert.equal(box.exported, true);
    assert.equal(sym(ex, 'geo.detail.Box.area').doc, 'Area of the box.');
    const maxOf = sym(ex, 'geo.maxOf');
    assert.equal(maxOf.doc, 'Bigger of two.');
    assert.equal(maxOf.endLine - maxOf.startLine, 1);
    assert.equal(maxOf.exported, true);
    assert.equal(sym(ex, 'geo.hidden').exported, false); // anonymous namespace
    assert.equal(sym(ex, 'geo.local_only').exported, false); // static
    assert.equal(sym(ex, 'geo.detail.Box.count').exported, true); // static member is still API
    assert.equal(sym(ex, 'proto').kind, 'declaration');
  });

  it('does not index locals, friends or forward declarations', async () => {
    const ex = await extractSource('a.cc', SRC + '\nclass Fwd;\nstruct Fwd2;\nenum class E : int;\n');
    for (const name of ['tmp', 'p', 'Friend', 'swap', 'Fwd', 'Fwd2', 'E']) {
      assert.ok(!ex.symbols.some(s => s.name === name), `unexpected symbol ${name}`);
    }
  });

  it('extracts calls attributed to the enclosing symbol', async () => {
    const ex = await extractSource('a.cc', SRC);
    assert.deepEqual(callList(ex), [
      'geo.detail.Box.Box -> init',
      'geo.detail.Box.resize -> std.sort',
      'geo.detail.Box.resize -> v.begin',
      'geo.detail.Box.resize -> v.end',
      'geo.detail.Box.resize -> Thing',
      'geo.detail.Box.resize -> ns.make',
      'geo.detail.Box.resize -> make_shared',
      'geo.detail.Box.resize -> this.run',
      'geo.detail.Box.resize -> ptr.go',
      'Box.Box -> setup',
      'lam -> twice',
      'DBImpl.Get -> Status.OK',
    ]);
  });

  it('extracts includes and heritage', async () => {
    const ex = await extractSource('a.cc', SRC);
    assert.deepEqual(importList(ex), ['string', 'shape.h']);
    assert.deepEqual(heritageList(ex), ['geo.detail.Box extends Base', 'geo.detail.Box extends Other']);
    const ex2 = await extractSource('b.cpp', 'struct A {};\nclass B : public A, public virtual ns::C<int> {};\nstruct D final : B {};\n');
    assert.deepEqual(symbolList(ex2), ['struct A', 'class B', 'struct D']);
    assert.deepEqual(heritageList(ex2), ['B extends A', 'B extends C', 'D extends B']);
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('a.cc', SRC);
    assert.deepEqual(occLines(ex, 'detail'), [5, 43]); // namespace_identifier
    assert.deepEqual(occLines(ex, 'maxOf'), [39]);
    assert.deepEqual(occLines(ex, 'value_type'), [21]); // type_identifier
    assert.deepEqual(occLines(ex, 'x_'), [12, 17, 18, 28, 56]); // field_identifier + identifier
  });

  it('handles classes declared with an export macro', async () => {
    const ex = await extractSource('db.h', [
      'namespace leveldb {',
      '// A DB.',
      'class LEVELDB_EXPORT DB : public Base {',
      ' public:',
      '  DB() = default;',
      '  DB(const DB&) = delete;',
      '  // Opens it.',
      '  static Status Open(const Options& options, DB** dbptr);',
      '  virtual Status Put(const Slice& key) = 0;',
      '  int size() const { return compute(); }',
      ' private:',
      '  int n_;',
      '};',
      'LEVELDB_EXPORT Status DestroyDB(const std::string& name);',
      '}',
      '',
    ].join('\n'));
    assert.equal(ex.lang, 'cpp');
    assert.deepEqual(symbolList(ex), [
      'namespace leveldb',
      'class leveldb.DB',
      // Known limitation: 'DB() = default;' right after 'public:' is lost in the
      // misparsed class body; the copy constructor is still found.
      'method leveldb.DB.DB',
      'method leveldb.DB.Open',
      'method leveldb.DB.Put',
      'method leveldb.DB.size',
      'field leveldb.DB.n_',
      'declaration leveldb.DestroyDB',
    ]);
    assert.equal(sym(ex, 'leveldb.DB').signature, 'class LEVELDB_EXPORT DB : public Base');
    assert.equal(sym(ex, 'leveldb.DB').doc, 'A DB.');
    assert.equal(sym(ex, 'leveldb.DB.Open').doc, 'Opens it.');
    assert.equal(sym(ex, 'leveldb.DB.Put').signature, 'virtual Status Put(const Slice& key) = 0');
    assert.deepEqual(heritageList(ex), ['leveldb.DB extends Base']);
    assert.ok(callList(ex).includes('leveldb.DB.size -> compute'));
  });

  it('names gtest-style macro definitions by their arguments', async () => {
    const ex = await extractSource('t.cc', 'TEST(DBTest, Empty) { ASSERT_TRUE(Check()); }\nTEST_F(DBTest, Full) { Fill(); }\n');
    assert.deepEqual(symbolList(ex), ['function DBTest.Empty', 'function DBTest.Full']);
    assert.ok(callList(ex).includes('DBTest.Full -> Fill'));
  });

  it('ignores trailing annotation macros', async () => {
    const ex = await extractSource('m.cc', [
      'class Counter {',
      ' public:',
      '  void Add(int n) LOCKS_EXCLUDED(mu_) { Bump(n); }',
      ' private:',
      '  port::Mutex mu_;',
      '  int count_ GUARDED_BY(mu_);',
      '};',
      '',
    ].join('\n'));
    assert.deepEqual(symbolList(ex), ['class Counter', 'method Counter.Add', 'field Counter.mu_', 'field Counter.count_']);
  });

  it('handles out-of-line template members and specializations', async () => {
    const ex = await extractSource('s.cc', [
      'template <typename K, class C>',
      'void SkipList<K, C>::Insert(const K& key) { Find(key); }',
      'template <>',
      'int convert<int>(const char* s) { return atoi(s); }',
      'template <> struct Hash<int> { size_t operator()(int v) const { return v; } };',
      'void* operator new(size_t n) { return alloc(n); }',
      '',
    ].join('\n'));
    assert.deepEqual(symbolList(ex), [
      'method SkipList.Insert',
      'function convert',
      'struct Hash',
      'method Hash.operator()',
      'function operator new',
    ]);
    assert.equal(sym(ex, 'SkipList.Insert').signature, 'template <typename K, class C> void SkipList<K, C>::Insert(const K& key)');
    assert.ok(callList(ex).includes('SkipList.Insert -> Find'));
  });

  it('never throws on broken input', async () => {
    const ex = await extractSource('x.cpp', 'class { int a; };\nnamespace {\nvoid f( {\nclass X : public {\n template<> ;; int ::* p;\n#define\n#include\n');
    assert.ok(Array.isArray(ex.symbols));
    for (const s of ex.symbols) assert.ok(!/[\s()*&]/.test(s.name), `garbage name ${s.name}`);
  });
});
