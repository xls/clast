import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { findSymbols } from '../src/query/resolve.js';
import { callersOf, calleesOf } from '../src/query/callgraph.js';
import { directSubtypes, directSupertypes, goShape, structuralImplementers } from '../src/query/hierarchy.js';
import { callGraph, hierarchy } from '../src/tools/search.js';
import { fileSummary } from '../src/tools/explore.js';
import { arityFits, paramRange } from '../src/query/arity.js';
import { searchSymbols } from '../src/query/search.js';

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
    // Possible, not certain: any type with these methods satisfies the interface.
    assert.deepEqual(callerNames('Job.Run', false), ['Start']);
    assert.deepEqual(callerNames('Job.Run'), []);
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

describe('argument counts', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'java/ConfigDef.java': `public class ConfigDef {
    public ConfigDef define(ConfigKey key) { return this; }
    public ConfigDef define(String name, Type type, String doc) { return define(new ConfigKey(name, type, doc)); }
    public void log(String fmt, Object... args) { }
}
`,
      'java/Use.java': `public class Use {
    void run(ConfigDef def) {
        def.define("a", Type.INT, "doc");
        def.log("x");
        def.log("x", 1, 2);
    }
}
`,
      'java/PartitionInfo.java': `public class PartitionInfo {
    public int partition() { return 0; }
}
`,
      'java/Partitioner.java': `public interface Partitioner {
    int partition(String topic, Object key);
}
`,
      'java/Mock.java': `public class Mock {
    int first(PartitionInfo info) { return info.partition(); }
}
`,
    });
  });
  after(() => q.dispose());

  it('reads parameter ranges from signatures', () => {
    assert.deepEqual(paramRange('public ConfigDef define(ConfigKey key)', 'define', 'java'), { min: 1, max: 1, ext: false, voidable: false });
    assert.equal(paramRange('void log(String fmt, Object... args)', 'log', 'java')!.max, Infinity);
    assert.deepEqual(paramRange('def save(self, force=False, *args, using=None, **kwargs):', 'save', 'python'), { min: 0, max: Infinity, ext: false, voidable: false });
    assert.equal(paramRange('pub fn spawn<F>(&self, future: F) -> JoinHandle<F::Output>', 'spawn', 'rust')!.min, 1);
    assert.equal(paramRange('void old()', 'old', 'c'), null, 'unspecified parameters in C');
    assert.equal(paramRange('void run(void)', 'run', 'c')!.max, 0);
    assert.equal(paramRange('function f(a, b)', 'f', 'javascript'), null, 'JavaScript does not check counts');
    const ext = paramRange('public static IApp UseRouting(this IApp builder)', 'UseRouting', 'csharp')!;
    assert.ok(arityFits(ext, 0, 'csharp', false), 'extension method called as a member');
    const fire = paramRange('fire(event: T): void', 'fire', 'typescript')!;
    assert.ok(arityFits(fire, 0, 'typescript', false), 'Emitter<void>.fire()');
    assert.ok(!arityFits(paramRange('get(key: string, scope: Scope): string', 'get', 'typescript'), 0, 'typescript', false));
  });

  it('tells overloads apart by argument count', () => {
    const [one, three] = findSymbols(q.clast.db, 'ConfigDef.define').sort((a, b) => a.start_line - b.start_line);
    const names = (s: typeof one) => callersOf(q.clast.db, q.ctx.resolver, s!).map(e => e.caller?.qname).sort();
    assert.deepEqual(names(one), ['ConfigDef.define'], 'the 3-argument overload delegates to the 1-argument one');
    assert.deepEqual(names(three), ['Use.run']);
    const log = findSymbols(q.clast.db, 'ConfigDef.log')[0]!;
    assert.equal(callersOf(q.clast.db, q.ctx.resolver, log).reduce((n, e) => n + e.count, 0), 2, 'varargs accept any count');
  });

  it('a call with another argument count is not a caller, even by name', () => {
    const target = findSymbols(q.clast.db, 'Partitioner.partition')[0]!;
    assert.equal(callersOf(q.clast.db, q.ctx.resolver, target).length, 0);
    const info = findSymbols(q.clast.db, 'PartitionInfo.partition')[0]!;
    assert.deepEqual(callersOf(q.clast.db, q.ctx.resolver, info).map(e => e.caller?.qname), ['Mock.first']);
  });
});

describe('descriptive search', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'src/middleware.ts': `export class ProxyMiddleware {
  /** Entry point of the middleware. */
  apply(ctx: Ctx): void {
    const forwardedFor = ctx.headers.get('X-Forwarded-For');
    const remoteIp = parseAddress(forwardedFor);
    ctx.connection.remoteIpAddress = remoteIp;
  }
}

export function parseAddress(text: string): string { return text.trim(); }
`,
      'src/options.ts': `/** Options for forwarded headers. */
export class ForwardedHeadersOptions {
  limit = 1;
}
`,
      'src/overloads.ts': `export function debounce(fn: () => void): void;
export function debounce(fn: () => void, wait: number): void;
export function debounce(fn: () => void, wait?: number): void {
  setTimeout(fn, wait ?? 0);
}
`,
    });
  });
  after(() => q.dispose());

  it('finds a function by what its body does when no name says it', () => {
    const { hits } = searchSymbols(q.clast.db, 'update remote ip from forwarded headers', { limit: 5 });
    assert.equal(hits[0]!.sym.qname, 'ProxyMiddleware.apply');
  });

  it('folds overloads into one hit', () => {
    const { hits } = searchSymbols(q.clast.db, 'debounce', { limit: 5 });
    const own = hits.filter(h => h.sym.name === 'debounce');
    assert.equal(own.length, 1);
    assert.equal(own[0]!.overloads, 2);
  });
});

describe('receiver names that fit several classes', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'auth/base_user.py': `class AbstractBaseUser:
    def set_password(self, raw):
        pass
`,
      'auth/models.py': `class AnonymousUser:
    def set_password(self, raw):
        raise NotImplementedError
`,
      'auth/forms.py': `from auth.models import AnonymousUser


def set_password_and_save(user, password):
    user.set_password(password)
`,
    });
  });
  after(() => q.dispose());

  it('does not present either as certain', () => {
    const s = findSymbols(q.clast.db, 'set_password_and_save')[0]!;
    const callees = calleesOf(q.clast.db, q.ctx.resolver, s).filter(c => c.name === 'set_password');
    assert.ok(callees.length >= 1);
    assert.ok(callees.every(c => !c.certain), 'user.set_password() could be either class');
  });
});

describe('fields of a type declared in another file', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'src/options.ts': `import { Logger } from './logger.js';

export interface Options {
  logger: Logger;
  retries: number;
}
`,
      'src/logger.ts': `export class Logger {
  info(message: string): void {}
}

export class Metrics {
  info(name: string): void {}
}
`,
      'src/run.ts': `import type { Options } from './options.js';

export function run(opts: Options): void {
  opts.logger.info('start');
}
`,
    });
  });
  after(() => q.dispose());

  it('resolves obj.field.method() through the declared field type', () => {
    const edges = callersOf(q.clast.db, q.ctx.resolver, findSymbols(q.clast.db, 'Logger.info')[0]!);
    assert.deepEqual(edges.map(e => [e.caller?.qname, e.certain]), [['run', true]]);
    assert.equal(callersOf(q.clast.db, q.ctx.resolver, findSymbols(q.clast.db, 'Metrics.info')[0]!).length, 0);
  });
});

describe('same-named types from other packages and the standard library', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'go.mod': 'module example.com/app\n',
      'page/page.go': `package page

type Provider interface {
	Content() string
}
`,
      'resource/resource.go': `package resource

type Provider interface {
	Name() string
}

type Closer interface {
	Close() error
}
`,
      'site/out.go': `package site

import (
	"io"

	"example.com/app/page"
)

type Output struct {
	page.Provider
}

type Stream interface {
	io.Closer
	Read() string
}
`,
      'rs/src/wake.rs': `pub trait Wake {
    fn wake(&self);
}

pub struct Handle;

impl Wake for Handle {
    fn wake(&self) {}
}
`,
      'rs/src/other.rs': `use std::task::{Context, Wake};

pub struct Flag;

impl Wake for Flag {
    fn wake(self: Arc<Self>) {}
}
`,
      'cs/Builder.cs': `public class Builder
{
    public Builder(string name) { }
    public Builder(string name, int retries) { }
}

public static class Factory
{
    public static Builder Create() { return new Builder("x", 3); }
}
`,
      'php/SoftDeletes.php': `<?php
namespace App;

trait SoftDeletes
{
    public function restore()
    {
        return $this->save();
    }
}
`,
      'php/Model.php': `<?php
namespace App;

class Model
{
    public function save() {}
}
`,
    });
  });
  after(() => q.dispose());

  const sym = (ref: string) => {
    const s = findSymbols(q.clast.db, ref)[0];
    assert.ok(s, `symbol not found: ${ref}`);
    return s;
  };

  it('a Go embedded type keeps its package', () => {
    const sup = directSupertypes(q.clast.db, q.ctx.resolver, sym('Output'));
    assert.equal(sup[0]!.sym?.path, 'page/page.go');
    assert.equal(directSubtypes(q.clast.db, q.ctx.resolver, sym('resource/resource.go:Provider')).length, 0);
  });

  it('io.Closer is not the project interface called Closer', () => {
    const sup = directSupertypes(q.clast.db, q.ctx.resolver, sym('Stream'));
    assert.equal(sup.find(s => s.name === 'Closer')!.sym, null);
    assert.equal(directSubtypes(q.clast.db, q.ctx.resolver, sym('Closer')).length, 0);
  });

  it('a trait imported from std is not the local trait of that name', () => {
    const subs = directSubtypes(q.clast.db, q.ctx.resolver, sym('Wake')).map(s => s.sym.name);
    assert.deepEqual(subs, ['Handle']);
  });

  it('constructor callers are the sites that create the class, by argument count', () => {
    const ctors = findSymbols(q.clast.db, 'Builder.Builder').sort((a, b) => a.start_line - b.start_line);
    assert.equal(ctors.length, 2);
    assert.equal(callersOf(q.clast.db, q.ctx.resolver, ctors[0]!).length, 0);
    assert.deepEqual(callersOf(q.clast.db, q.ctx.resolver, ctors[1]!).map(e => e.caller?.qname), ['Factory.Create']);
  });

  it('a self call inside a trait is a possible call of the host class method', () => {
    const callees = calleesOf(q.clast.db, q.ctx.resolver, sym('SoftDeletes.restore')).filter(c => c.target);
    assert.deepEqual(callees.map(c => [c.target!.qname, c.certain]), [['Model.save', false]]);
  });
});

describe('C++ default arguments on the declaration', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'cpp/log.h': `#pragma once
void log_line(const char* text, int level = 0);
`,
      'cpp/log.cc': `#include "log.h"

void log_line(const char* text, int level) {
}
`,
      'cpp/main.cc': `#include "log.h"

void run() {
  log_line("start");
  log_line("verbose", 2);
}
`,
    });
  });
  after(() => q.dispose());

  it('a call that relies on the default still reaches the definition', () => {
    const def = findSymbols(q.clast.db, 'cpp/log.cc:log_line')[0]!;
    const edges = callersOf(q.clast.db, q.ctx.resolver, def);
    assert.equal(edges.reduce((n, e) => n + e.count, 0), 2);
  });
});

describe('imports that bind members, instances and submodules', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'java/org/app/util/Utils.java': `package org.app.util;

public class Utils {
    public static String mkEntry(String k, String v) { return k + v; }
}
`,
      'java/org/app/Main.java': `package org.app;

import static org.app.util.Utils.mkEntry;

public class Main {
    String run() { return mkEntry("a", "b"); }
}
`,
      'java/org/app/util/Pair.java': `package org.app.util;

public class Pair {
    public Pair(String k, String v) { }
}
`,
      'java/org/app/Maker.java': `package org.app;

import org.app.util.Pair;

public class Maker {
    Pair make() { return new Pair("a", "b"); }
}
`,
      'py/dispatch.py': `class Signal:
    def send(self, sender):
        pass
`,
      'py/signals.py': `from py.dispatch import Signal

pre_save = Signal()
`,
      'py/base.py': `from py.signals import pre_save


def save_base(instance):
    pre_save.send(instance)
`,
      'py/utils/__init__.py': '',
      'py/utils/text.py': `def slugify(value):
    return value
`,
      'py/views.py': `from py.utils import text


def title(value):
    return text.slugify(value)
`,
      'c/assert.h': `void _fail(const char *expr, const char *file, int line);
#define check(e) ((e) ? (void)0 : _fail(#e, __FILE__, __LINE__))
`,
      'c/assert.c': `#include "assert.h"

void _fail(const char *expr, const char *file, int line) {}
`,
      'c/use.c': `#include "assert.h"

void work(int x) { check(x > 0); }
`,
    });
  });
  after(() => q.dispose());

  const callers = (ref: string): string[] => {
    const s = findSymbols(q.clast.db, ref)[0];
    assert.ok(s, `symbol not found: ${ref}`);
    return callersOf(q.clast.db, q.ctx.resolver, s).filter(e => e.certain).map(e => e.caller?.qname ?? '<file>').sort();
  };

  it('a Java static import makes the bare name a call of that member', () => {
    assert.deepEqual(callers('Utils.mkEntry'), ['Main.run']);
  });

  it('importing a class and constructing it stays a certain call of the constructor', () => {
    assert.deepEqual(callers('Pair.Pair'), ['Maker.make']);
  });

  it('a call on an imported module-level instance has the type it was created with', () => {
    assert.deepEqual(callers('Signal.send'), ['save_base']);
  });

  it('from package import submodule; submodule.func() resolves to the submodule', () => {
    assert.deepEqual(callers('py/utils/text.py:slugify'), ['title']);
  });

  it('a function called only from a macro body has the macro as its caller', () => {
    assert.deepEqual(callers('c/assert.c:_fail'), ['check']);
    assert.deepEqual(callers('check'), ['work']);
  });
});

describe('renamed re-exports', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'src/impl.ts': `export function parseId(text: string): string { return text; }
`,
      'src/barrel.ts': `export { parseId as getId } from './impl.js';
`,
      'src/use.ts': `import { getId } from './barrel.js';

export function handle(text: string): string { return getId(text); }
`,
    });
  });
  after(() => q.dispose());

  it('a call by the re-exported name is a call of the original function', () => {
    const target = findSymbols(q.clast.db, 'parseId')[0]!;
    const edges = callersOf(q.clast.db, q.ctx.resolver, target);
    assert.deepEqual(edges.map(e => [e.caller?.qname, e.certain]), [['handle', true]]);
    const callees = calleesOf(q.clast.db, q.ctx.resolver, findSymbols(q.clast.db, 'handle')[0]!).filter(c => c.target);
    assert.deepEqual(callees.map(c => c.target!.qname), ['parseId']);
  });
});

describe('receivers through assertions and getters', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'src/grid.ts': `export class Grid {
  layout(width: number): void {}
}

export class Sash {
  layout(width: number): void {}
}
`,
      'src/view.ts': `import { Grid } from './grid.js';

export class View {
  private other?: Grid;
  private _grid: Grid | undefined;
  get grid(): Grid | undefined { return this._grid; }

  viaAssertion(): void { this.other!.layout(1); }
  viaGetter(): void { this.grid?.layout(2); }
}
`,
    });
  });
  after(() => q.dispose());

  it('non-null assertions and typed getters give the receiver its type', () => {
    const grid = callersOf(q.clast.db, q.ctx.resolver, findSymbols(q.clast.db, 'Grid.layout')[0]!);
    assert.deepEqual(grid.map(e => [e.caller?.qname, e.certain]).sort(), [['View.viaAssertion', true], ['View.viaGetter', true]]);
    assert.equal(callersOf(q.clast.db, q.ctx.resolver, findSymbols(q.clast.db, 'Sash.layout')[0]!).length, 0);
  });
});

describe('nested helper classes and type construction', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'cs/Assert.cs': `public static class Assert
{
    public static void Equal(int a, int b) { }
}
`,
      'cs/Http2Utilities.cs': `public class Http2Utilities
{
    public static class Assert
    {
        public static void Equal(int a, int b) { }
    }

    void Inside() { Assert.Equal(1, 1); }
}
`,
      'cs/Tests.cs': `public class Tests
{
    void Run() { Assert.Equal(1, 2); }
}
`,
      'swift/Session.swift': `public class Session {
    public init(name: String) {}
}
`,
      'swift/App.swift': `func start() {
    let s = Session(name: "x")
}
`,
    });
  });
  after(() => q.dispose());

  it('an unqualified static call does not mean a class nested inside another class', () => {
    const top = findSymbols(q.clast.db, 'cs/Assert.cs:Equal')[0]!;
    const nested = findSymbols(q.clast.db, 'Http2Utilities.Assert.Equal')[0]!;
    const names = (s: typeof top) => callersOf(q.clast.db, q.ctx.resolver, s).filter(e => e.certain).map(e => e.caller?.qname).sort();
    assert.deepEqual(names(top), ['Tests.Run']);
    assert.deepEqual(names(nested), ['Http2Utilities.Inside']);
  });

  it('Swift Type(...) is a certain reference to the only type of that name', () => {
    const callees = calleesOf(q.clast.db, q.ctx.resolver, findSymbols(q.clast.db, 'start')[0]!).filter(c => c.target);
    assert.ok(callees.some(c => c.target!.name === 'Session' && c.certain), JSON.stringify(callees.map(c => [c.target!.qname, c.certain])));
  });
});

describe('C++ namespace functions', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'cpp/coding.h': `namespace db {
void PutVarint32(int* dst, int value);
}
`,
      'cpp/coding.cc': `#include "coding.h"
namespace db {
void PutVarint32(int* dst, int value) {}
}
`,
      'cpp/edit.h': `namespace db {
class VersionEdit {
 public:
  void EncodeTo(int* dst) const;
};
}
`,
      'cpp/edit.cc': `#include "edit.h"
#include "coding.h"
namespace db {
void VersionEdit::EncodeTo(int* dst) const {
  PutVarint32(dst, 1);
}
}
`,
    });
  });
  after(() => q.dispose());

  it('a free function in a namespace is callable from an out-of-line method of a class', () => {
    const def = findSymbols(q.clast.db, 'cpp/coding.cc:PutVarint32')[0]!;
    const edges = callersOf(q.clast.db, q.ctx.resolver, def);
    assert.deepEqual(edges.map(e => [e.caller?.qname, e.certain]), [['db.VersionEdit.EncodeTo', true]]);
  });
});

describe('Ruby super and top-level constants', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'lib/persistence.rb': `module Persistence
  def create_or_update(**)
    true
  end
end
`,
      'lib/callbacks.rb': `module Callbacks
  def create_or_update(**)
    run_callbacks { super }
  end
end
`,
      'lib/adapters/redis.rb': `module Cable
  module Adapters
    class Redis
    end
  end
end
`,
      'test/slow_redis.rb': `class SlowRedis < Redis
end
`,
    });
  });
  after(() => q.dispose());

  it('bare super in a mixin is a possible call of the same method elsewhere', () => {
    const s = findSymbols(q.clast.db, 'Callbacks.create_or_update')[0]!;
    const callees = calleesOf(q.clast.db, q.ctx.resolver, s).filter(c => c.target);
    assert.deepEqual(callees.map(c => [c.target!.qname, c.certain]), [['Persistence.create_or_update', false]]);
  });

  it('a top-level class extending an unqualified constant does not extend a nested class of that name', () => {
    const redis = findSymbols(q.clast.db, 'Cable.Adapters.Redis')[0]!;
    assert.equal(directSubtypes(q.clast.db, q.ctx.resolver, redis).length, 0);
    const sup = directSupertypes(q.clast.db, q.ctx.resolver, findSymbols(q.clast.db, 'SlowRedis')[0]!);
    assert.equal(sup[0]!.sym, null);
  });
});

describe('Ruby calls without receiver, arguments or parentheses', () => {
  let q: Project;
  before(async () => {
    q = await createProject({
      'lib/person.rb': `class Person
  def save
    true
  end

  def touch
    true
  end

  def offset
    1
  end

  def update(attrs, touch: false)
    offset = 2
    save
    items.each { |save_all| save_all }
    touch
    offset
  end
end
`,
    });
  });
  after(() => q.dispose());

  it('a bare method name is a call; a parameter or local of that name is not', () => {
    const callers = (ref: string) =>
      callersOf(q.clast.db, q.ctx.resolver, findSymbols(q.clast.db, ref)[0]!).filter(e => e.certain).map(e => e.caller?.qname);
    assert.deepEqual(callers('Person.save'), ['Person.update']);
    assert.deepEqual(callers('Person.touch'), [], 'touch is a keyword parameter in update');
    assert.deepEqual(callers('Person.offset'), [], 'offset is assigned as a local in update');
  });
});