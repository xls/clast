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
    assert.equal(sym(ex, 'Outer.Foo.Bar.build').signature, 'def build(x)');
    assert.equal(sym(ex, 'Outer.Foo.Bar.==').signature, 'def ==(other)');
    assert.equal(sym(ex, 'Outer.Foo.Bar.name=').signature, 'def name=(v)');
    assert.equal(sym(ex, 'Outer.Foo.Bar.valid?').signature, 'def valid?');
    assert.equal(sym(ex, 'Outer.Foo.Bar.priv').signature, 'private def priv(a)');
    assert.equal(sym(ex, 'Outer.Foo.Bar.hidden').signature, 'def hidden');
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
      'Outer.Foo.Bar.run -> call',
      'Outer.Foo.Bar.run -> helper',
      'Outer.Foo.Bar.run -> a.b',
      'Outer.Foo.Bar.run -> c',
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
});
