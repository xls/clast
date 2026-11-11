import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { findSymbols } from '../src/query/resolve.js';
import { callersOf, calleesOf } from '../src/query/callgraph.js';
import { directSubtypes, directSupertypes, goShape, structuralImplementers } from '../src/query/hierarchy.js';
import { callGraph, hierarchy } from '../src/tools/search.js';
import { fileSummary } from '../src/tools/explore.js';

/**
 * Precision cases found by reviewer agents on real repositories (hugo, tokio,
 * aspnetcore, laravel, rails). Each one used to produce a wrong "resolved" edge
 * or miss a real one.
 */
const FILES: Record<string, string> = {
  // --- Go: packages are directories; a qualified type names one of them ------------------
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'cache/filecache/filecache.go': `package filecache

type Cache struct{}

func (c *Cache) GetOrCreate(id string) (string, error) { return id, nil }

func New() *Cache { return &Cache{} }
`,
  'deps/deps.go': `package deps

type Deps struct{}

func (d *Deps) Close() error { return nil }
`,
  'site/site.go': `package site

import (
	"example.com/app/cache/filecache"
	"example.com/app/deps"
	"github.com/other/lazycache"
)

type Site struct {
	*deps.Deps
	files *filecache.Cache
	lazy  *lazycache.Cache
	Watching bool
}

func (s *Site) Close() error {
	return s.Deps.Close()
}

func (s *Site) Load() {
	s.files.GetOrCreate("a")
	s.lazy.GetOrCreate("b")
	filecache.New()
	lazycache.New()
}

type Conf struct{}

func (c *Conf) Watching() bool { return true }

func (s *Site) Check(c *Conf) bool { return c.Watching() }
`,
  'io/closer.go': `package io

type Closer interface {
	Close() error
}

type Runner interface {
	Run(name string) error
}
`,
  'io/impl.go': `package io

type File struct{}

func (f *File) Close() error { return nil }

type Noisy struct{}

func (n *Noisy) Close() {}

type Parser struct{}

func (p *Parser) Close(node int, reader string) error { return nil }

type Job struct{}

func (j *Job) Run(name string) error { return nil }

func Start(r Runner) { r.Run("x") }
`,
  // --- Rust: impl Trait for Arc<T> belongs to T; qualified bounds are other crates -----------
  'rs/src/lib.rs': `pub trait Schedule {
    fn schedule(&self);
}

pub trait AsyncRead {
    fn poll_read(&self);
}

pub struct Handle;

impl Schedule for Arc<Handle> {
    fn schedule(&self) {}
}

impl<T: AsyncRead> AsyncRead for Box<T> {
    fn poll_read(&self) {}
}

pub trait CompatExt: futures_io::AsyncRead {
    fn compat(self);
}
`,
  // --- C#: arity, partial classes, static classes -------------------------------------------
  'cs/ActionResult.cs': `namespace Mvc;

public abstract class ActionResult
{
    public virtual void Execute() { }
}
`,
  'cs/ActionResultOfT.cs': `namespace Mvc;

public sealed class ActionResult<TValue>
{
    public TValue Value { get; }
}
`,
  'cs/ObjectResult.cs': `namespace Mvc;

public class ObjectResult : ActionResult
{
    public override void Execute() { }
}
`,
  'cs/Wrapped.cs': `namespace Mvc;

public class Wrapped<T> : ActionResult
{
}
`,
  'cs/Conn.cs': `namespace Kestrel;

public partial class Conn : Protocol
{
    public void Start() { }
}
`,
  'cs/Conn.Features.cs': `namespace Kestrel;

public partial class Conn : IFeature
{
    public void Feature() { }
}
`,
  'cs/Protocol.cs': `namespace Kestrel;

public abstract class Protocol
{
}

public interface IFeature
{
}
`,
  'cs/abstractions/Protocol.cs': `namespace Abstractions;

public static class Protocol
{
    public static string Http11 = "HTTP/1.1";
}
`,
  // --- PHP: a call bound to an override does not run the base method -----------------------
  'php/Builder.php': `<?php
namespace App;

class Builder
{
    public function firstOrCreate(array $attributes = [])
    {
        return $this->create($attributes);
    }

    public function updateOrCreate(array $attributes = [])
    {
        return $this->firstOrCreate($attributes);
    }

    public function create(array $attributes = []) {}
}
`,
  'php/Relation.php': `<?php
namespace App;

class Relation extends Builder
{
    public function firstOrCreate(array $attributes = [])
    {
        return null;
    }

    public function restoreOrCreate(array $attributes = [])
    {
        return $this->firstOrCreate($attributes);
    }
}
`,
  // --- Ruby: constants are looked up lexically; modules are mixins ---------------------------
  'rb/lib/active/enum.rb': `module Active
  module Enum
    def enum(name); end
  end
end
`,
  'rb/lib/active/adapters/oid/enum.rb': `module Active
  module Adapters
    module OID
      class Enum
        def cast(value); end
      end
    end
  end
end
`,
  'rb/lib/active/base.rb': `module Active
  class Base
    extend Enum

    def save; end

    private

    def write_row; end
  end
end
`,
};

let p: Project;
before(async () => {
  p = await createProject(FILES);
});
after(() => p.dispose());

function one(ref: string) {
  const s = findSymbols(p.clast.db, ref)[0];
  assert.ok(s, `symbol not found: ${ref}`);
  return s;
}

const callerNames = (ref: string, certainOnly = true): string[] =>
  callersOf(p.clast.db, p.ctx.resolver, one(ref))
    .filter(e => !certainOnly || e.certain)
    .map(e => e.caller?.qname ?? '<file>')
    .sort();

describe('Go packages', () => {
  it('a receiver typed with an external package type is not a project type of the same name', () => {
    const edges = callersOf(p.clast.db, p.ctx.resolver, one('Cache.GetOrCreate'));
    assert.equal(edges.length, 1, 'only s.files.GetOrCreate, not s.lazy.GetOrCreate');
    assert.equal(edges[0]!.line, 21);
    assert.equal(edges[0]!.certain, true);
  });

  it('pkg.Func() resolves through the import to the package directory', () => {
    assert.deepEqual(callerNames('filecache.go:New'), ['Site.Load']);
    const callees = calleesOf(p.clast.db, p.ctx.resolver, one('Site.Load')).filter(c => c.target);
    assert.deepEqual(callees.map(c => c.target!.qname).sort(), ['Cache.GetOrCreate', 'New']);
  });

  it('a call through an embedded field goes to the embedded type, even in a directory called deps', () => {
    const callees = calleesOf(p.clast.db, p.ctx.resolver, one('Site.Close')).filter(c => c.target);
    assert.deepEqual(callees.map(c => c.target!.qname), ['Deps.Close']);
    assert.deepEqual(callerNames('Deps.Close'), ['Site.Close']);
  });

  it('a non-function field is not the target of a call', () => {
    const callees = calleesOf(p.clast.db, p.ctx.resolver, one('Site.Check')).filter(c => c.target);
    assert.deepEqual(callees.map(c => c.target!.qname), ['Conf.Watching']);
    assert.equal(callees[0]!.target!.kind, 'method');
  });

  it('interface satisfaction compares parameter and result counts', () => {
    assert.equal(goShape('Close() error', 'Close'), '0/1');
    assert.equal(goShape('func (n *Noisy) Close()', 'Close'), '0/0');
    assert.equal(goShape('func (p *Parser) Close(node int, reader string) error', 'Close'), '2/1');
    assert.equal(goShape('func (s *S) Get(a, b int) (v string, err error)', 'Get'), '2/2');
    const impls = structuralImplementers(p.clast.db, one('Closer')).map(s => s.name).sort();
    assert.deepEqual(impls, ['Deps', 'File', 'Site']);
  });

  it('callers of a method include calls through an interface its type satisfies', () => {
    assert.deepEqual(callerNames('Job.Run'), ['Start']);
  });
});

describe('Rust impl targets', () => {
  it('impl Trait for Arc<T> is an implementation by T', () => {
    const subs = directSubtypes(p.clast.db, p.ctx.resolver, one('Schedule')).map(s => s.sym.name);
    assert.deepEqual(subs, ['Handle']);
    assert.ok(findSymbols(p.clast.db, 'Handle.schedule').length === 1);
  });

  it('a bound qualified with another crate is not the local trait', () => {
    const subs = directSubtypes(p.clast.db, p.ctx.resolver, one('AsyncRead')).map(s => s.sym.name);
    assert.ok(!subs.includes('CompatExt'), subs.join(','));
    const sup = directSupertypes(p.clast.db, p.ctx.resolver, one('CompatExt'));
    assert.equal(sup[0]!.name, 'AsyncRead');
    assert.equal(sup[0]!.sym, null);
  });
});

describe('C# types', () => {
  it('Foo and Foo<T> are different types', () => {
    const sup = directSupertypes(p.clast.db, p.ctx.resolver, one('ObjectResult'));
    assert.equal(sup[0]!.sym?.path, 'cs/ActionResult.cs');
    const plain = directSubtypes(p.clast.db, p.ctx.resolver, one('cs/ActionResult.cs:ActionResult')).map(s => s.sym.name).sort();
    assert.deepEqual(plain, ['ObjectResult', 'Wrapped']);
    const generic = directSubtypes(p.clast.db, p.ctx.resolver, one('cs/ActionResultOfT.cs:ActionResult'));
    assert.equal(generic.length, 0);
  });

  it('partial classes are one class and static classes are not base types', async () => {
    const sup = directSupertypes(p.clast.db, p.ctx.resolver, one('cs/Conn.cs:Conn'));
    assert.deepEqual(sup.map(s => s.name).sort(), ['IFeature', 'Protocol']);
    assert.equal(sup.find(s => s.name === 'Protocol')!.sym?.path, 'cs/Protocol.cs');
    const text = await hierarchy(p.ctx, { name: 'Conn' });
    assert.doesNotMatch(text, /other definition/);
    const proto = await hierarchy(p.ctx, { name: 'Protocol' });
    assert.match(proto, /^class Protocol {2}cs\/Protocol\.cs/);
    assert.match(proto, /class Conn {2}cs\/Conn/);
  });
});

describe('overrides', () => {
  it('a call bound to a subclass override is not a caller of the base method', async () => {
    assert.deepEqual(callerNames('Builder.firstOrCreate'), ['Builder.updateOrCreate']);
    // The other direction stays: a call bound to the base method may dispatch to the override.
    assert.deepEqual(callerNames('Relation.firstOrCreate'), ['Builder.updateOrCreate', 'Relation.restoreOrCreate']);
    const text = await callGraph(p.ctx, { name: 'Builder.firstOrCreate', direction: 'callers' });
    assert.doesNotMatch(text, /restoreOrCreate/);
  });
});

describe('Ruby constants', () => {
  it('extend / include of a module resolves lexically', () => {
    const sup = directSupertypes(p.clast.db, p.ctx.resolver, one('Active.Base'));
    assert.equal(sup.length, 1);
    assert.equal(sup[0]!.sym?.qname, 'Active.Enum');
    const subs = directSubtypes(p.clast.db, p.ctx.resolver, one('Active.Enum')).map(s => s.sym.qname);
    assert.deepEqual(subs, ['Active.Base']);
    assert.equal(directSubtypes(p.clast.db, p.ctx.resolver, one('Active.Adapters.OID.Enum')).length, 0);
  });

  it('outlines mark private methods', async () => {
    const text = await fileSummary(p.ctx, { path: 'rb/lib/active/base.rb' });
    assert.match(text, /private def write_row/);
    assert.doesNotMatch(text, /private def save/);
  });
});

describe('super calls, sibling subclasses and file-local functions', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'py/models.py': `class Model:
    def save(self):
        pass


class User(Model):
    def save(self):
        super().save()


class Holder(Model):
    pass


def use(h: Holder, u: User):
    h.save()
    u.save()
`,
      'py/mixins.py': `class AuditMixin:
    def save(self):
        super().save()
`,
      'c/a.c': `static void helper(void) {}
void run_a(void) { helper(); }
`,
      'c/b.c': `static void helper(void) {}
void run_b(void) { helper(); }
`,
    });
  });
  after(() => q.dispose());

  const callers = (ref: string, certainOnly = true): string[] => {
    const s = findSymbols(q.clast.db, ref)[0];
    assert.ok(s, `symbol not found: ${ref}`);
    return callersOf(q.clast.db, q.ctx.resolver, s)
      .filter(e => !certainOnly || e.certain)
      .map(e => e.caller?.qname ?? '<file>')
      .sort();
  };

  it('super().m() calls the parent implementation, not the enclosing method', () => {
    assert.deepEqual(callers('Model.save'), ['User.save', 'use']);
    const s = findSymbols(q.clast.db, 'User.save')[0]!;
    const callees = calleesOf(q.clast.db, q.ctx.resolver, s).filter(c => c.target);
    assert.deepEqual(callees.map(c => c.target!.qname), ['Model.save']);
  });

  it('a call on a sibling subclass is not a caller of the override', () => {
    assert.deepEqual(callers('User.save'), ['use']);
    const edges = callersOf(q.clast.db, q.ctx.resolver, findSymbols(q.clast.db, 'User.save')[0]!);
    assert.deepEqual(edges.filter(e => e.certain).map(e => e.line), [17], 'u.save() only, not h.save()');
  });

  it('super() in a mixin with no declared parent is a possible caller, never a certain one', () => {
    const all = callers('Model.save', false);
    assert.ok(all.includes('AuditMixin.save'));
    assert.ok(!callers('Model.save').includes('AuditMixin.save'));
  });

  it('C static functions of the same name in different files are different functions', () => {
    assert.deepEqual(callers('c/a.c:helper'), ['run_a']);
    assert.deepEqual(callers('c/b.c:helper'), ['run_b']);
  });
});