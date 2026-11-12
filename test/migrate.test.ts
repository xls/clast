import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, planMigration } from '../src/migrate.js';

let home: string;
let project: string;
let other: string;
const removed: string[] = [];
const remove = (name: string, scope: 'user' | 'local', cwd: string): boolean => {
  removed.push(`${scope}:${name}:${cwd}`);
  return true;
};

function setup(withPlugin: boolean): void {
  home = mkdtempSync(join(tmpdir(), 'clast-mig-home-'));
  project = mkdtempSync(join(tmpdir(), 'clast-mig-proj-'));
  other = mkdtempSync(join(tmpdir(), 'clast-mig-other-'));
  removed.length = 0;
  process.env.CLAUDE_PLUGIN_DATA = join(home, 'plugin-data');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      clast: { type: 'stdio', command: 'clast-ai', args: [] },
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    },
    projects: {
      [other]: { mcpServers: { index: { command: 'node', args: ['C:/tools/clast/dist/cli.js'] } } },
      'Z:/gone/long/ago': { mcpServers: { clast: { command: 'clast-ai.cmd', args: [] } } },
      'Z:/gone/too': { mcpServers: { clast: { command: 'node', args: ['/path/to/clast/dist/server/index.js'] } } },
      [project]: { mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'] } } },
    },
  }));
  if (withPlugin) {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2, plugins: { 'clast@clast': [{ scope: 'user', version: '0.2.1' }] },
    }));
  }
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    mcpServers: { clast: { command: 'node', args: ['C:/ext/clast-ai/dist/cli.js'], env: { CLAST_PROJECT_DIR: project } } },
  }));
  mkdirSync(join(project, '.clast'), { recursive: true });
  writeFileSync(join(project, '.clast', 'clast.db'), 'old');
  writeFileSync(join(project, '.clast', 'index.db'), 'new');
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { clast: { command: 'clast-ai' } } }));
}
function teardown(): void {
  for (const d of [home, project, other]) rmSync(d, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
}

describe('clast-ai migrate', () => {
  before(() => setup(true));
  after(teardown);

  it('finds registrations of clast in every scope and leaves other servers alone', () => {
    const plan = planMigration(home, project);
    assert.deepEqual(plan.map(a => a.kind + (a.kind === 'mcp' ? ':' + a.scope + ':' + a.name : '')).sort(), [
      'index', 'mcp:local:clast', 'mcp:local:clast', 'mcp:local:index', 'mcp:user:clast', 'settings', 'shared',
    ]);
  });

  it('only reports without --apply', async () => {
    const out = await migrate({ home, cwd: project, remove });
    assert.match(out, /found 7 leftovers/);
    assert.match(out, /migrate --apply/);
    assert.equal(removed.length, 0);
    assert.ok(existsSync(join(project, '.clast', 'clast.db')));
  });

  it('removes them with --apply, keeps the shared file and the new index', async () => {
    const out = await migrate({ home, cwd: project, remove, apply: true });
    assert.deepEqual(removed.sort(), [`local:index:${other}`, `user:clast:${project}`].sort());
    assert.match(out, /skipped \(directory no longer exists\)/);
    assert.match(out, /left alone: server "clast" in .*\.mcp\.json/);
    assert.ok(!existsSync(join(project, '.clast', 'clast.db')));
    assert.ok(existsSync(join(project, '.clast', 'index.db')));
    const settings = JSON.parse(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepEqual(settings, { permissions: { allow: ['Bash(npm test)'] } });
    assert.ok(existsSync(join(project, '.mcp.json')));
  });
});

describe('clast-ai migrate --auto (run by the plugin at session start)', () => {
  before(() => setup(true));
  after(teardown);

  it('cleans up once per version', async () => {
    const first = await migrate({ home, cwd: project, remove, auto: true });
    assert.match(first, /removed: server "clast" registered for all projects/);
    assert.equal(removed.length, 2);
    assert.match(readFileSync(join(home, 'plugin-data', 'migrate.log'), 'utf8'), /removed: server "clast"/);
    removed.length = 0;
    const second = await migrate({ home, cwd: project, remove, auto: true });
    assert.equal(second, '');
    assert.equal(removed.length, 0);
  });

  it('still deletes an old index in a project it sees later', async () => {
    writeFileSync(join(other, 'placeholder'), '');
    mkdirSync(join(other, '.clast'), { recursive: true });
    writeFileSync(join(other, '.clast', 'clast.db'), 'old');
    const out = await migrate({ home, cwd: other, remove, auto: true });
    assert.match(out, /deleted: v0\.1 index/);
    assert.equal(removed.length, 0);
  });
});

describe('clast-ai migrate with CLAUDE_CONFIG_DIR', () => {
  before(() => {
    setup(true);
    // Move the configuration to where CLAUDE_CONFIG_DIR puts it: nothing is left in the home directory.
    const dir = join(home, 'cfg');
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(join(dir, '.claude.json'), readFileSync(join(home, '.claude.json')));
    writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json')));
    rmSync(join(home, '.claude.json'));
    rmSync(join(home, '.claude'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = dir;
  });
  after(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    teardown();
  });

  it('reads the configuration from there', async () => {
    const out = await migrate({ home, cwd: project, remove, auto: true });
    assert.match(out, /removed: server "clast" registered for all projects/);
    assert.equal(removed.length, 2);
  });
});

describe('clast-ai migrate without the plugin', () => {
  before(() => setup(false));
  after(teardown);

  it('does nothing in auto mode', async () => {
    assert.equal(await migrate({ home, cwd: project, remove, auto: true }), '');
    assert.equal(removed.length, 0);
    assert.ok(existsSync(join(project, '.clast', 'clast.db')));
  });

  it('keeps the registrations unless forced, since they are the only install', async () => {
    const out = await migrate({ home, cwd: project, remove, apply: true });
    assert.match(out, /registrations kept: the clast plugin is not installed/);
    assert.equal(removed.length, 0);
    assert.ok(!existsSync(join(project, '.clast', 'clast.db')));
    await migrate({ home, cwd: project, remove, apply: true, force: true });
    assert.equal(removed.length, 2);
  });
});
