import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { stats } from '../src/tools/stats.js';
import { isTestPath } from '../src/query/format.js';

let p: Project;

before(async () => {
  p = await createProject({
    'src/radio/base.ts': `
export abstract class Receiver { abstract feed(n: number): void; }
export class FmReceiver extends Receiver { feed(n: number): void {} }
export class AmReceiver extends Receiver { feed(n: number): void {} }
`,
    'src/radio/digital/dab.ts': `
import { FmReceiver } from '../base';
export class DabReceiver extends FmReceiver { feed(n: number): void {} }
export class Helper {}
`,
    'src/api/routes.ts': `
import express from 'express';
import { Pool } from 'pg';
const app = express();
const db: Pool = new Pool();
app.get('/users', async (req, res) => { res.json(await db.query('SELECT id FROM users')); });
app.post('/users', async (req, res) => { await db.query('INSERT INTO users VALUES (1)'); res.end(); });
app.delete('/users/:id', (req, res) => res.end());
export function unrelated(list: number[]): number[] { return list.filter(x => x > 0); }
`,
    'test/routes.test.ts': `
import express from 'express';
const app = express();
app.get('/fake', () => {});
export class TestReceiver {}
`,
    'schema.sql': `CREATE TABLE users (id INTEGER);\nCREATE TABLE orders (id INTEGER);\n`,
  });
});
after(() => p.dispose());

describe('clast_stats', () => {
  it('counts symbols by name pattern, leaving tests out of the total', async () => {
    const out = await stats(p.ctx, { what: 'symbols', name: '*Receiver', kind: 'class' });
    assert.match(out, /^4 symbol definitions named \*Receiver of kind class \(plus 1 in tests\/examples/);
    assert.match(out, /distinct names: 4/);
    assert.match(out, /4 {2}src\/radio\//);
    const deeper = await stats(p.ctx, { what: 'symbols', name: '*Receiver', kind: 'class', depth: 3 });
    assert.match(deeper, /3 {2}src\/radio\//);
    assert.match(deeper, /1 {2}src\/radio\/digital\//);
  });

  it('includes tests on request and says how many', async () => {
    const out = await stats(p.ctx, { what: 'symbols', name: '*Receiver', kind: 'class', includeTests: true });
    assert.match(out, /^5 symbol definitions .*\(1 of them in tests\/examples\)/);
  });

  it('groups by file, name or kind', async () => {
    const out = await stats(p.ctx, { what: 'symbols', name: '*Receiver|Helper', groupBy: 'file' });
    assert.match(out, /2 {2}src\/radio\/digital\/dab\.ts/);
    assert.match(out, /3 {2}src\/radio\/base\.ts/);
  });

  it('counts direct and indirect subtypes', async () => {
    const out = await stats(p.ctx, { what: 'subtypes', name: 'Receiver' });
    assert.match(out, /^3 subtypes of class Receiver .*: 2 direct, 1 indirect/);
  });

  it('counts subtypes of a library type by name', async () => {
    const q = await createProject({
      'a.ts': `import { Component } from 'react';\nexport class A extends Component {}\nexport class B extends A {}\n`,
    });
    try {
      const out = await stats(q.ctx, { what: 'subtypes', name: 'Component' });
      assert.match(out, /^2 subtypes of Component \(not defined in this project/);
      assert.match(out, /1 direct, 1 indirect/);
    } finally {
      q.dispose();
    }
  });

  it('counts call sites by name and receiver', async () => {
    const all = await stats(p.ctx, { what: 'calls', name: 'query' });
    assert.match(all, /^2 call sites of query /);
    const none = await stats(p.ctx, { what: 'calls', name: 'query', on: 'cache' });
    assert.match(none, /^0 call sites/);
    const typed = await stats(p.ctx, { what: 'calls', name: 'query', on: 'Pool|db' });
    assert.match(typed, /^2 call sites/);
  });

  it('counts text matches with a breakdown by matched text', async () => {
    const out = await stats(p.ctx, { what: 'text', name: 'CREATE TABLE (\\w+)', groupBy: 'match' });
    assert.match(out, /^2 matches /);
    assert.match(out, /1 {2}users/);
    assert.match(out, /1 {2}orders/);
  });

  it('finds route declarations and keeps test routes apart', async () => {
    const out = await stats(p.ctx, { what: 'endpoints' });
    assert.match(out, /^HTTP \/ RPC endpoints: 3 found by pattern in 1 file \(plus 1 in tests\/examples/);
    assert.match(out, /1 {2}delete/);
  });

  it('reports database access', async () => {
    const out = await stats(p.ctx, { what: 'database' });
    assert.match(out, /CREATE TABLE statements/);
    assert.match(out, /SQL statements in source/);
    assert.match(out, /query-method call sites on database-like receivers.*: 2/);
  });

  it('keeps outbound client requests apart from endpoints and counts Prisma models and calls', async () => {
    // Found on a real NestJS + React + Prisma application: `api.get(...)` in the front end was
    // counted as an Express route, and Prisma models and queries were not seen at all.
    const q = await createProject({
      'backend/src/users.controller.ts': `
import { Controller, Get, Post } from '@nestjs/common';
@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}
  @Get()
  list() { return this.prisma.user.findMany(); }
  @Post()
  add() { return this.prisma.user.create({ data: {} }); }
}
`,
      'frontend/src/api.ts': `
import axios from 'axios';
const api = axios.create();
export const loadUsers = () => api.get('/users');
export const addUser = () => api.post('/users');
`,
      'backend/prisma/schema.prisma': `model User {\n  id Int @id\n}\n\nmodel Order {\n  id Int @id\n}\n`,
    });
    try {
      const endpoints = await stats(q.ctx, { what: 'endpoints' });
      assert.match(endpoints, /^HTTP \/ RPC endpoints: 2 found by pattern in 1 file/);
      assert.match(endpoints, /outbound HTTP requests \(calls this code makes; not endpoints\): 2 in 1 file/);
      const database = await stats(q.ctx, { what: 'database' });
      assert.match(database, /2 {2}Prisma models \(schema\.prisma\)/);
      assert.match(database, /query-method call sites on database-like receivers.*: 2/);
      assert.match(database, /2 {2}prisma\.user/);
    } finally {
      q.dispose();
    }
  });

  it('lists external dependencies', async () => {
    const out = await stats(p.ctx, { what: 'imports' });
    assert.match(out, /1 {2}express/);
    assert.match(out, /1 {2}pg/);
  });

  it('gives an inventory by default', async () => {
    const out = await stats(p.ctx, {});
    assert.match(out, /^inventory: 4 indexed source files/);
    assert.match(out, /production: 3 files/);
    assert.match(out, /tests \/ examples: 1 files/);
    assert.match(out, /symbols by kind/);
  });

  it('rejects a bad regular expression and a missing name', async () => {
    assert.match(await stats(p.ctx, { what: 'text', name: '(' }), /^error: invalid regular expression/);
    assert.match(await stats(p.ctx, { what: 'calls' }), /^error: name is required/);
  });
});

describe('test path classification', () => {
  it('treats package directories below a Maven main source root as production code', () => {
    assert.equal(isTestPath('src/main/java/org/springframework/samples/petclinic/owner/Owner.java'), false);
    assert.equal(isTestPath('src/test/java/org/springframework/samples/petclinic/owner/OwnerTests.java'), true);
    assert.equal(isTestPath('samples/demo/src/main/java/com/acme/App.java'), true);
    assert.equal(isTestPath('src/main/java/com/acme/FooTests.java'), true);
  });
});
