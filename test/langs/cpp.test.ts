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
    assert.deepEqual(importList(ex), ['<string>', 'shape.h']);
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
    // With a class type the parser sees a function named after the macro.
    const ex2 = await extractSource('n.cc', [
      'class Impl {',
      '  MemTable* imm_ GUARDED_BY(mutex_);',
      '  port::CondVar signal_ GUARDED_BY(mutex_);',
      '  void Run() { imm_->Ref(); }',
      '};',
      '',
    ].join('\n'));
    assert.deepEqual(symbolList(ex2), ['class Impl', 'field Impl.imm_', 'field Impl.signal_', 'method Impl.Run']);
    assert.equal(sym(ex2, 'Impl.imm_').signature, 'MemTable* imm_ GUARDED_BY(mutex_)');
    assert.equal(ex2.calls.find(c => c.name === 'Ref')!.rtype, 'MemTable');
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

  it('names a function declared through a head-building macro by the macro\'s last argument', async () => {
    // JNI style, found on OnAir: these were indexed as `jstring.nativeStart` and `FN`.
    const ex = await extractSource('jni.cpp', [
      '#define FN(ret, name) extern "C" ret Java_pkg_##name',
      'static void pushGain(int b) {}',
      'FN(jstring, nativeStart)(JNIEnv* e, jobject, jint kind) {',
      '    pushGain(1);',
      '    return nullptr;',
      '}',
      'FN(void, nativeStop)(JNIEnv* e, jobject) { pushGain(2); }',
    ].join('\n'));
    assert.deepEqual(symbolList(ex), ['macro FN', 'function pushGain', 'function nativeStart', 'function nativeStop']);
    assert.deepEqual(callList(ex), ['nativeStart -> pushGain', 'nativeStop -> pushGain']);
  });

  it('gives each declarator of a multi-declarator member its own signature', async () => {
    const ex = await extractSource('a.cc', SRC);
    assert.equal(sym(ex, 'geo.detail.Box.x_').signature, 'int x_');
    assert.equal(sym(ex, 'geo.detail.Box.y_').signature, 'int y_');
    assert.equal(sym(ex, 'geo.detail.Box.count').signature, 'static int count');
    const ex2 = await extractSource('f.cc', 'struct S {\n  std::unique_ptr<Foo> foo_, *bar_;\n  Slice start = 1;\n};\n');
    assert.equal(sym(ex2, 'S.foo_').signature, 'std::unique_ptr<Foo> foo_');
    assert.equal(sym(ex2, 'S.bar_').signature, 'std::unique_ptr<Foo> *bar_');
    assert.equal(sym(ex2, 'S.start').signature, 'Slice start = 1');
  });

  describe('receiver types', () => {
    const TYPED = [
      'class Inserter : public Handler {',
      ' public:',
      '  MemTable* mem_;',
      '  std::unique_ptr<Cache> cache_;',
      '  port::Mutex mu_ GUARDED_BY(x);',
      '  std::vector<Item> items_;',
      '  int n_;',
      '  void Put(const Slice& key, DB* db, std::shared_ptr<Env> env, Options opts = Options(), int n = 0) {',
      '    mem_->Add(key);',
      '    this->cache_->Insert(key);',
      '    mu_.Lock();',
      '    items_.push_back(1);',
      '    key.data();',
      '    db->Write(1);',
      '    env->Now();',
      '    opts.Check();',
      '    Status::OK();',
      '    db->NewIterator()->Seek(key);',
      '    table()[0].Reset();',
      '  }',
      '  void Decl(Hidden* h);',
      '  void Use() { h->Leak(); }',
      '};',
      '',
      'Status BuildTable(TableCache* table_cache, Iterator* iter) {',
      '  TableBuilder* builder = new TableBuilder(options, file);',
      '  auto meta = new FileMetaData(1);',
      '  auto uniq = std::make_unique<WritableFile>(2);',
      '  auto shared = make_shared<ns::Logger>();',
      '  auto* impl = reinterpret_cast<DBImpl*>(db);',
      '  auto unknown = Compute();',
      '  Version v;',
      '  WriteBatch batch(1), *other;',
      '  builder->Add2(1);',
      '  meta->Clear();',
      '  uniq->Append(1);',
      '  shared->Logv(1);',
      '  impl->Recover(1);',
      '  unknown.Run();',
      '  v.Ref();',
      '  batch.Delete(1);',
      '  other->Merge(1);',
      '  table_cache->Evict(1);',
      '  for (const FileEntry& f : files) f.Size();',
      '  for (auto& e : files) e.Size2();',
      '  if (Snapshot* s = Current()) s->Release();',
      '  auto fn = [](Slice* arg) { arg->remove_prefix(1); };',
      '  return iter->status();',
      '}',
      '',
      'void Inserter::Flush(Handler* handler) {',
      '  this->mem_->Unref();',
      '  handler->Done();',
      '}',
      '',
    ].join('\n');

    const typed = async () => {
      const ex = await extractSource('typed.cc', TYPED);
      return (name: string) => {
        const c = ex.calls.find(x => x.name === name);
        assert.ok(c, `no call ${name}`);
        return c;
      };
    };

    it('records receivers of member calls', async () => {
      const call = await typed();
      assert.equal(call('Add').receiver, 'mem_');
      assert.equal(call('Insert').receiver, 'this->cache_');
      assert.equal(call('OK').receiver, 'Status');
      assert.equal(call('Seek').receiver, '?'); // call chain
      assert.equal(call('Reset').receiver, '?'); // subscript
      assert.equal(call('NewIterator').receiver, 'db');
      assert.equal(call('Compute').receiver, null); // bare call
      assert.equal(call('TableBuilder').receiver, null); // new expression
    });

    it('resolves receivers declared as parameters', async () => {
      const call = await typed();
      assert.equal(call('data').rtype, 'Slice'); // const Slice& key
      assert.equal(call('Write').rtype, 'DB'); // DB* db
      assert.equal(call('Now').rtype, 'Env'); // std::shared_ptr<Env> env
      assert.equal(call('Check').rtype, 'Options'); // parameter with a default value
      assert.equal(call('Evict').rtype, 'TableCache');
      assert.equal(call('status').rtype, 'Iterator');
      assert.equal(call('remove_prefix').rtype, 'Slice'); // lambda parameter
      assert.equal(call('Done').rtype, 'Handler'); // out-of-line method
      // Parameters of a declaration without a body are not hints for the class.
      assert.equal(call('Leak').rtype, null);
    });

    it('resolves receivers declared as locals', async () => {
      const call = await typed();
      assert.equal(call('Add2').rtype, 'TableBuilder'); // Foo* p = new Foo(...)
      assert.equal(call('Clear').rtype, 'FileMetaData'); // auto p = new Foo(...)
      assert.equal(call('Append').rtype, 'WritableFile'); // std::make_unique<Foo>
      assert.equal(call('Logv').rtype, 'Logger'); // make_shared<ns::Foo>
      assert.equal(call('Recover').rtype, 'DBImpl'); // auto* p = reinterpret_cast<Foo*>
      assert.equal(call('Run').rtype, null); // auto from an arbitrary call
      assert.equal(call('Ref').rtype, 'Version'); // Foo x;
      assert.equal(call('Delete').rtype, 'WriteBatch'); // Foo x(args)
      assert.equal(call('Merge').rtype, 'WriteBatch'); // second declarator
      assert.equal(call('Size').rtype, 'FileEntry'); // range-for with an explicit type
      assert.equal(call('Size2').rtype, null); // range-for with auto
      assert.equal(call('Release').rtype, 'Snapshot'); // declaration in a condition
    });

    it('resolves receivers that are data members', async () => {
      const call = await typed();
      assert.equal(call('Add').rtype, 'MemTable'); // bare field inside an inline method
      assert.equal(call('Insert').rtype, 'Cache'); // this->field, unique_ptr unwrapped
      assert.equal(call('Lock').rtype, 'Mutex'); // port::Mutex with a trailing annotation macro
      assert.equal(call('push_back').rtype, null); // std::vector is not a class type
      // Out-of-line definition: `this->field` resolves when the class is in the same file.
      assert.equal(call('Unref').receiver, 'this->mem_');
      assert.equal(call('Unref').rtype, 'MemTable');
    });

    it('resolves members of classes declared with an export macro', async () => {
      const ex = await extractSource('exp.h', [
        'namespace leveldb {',
        'class LEVELDB_EXPORT Holder {',
        ' public:',
        '  void Go() { rep_->Start(); }',
        ' private:',
        '  Rep* rep_;',
        '};',
        '}',
        '',
      ].join('\n'));
      assert.equal(ex.calls.find(c => c.name === 'Start')!.rtype, 'Rep');
    });
  });
});
