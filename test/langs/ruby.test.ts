import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callList, extractSource, heritageList, importList, occLines, sym, symbolList } from '../helpers.js';

const SRC = `require 'json'
require_relative 'base'
require "set"
load 'tasks/x.rake'
autoload :Thing, 'lib/thing'
require File.expand_path('dyn', __dir__)

# Top module.
# Second line.
module Outer
  # First-child doc.
  LIMIT = 10

  class Foo::Bar < Base::Model
    include Comparable
    extend ActiveSupport::Concern
    prepend Patch, Other

    attr_accessor :a, :b
    attr_reader "c"
    alias_method :x, :y
    alias old new
    scope :active, -> { where(active: true) }
    delegate :size, :length, to: :items

    class << self
      def build(x) = new(x)

      private
        def hidden; end
    end

    # Doc for run.
    def self.run(a, b = 1, *rest, k: 2, &blk)
      Foo.new(a).call
      Foo::Baz.new
      helper a
      a.b&.c(1)
      @items.push(a)
      bare
    end

    def ==(other)
      true
    end

    def name=(v); @name = v; end

    def valid?
      list.each do |i|
        check(i)
      end
    end

    define_method(:dyn) { |z| transform(z) }

    private def priv(a) = a + 1

    def later; end
    private :later

    protected

    def prot
    end

    public

    def pub_again; end

    def _underscored; end
  end

  module Inner
    module Deep
      def deep_m; end
    end
  end
end

def top(a)
  Outer::Foo::Bar.run(a)
end

Point = Struct.new(:x, :y) do
  def dist
    Math.sqrt(x)
  end
end

Err = Class.new(StandardError)

class Empty; end
`;

describe('ruby extraction', () => {
  it('extracts symbols with qualified names and kinds', async () => {
    const ex = await extractSource('a.rb', SRC);
    assert.deepEqual(symbolList(ex), [
      'namespace Outer',
      'constant Outer.LIMIT',
      'class Outer.Foo.Bar',
      'property Outer.Foo.Bar.a',
      'property Outer.Foo.Bar.b',
      'property Outer.Foo.Bar.c',
      'method Outer.Foo.Bar.x',
      'method Outer.Foo.Bar.old',
      'method Outer.Foo.Bar.active',
      'method Outer.Foo.Bar.size',
      'method Outer.Foo.Bar.length',
      'method Outer.Foo.Bar.build',
      'method Outer.Foo.Bar.hidden',
      'method Outer.Foo.Bar.run',
      'method Outer.Foo.Bar.==',
      'method Outer.Foo.Bar.name=',
      'method Outer.Foo.Bar.valid?',
      'method Outer.Foo.Bar.dyn',
      'method Outer.Foo.Bar.priv',
      'method Outer.Foo.Bar.later',
      'method Outer.Foo.Bar.prot',
      'method Outer.Foo.Bar.pub_again',
      'method Outer.Foo.Bar._underscored',
      'namespace Outer.Inner',
      'namespace Outer.Inner.Deep',
      'method Outer.Inner.Deep.deep_m',
      'function top',
      'class Point',
      'method Point.dist',
      'class Err',
      'class Empty',
    ]);
    assert.equal(ex.hadError, false);
  });

  it('captures signatures', async () => {
    const ex = await extractSource('a.rb', SRC);
    assert.equal(sym(ex, 'Outer').signature, 'module Outer');
    assert.equal(sym(ex, 'Outer.Foo.Bar').signature, 'class Foo::Bar < Base::Model');
    assert.equal(sym(ex, 'Outer.Foo.Bar.run').signature, 'def self.run(a, b = 1, *rest, k: 2, &blk)');
    assert.equal(sym(ex, 'Outer.Foo.Bar.build').signature, 'def self.build(x)');
    assert.equal(sym(ex, 'Outer.Foo.Bar.==').signature, 'def ==(other)');
    assert.equal(sym(ex, 'Outer.Foo.Bar.name=').signature, 'def name=(v)');
    assert.equal(sym(ex, 'Outer.Foo.Bar.valid?').signature, 'def valid?');
    assert.equal(sym(ex, 'Outer.Foo.Bar.priv').signature, 'private def priv(a)');
    assert.equal(sym(ex, 'Outer.Foo.Bar.hidden').signature, 'def self.hidden');
    assert.equal(sym(ex, 'Outer.Foo.Bar.a').signature, 'attr_accessor :a, :b');
    assert.equal(sym(ex, 'Outer.Foo.Bar.active').signature, 'scope :active');
    assert.equal(sym(ex, 'Outer.Foo.Bar.dyn').signature, 'define_method(:dyn)');
    assert.equal(sym(ex, 'Outer.Foo.Bar.old').signature, 'alias old new');
    assert.equal(sym(ex, 'Outer.LIMIT').signature, 'LIMIT = 10');
    assert.equal(sym(ex, 'Point').signature, 'Point = Struct.new(:x, :y)');
    assert.equal(sym(ex, 'Empty').signature, 'class Empty');
    assert.equal(sym(ex, 'top').signature, 'def top(a)');
  });

  it('captures docs, line ranges and exported flags', async () => {
    const ex = await extractSource('a.rb', SRC);
    const outer = sym(ex, 'Outer');
    assert.equal(outer.doc, 'Top module.\nSecond line.');
    assert.equal(outer.startLine, 10);
    assert.equal(outer.docLine, 8);
    assert.equal(sym(ex, 'Outer.Foo.Bar.run').doc, 'Doc for run.');
    // A comment before the first statement of a body is attached by the grammar
    // to the enclosing module/class node, not to the statement.
    assert.equal(sym(ex, 'Outer.LIMIT').doc, 'First-child doc.');
    assert.equal(sym(ex, 'Outer.Foo.Bar').doc, '');

    const run = sym(ex, 'Outer.Foo.Bar.run');
    assert.equal(run.endLine - run.startLine, 7);

    assert.equal(outer.exported, true);
    assert.equal(run.exported, true);
    assert.equal(sym(ex, 'Outer.Foo.Bar.build').exported, true);
    assert.equal(sym(ex, 'Outer.Foo.Bar.hidden').exported, false);
    assert.equal(sym(ex, 'Outer.Foo.Bar.priv').exported, false);
    assert.equal(sym(ex, 'Outer.Foo.Bar.later').exported, false);
    assert.equal(sym(ex, 'Outer.Foo.Bar.prot').exported, false);
    assert.equal(sym(ex, 'Outer.Foo.Bar.pub_again').exported, true);
    assert.equal(sym(ex, 'Outer.Foo.Bar._underscored').exported, false);
    assert.equal(sym(ex, 'top').exported, true);
  });

  it('extracts calls attributed to the enclosing symbol', async () => {
    const ex = await extractSource('a.rb', SRC);
    const calls = callList(ex);
    for (const want of [
      'Outer.Foo.Bar.active -> where',
      'Outer.Foo.Bar.build -> new',
      'Outer.Foo.Bar.run -> Foo.new',
      'Outer.Foo.Bar.run -> Foo',
      'Outer.Foo.Bar.run -> Baz',
      'Outer.Foo.Bar.run -> ?.call',
      'Outer.Foo.Bar.run -> helper',
      'Outer.Foo.Bar.run -> a.b',
      'Outer.Foo.Bar.run -> ?.c',
      'Outer.Foo.Bar.run -> @items.push',
      'Outer.Foo.Bar.valid? -> list.each',
      'Outer.Foo.Bar.valid? -> check',
      'Outer.Foo.Bar.dyn -> transform',
      'top -> Outer::Foo::Bar.run',
      'Point.dist -> Math.sqrt',
      'Err -> Class.new',
    ]) {
      assert.ok(calls.includes(want), `missing '${want}' in ${JSON.stringify(calls)}`);
    }
    // Keyword-like DSL calls and bare identifiers are not calls.
    for (const name of ['require', 'require_relative', 'include', 'extend', 'attr_accessor', 'private', 'bare', 'scope']) {
      assert.ok(!ex.calls.some(c => c.name === name), `unexpected call to ${name}`);
    }
    // Calls are merged per (caller, name, receiver): Foo.new and Foo::Baz.new stay separate.
    const foo = ex.calls.find(c => c.name === 'new' && c.receiver === 'Foo');
    assert.equal(foo?.count, 1);
  });

  it('extracts imports', async () => {
    const ex = await extractSource('a.rb', SRC);
    assert.deepEqual(importList(ex), ['json', './base', 'set', 'tasks/x.rake', 'lib/thing']);
    assert.deepEqual(ex.imports[4]!.names, ['Thing']);
    assert.equal(ex.imports[1]!.line, 2);
  });

  it('extracts superclasses and mixins', async () => {
    const ex = await extractSource('a.rb', SRC);
    assert.deepEqual(heritageList(ex), [
      'Outer.Foo.Bar extends Model',
      'Outer.Foo.Bar implements Comparable',
      'Outer.Foo.Bar implements Concern',
      'Outer.Foo.Bar implements Patch',
      'Outer.Foo.Bar implements Other',
      'Point extends Struct',
      'Err extends StandardError',
    ]);
  });

  it('records identifier occurrences with lines', async () => {
    const ex = await extractSource('a.rb', SRC);
    assert.deepEqual(occLines(ex, 'Comparable'), [15]);
    assert.deepEqual(occLines(ex, 'helper'), [37]);
    assert.deepEqual(occLines(ex, 'Bar'), [14, 82]);
    assert.deepEqual(occLines(ex, 'valid?'), [49]);
    // Symbols and hash keys are not identifiers.
    assert.deepEqual(occLines(ex, ':active'), []);
    assert.deepEqual(occLines(ex, 'active'), []);
  });

  it('handles tricky syntax', async () => {
    const ex = await extractSource('b.rb', `# frozen_string_literal: true

class Base
  # Trailing comment on the class line must not become a doc.
end

class Child < Migration[7.1] # :nodoc:
  VERSION ||= "1"
  Foo::BAR = 2

  def self.[](key) = fetch(key)

  def <=>(other)
    local = 1
    CONST_IN_METHOD = local
    -> { nested_call(1) }.call
  end

  def call(...) = super

  included do
    attr_writer :w
    def from_block; end
  end

  attr_accessor :"dyn_#{x}", :ok
  scope :routes_style do
  end
  define_method("str_name") { 1 }
  define_method("no_#{interp}") { 2 }
  delegate :name, to: :owner, prefix: true
end

module ::Rooted
  def self.go = new.start
end

def h\u00e9llo(w\u00f6rld) = w\u00f6rld
`);
    assert.deepEqual(symbolList(ex), [
      'class Base',
      'class Child',
      'constant Child.VERSION',
      'method Child.[]',
      'method Child.<=>',
      'method Child.call',
      'property Child.w',
      'method Child.from_block',
      'property Child.ok',
      'method Child.str_name',
      'namespace Rooted',
      'method Rooted.go',
      'function h\u00e9llo',
    ]);
    assert.equal(sym(ex, 'Child').doc, '');
    assert.equal(sym(ex, 'Child').signature, 'class Child < Migration[7.1]');
    assert.equal(sym(ex, 'Child.[]').signature, 'def self.[](key)');
    assert.equal(sym(ex, 'h\u00e9llo').signature, 'def h\u00e9llo(w\u00f6rld)');
    assert.deepEqual(heritageList(ex), ['Child extends Migration']);
    const calls = callList(ex);
    assert.ok(calls.includes('Child.[] -> fetch'));
    assert.ok(calls.includes('Child.<=> -> nested_call'));
    assert.ok(calls.includes('Rooted.go -> new.start'));
    assert.ok(calls.includes('Child -> scope'));
  });

  it('does not leak private state between files and tolerates broken code', async () => {
    const a = await extractSource('p1.rb', 'class A\n  private\n  def x; end\nend\n');
    assert.equal(sym(a, 'A.x').exported, false);
    const b = await extractSource('p2.rb', 'class A\n  def x; end\n  def y; end\nend\n');
    assert.equal(sym(b, 'A.x').exported, true);
    assert.equal(sym(b, 'A.y').exported, true);

    const broken = await extractSource('broken.rb', 'class Foo <\n  def bar(\n    baz.qux(\nmodule\n  X =\nend end end\n');
    assert.ok(Array.isArray(broken.symbols));
    const empty = await extractSource('empty.rb', '');
    assert.deepEqual(empty.symbols, []);
  });

  it('parses .rake and .gemspec files as ruby', async () => {
    const rake = await extractSource('x.rake', 'namespace :db do\n  task :go do\n    Runner.new.go\n  end\nend\n');
    assert.ok(callList(rake).includes('<file> -> Runner'));
    const gem = await extractSource('x.gemspec', "require_relative 'lib/v'\nGem::Specification.new do |s|\n  s.name = 'x'\nend\n");
    assert.deepEqual(importList(gem), ['./lib/v']);
  });

  it('always passes explicit receivers and resolves receiver types from Foo.new assignments', async () => {
    const ex = await extractSource('r.rb', `class Pool
  def checkout; end
end

class Handler
  def initialize
    @pool = Pool.new(1)
    @lazy ||= Deep::Cache.new
  end

  def establish_connection(config)
    connection_handler.establish_connection(config)
    self.prepare
    local = Deep::Runner.new
    local.run
    @pool.checkout
    @lazy.fetch(1)
    @unknown.go
    other.run
    a.b.c
    foo(1).bar
    "str".size
    Deep::Runner.start
    Pool.create
    bare_call(1)
  end
end
`);
    const find = (name: string, caller = 'Handler.establish_connection') =>
      ex.calls.find(c => c.name === name && c.caller >= 0 && ex.symbols[c.caller]!.qname === caller);
    // An explicit receiver is never dropped: this is not a self-call.
    assert.equal(find('establish_connection')?.receiver, 'connection_handler');
    assert.equal(find('establish_connection')?.rtype ?? null, null);
    assert.equal(find('prepare')?.receiver, 'self');
    assert.equal(find('c')?.receiver, '?');
    assert.equal(find('b')?.receiver, 'a');
    assert.equal(find('bar')?.receiver, '?');
    assert.equal(find('size')?.receiver, '?');
    assert.equal(find('start')?.receiver, 'Deep::Runner');
    assert.equal(find('create')?.receiver, 'Pool');
    assert.ok(!find('bare_call')?.receiver);
    assert.ok(!find('foo')?.receiver);
    // Locals and instance variables assigned from Foo.new carry the class.
    const runs = ex.calls.filter(c => c.name === 'run');
    assert.equal(runs.find(c => c.receiver === 'local')?.rtype, 'Runner');
    assert.equal(runs.find(c => c.receiver === 'other')?.rtype ?? null, null);
    assert.equal(find('checkout')?.receiver, '@pool');
    assert.equal(find('checkout')?.rtype, 'Pool');
    assert.equal(find('fetch')?.rtype, 'Cache');
    assert.equal(find('go')?.receiver, '@unknown');
    assert.equal(find('go')?.rtype ?? null, null);
  });

  it('extracts Rails associations, class << self signatures and de-duplicated mixins', async () => {
    const ex = await extractSource('m.rb', `module Concern
  extend ClassMethods
  extend ClassMethods
  include Concern
  include Other, Other

  module ClassMethods
    include ClassMethods
  end
end

class Blob < Record
  include Concern
  include Concern
  has_many :attachments, autosave: false
  has_one :preview, dependent: :destroy
  belongs_to :user
  has_and_belongs_to_many :tags
  has_one_attached :image
  has_many dynamic_name
  scope :unattached, -> { where.missing(:attachments) }

  class << self
    def compose(blobs, key: nil)
    end

    private def secret(a) = a

    private

    def later; end
  end

  def instance_m; end

  def setup
    has_many :not_a_declaration
  end
end
`);
    assert.deepEqual(symbolList(ex), [
      'namespace Concern',
      'namespace Concern.ClassMethods',
      'class Blob',
      'property Blob.attachments',
      'property Blob.preview',
      'property Blob.user',
      'property Blob.tags',
      'property Blob.image',
      'method Blob.unattached',
      'method Blob.compose',
      'method Blob.secret',
      'method Blob.later',
      'method Blob.instance_m',
      'method Blob.setup',
    ]);
    assert.equal(sym(ex, 'Blob.attachments').signature, 'has_many :attachments, autosave: false');
    assert.equal(sym(ex, 'Blob.user').kind, 'property');
    assert.equal(sym(ex, 'Blob.compose').signature, 'def self.compose(blobs, key: nil)');
    assert.equal(sym(ex, 'Blob.secret').signature, 'private def self.secret(a)');
    assert.equal(sym(ex, 'Blob.later').signature, 'def self.later');
    assert.equal(sym(ex, 'Blob.later').exported, false);
    assert.equal(sym(ex, 'Blob.instance_m').signature, 'def instance_m');
    // Declarations are consumed; anything else stays a call.
    const calls = callList(ex);
    assert.ok(calls.includes('Blob -> has_many'));
    assert.ok(calls.includes('Blob.setup -> has_many'));
    assert.ok(!calls.includes('Blob -> belongs_to'));
    // One entry per (symbol, name); a symbol never lists itself.
    assert.deepEqual(heritageList(ex), [
      'Concern implements ClassMethods',
      'Concern implements Other',
      'Blob extends Record',
      'Blob implements Concern',
    ]);
  });
});
