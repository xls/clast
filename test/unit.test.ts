import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { simpleReceiver, typeName } from '../src/parser/spec.js';
import { returnTypeOf } from '../src/parser/returns.js';
import { cleanComment } from '../src/parser/extractor.js';
import {
  editDistance, ftsWords, initials, isSubsequence, queryTerms, splitIdentifier, stem, subwordMatch, wordMatches,
} from '../src/query/words.js';
import { isTestPath, isTestSite, isVendoredPath, plural } from '../src/query/format.js';
import { parseSymbolRef, pathMatches } from '../src/query/resolve.js';
import { parseConfig } from '../src/config/index.js';

describe('typeName', () => {
  it('reduces type text to a bare class name', () => {
    assert.equal(typeName('Foo'), 'Foo');
    assert.equal(typeName(': Foo'), 'Foo');
    assert.equal(typeName('*Site'), 'Site');
    assert.equal(typeName('&mut Foo'), 'Foo');
    assert.equal(typeName("&'a mut Foo"), 'Foo');
    assert.equal(typeName('const Slice&'), 'Slice');
    assert.equal(typeName('ProducerRecord<K, V>'), 'ProducerRecord');
    assert.equal(typeName('pkg.sub.Foo'), 'Foo');
    assert.equal(typeName('ns::inner::Foo'), 'Foo');
    assert.equal(typeName('\\App\\Models\\User'), 'User');
    assert.equal(typeName('?Foo'), 'Foo');
    assert.equal(typeName('Foo | null'), 'Foo');
    assert.equal(typeName('undefined | Foo'), 'Foo');
  });

  it('unwraps smart pointers, options and promises', () => {
    assert.equal(typeName('Option<Arc<Handle>>'), 'Handle');
    assert.equal(typeName('std::unique_ptr<Foo>'), 'Foo');
    assert.equal(typeName('Promise<Result>'), 'Result');
    assert.equal(typeName('Task<Foo>'), 'Foo');
  });

  it('rejects primitives, collections and unions of classes', () => {
    assert.equal(typeName('string'), null);
    assert.equal(typeName('int'), null);
    assert.equal(typeName('Foo | Bar'), null);
    assert.equal(typeName('(a: number) => void'), null);
    assert.equal(typeName('{ a: 1 }'), null);
    assert.equal(typeName(''), null);
    assert.equal(typeName(null), null);
  });

  it('accepts lowercase type names only when the language opts in', () => {
    assert.equal(typeName('client'), null);
    assert.equal(typeName('client', true), 'client');
    assert.equal(typeName('*responseWriter', true), 'responseWriter');
    assert.equal(typeName('int', true), null);
    assert.equal(typeName('size_t', true), null);
    assert.equal(typeName('uint64', true), null);
    assert.equal(typeName('std::vector<int>', true), null);
  });
});

describe('returnTypeOf', () => {
  const ret = (sig: string, name: string, lang: string, self: string | null = null, lower = false) =>
    returnTypeOf(sig, name, lang, self, lower);

  it('reads suffix-style return types', () => {
    assert.equal(ret('add(x: string): Builder', 'add', 'typescript'), 'Builder');
    assert.equal(ret('export function make(): Builder', 'make', 'typescript'), 'Builder');
    assert.equal(ret('async load(id: number): Promise<User>', 'load', 'typescript'), 'User');
    assert.equal(ret('def build(self) -> Product:', 'build', 'python'), 'Product');
    assert.equal(ret('pub fn build(&self) -> Searcher', 'build', 'rust'), 'Searcher');
    assert.equal(ret('pub fn run<F>(self, f: F) -> io::Result<Runtime> where F: FnMut()', 'run', 'rust'), 'Runtime');
    assert.equal(ret('public function then(Closure $destination): Response', 'then', 'php'), 'Response');
  });

  it('reads prefix-style return types', () => {
    assert.equal(ret('public ListTopicsOptions listInternal(boolean listInternal)', 'listInternal', 'java'), 'ListTopicsOptions');
    assert.equal(ret('public static WebApplicationBuilder CreateBuilder()', 'CreateBuilder', 'csharp'), 'WebApplicationBuilder');
    assert.equal(ret('public async Task<Foo> LoadAsync(int id)', 'LoadAsync', 'csharp'), 'Foo');
    assert.equal(ret('Status DBImpl::Write(const WriteOptions& options, WriteBatch* updates)', 'Write', 'cpp'), 'Status');
    assert.equal(ret('static Iterator* NewIterator(const ReadOptions& options)', 'NewIterator', 'cpp'), 'Iterator');
    assert.equal(ret('public void run()', 'run', 'java'), null);
    assert.equal(ret('public Foo(int x)', 'Foo', 'java'), null);
  });

  it('reads Go results, taking the first of a tuple', () => {
    assert.equal(ret('func New() *Engine', 'New', 'go', null, true), 'Engine');
    assert.equal(ret('func load() (*Engine, error)', 'load', 'go', null, true), 'Engine');
    assert.equal(ret('func (e *Engine) Run() error', 'Run', 'go', null, true), null);
  });

  it('maps self-returning signatures to the enclosing class', () => {
    assert.equal(ret('pub fn enable_all(&mut self) -> &mut Self', 'enable_all', 'rust', 'Builder'), 'Builder');
    assert.equal(ret('pub fn new() -> Self', 'new', 'rust', 'Builder'), 'Builder');
    assert.equal(ret('public function send($passable): static', 'send', 'php', 'Pipeline'), 'Pipeline');
  });
});

describe('simpleReceiver / cleanComment', () => {
  it('cleans comment markers', () => {
    assert.equal(cleanComment('/** A circle. */'), 'A circle.');
    assert.equal(cleanComment('/**\n * Line one\n * line two\n */'), 'Line one\nline two');
    assert.equal(cleanComment('// one'), 'one');
    assert.equal(cleanComment('/// doc'), 'doc');
    assert.equal(cleanComment('# python'), 'python');
  });

  it('returns null only for a missing receiver node', () => {
    assert.equal(simpleReceiver(null), null);
    assert.equal(simpleReceiver(undefined), null);
  });
});

describe('words', () => {
  it('splits identifiers into sub-words', () => {
    assert.deepEqual(splitIdentifier('parseAndStore'), ['parse', 'and', 'store']);
    assert.deepEqual(splitIdentifier('HTTPServer2'), ['http', 'server', '2']);
    assert.deepEqual(splitIdentifier('snake_case_name'), ['snake', 'case', 'name']);
    assert.deepEqual(splitIdentifier('src/db/index.ts'), ['src', 'db', 'index', 'ts']);
  });

  it('builds FTS text with sub-words and whole identifiers', () => {
    const words = ftsWords('ParserManager.parseAndStore').split(' ');
    for (const w of ['parser', 'manager', 'parsermanager', 'parse', 'store', 'parseandstore']) {
      assert.ok(words.includes(w), `missing ${w}`);
    }
  });

  it('drops stop words from queries', () => {
    assert.deepEqual(queryTerms('where is the import path resolved'), ['import', 'path', 'resolved']);
    assert.deepEqual(queryTerms('parseConfig file'), ['parse', 'config', 'file']);
  });

  it('matches inflected words', () => {
    assert.equal(stem('dependencies'), stem('dependency'));
    assert.equal(stem('parsing'), stem('parse'));
    assert.ok(wordMatches('dependencies', 'dependency'));
    assert.ok(wordMatches('resolver', 'resolve'));
    assert.ok(wordMatches('configuration', 'config'));
    assert.ok(!wordMatches('store', 'restore'));
  });

  it('matches abbreviations, initials and typos', () => {
    assert.ok(subwordMatch('KProd', 'KafkaProducer') > 0);
    assert.ok(subwordMatch('recAccum', 'RecordAccumulator') > 0);
    assert.equal(subwordMatch('xyz', 'KafkaProducer'), 0);
    assert.equal(initials('getContextNode'), 'gcn');
    assert.equal(initials('single'), '');
    assert.ok(isSubsequence('qryset', 'queryset'));
    assert.equal(editDistance('paginater', 'paginator', 2), 1);
    assert.equal(editDistance('serach', 'search', 2), 1); // transposition
    assert.equal(editDistance('abc', 'xyzuvw', 2), 3); // over the bound
  });
});

describe('paths and references', () => {
  it('classifies tests, examples and vendored code', () => {
    for (const p of ['tests/a.py', 'src/foo.test.ts', 'pkg/foo_test.go', 'spec/models/user_spec.rb', 'examples/app.js', 'docs_src/x.py', 'src/test/java/FooTest.java', 'app/test_views.py']) {
      assert.ok(isTestPath(p), p);
    }
    for (const p of ['src/latest.ts', 'lib/active_record/test_databases.rb', 'src/contest/a.py', 'src/protest.go', 'django/core/paginator.py']) {
      assert.ok(!isTestPath(p), p);
    }
    assert.ok(isVendoredPath('deps/hiredis/hiredis.c'));
    assert.ok(isVendoredPath('third_party/x/y.cc'));
    assert.ok(!isVendoredPath('src/vendors.ts'));
    assert.ok(isTestSite('crates/searcher/src/lib.rs', 'tests.basic_search'));
    assert.ok(!isTestSite('crates/searcher/src/lib.rs', 'Searcher.build'));
  });

  it('parses the ways a symbol can be addressed', () => {
    assert.deepEqual(parseSymbolRef('parseConfig'), { name: 'parseConfig', container: [], path: undefined, line: undefined });
    assert.deepEqual(parseSymbolRef('Parser.parse').container, ['Parser']);
    assert.deepEqual(parseSymbolRef('Parser::parse()').name, 'parse');
    assert.deepEqual(parseSymbolRef('a::b::C#run').container, ['a', 'b', 'C']);
    assert.deepEqual(parseSymbolRef('Illuminate\\Pipeline\\Pipeline').container, ['Illuminate', 'Pipeline']);
    assert.equal(parseSymbolRef('select!').name, 'select');
    const byPath = parseSymbolRef('src/db/index.ts:open');
    assert.equal(byPath.path, 'src/db/index.ts');
    assert.equal(byPath.name, 'open');
    const byLine = parseSymbolRef('src/db/index.ts:120');
    assert.equal(byLine.line, 120);
    assert.equal(parseSymbolRef('C:\\repo\\src\\a.ts:foo').path, 'C:/repo/src/a.ts');
  });

  it('matches path filters by prefix, suffix and substring', () => {
    assert.ok(pathMatches('src/db/index.ts', 'src/db'));
    assert.ok(pathMatches('src/db/index.ts', 'index.ts'));
    assert.ok(pathMatches('src/db/index.ts', 'db/index'));
    assert.ok(pathMatches('src/db/index.ts', '.\\src\\db'));
    assert.ok(!pathMatches('src/db/index.ts', 'server'));
  });

  it('pluralises', () => {
    assert.equal(plural(1, 'match'), '1 match');
    assert.equal(plural(2, 'match'), '2 matches');
    assert.equal(plural(0, 'file'), '0 files');
  });
});

describe('config', () => {
  it('fills defaults and validates', () => {
    const c = parseConfig({});
    assert.equal(c.dbPath, '.clast/index.db');
    assert.equal(c.respectGitignore, true);
    assert.ok(c.ignoredPaths.includes('node_modules'));
    assert.equal(parseConfig({ workers: 3, watch: { enabled: false } }).watch.enabled, false);
    assert.throws(() => parseConfig({ workers: -1 }));
    assert.throws(() => parseConfig({ maxFileSize: 5 }));
  });
});
