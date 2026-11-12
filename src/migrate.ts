import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from './version.js';

// ---------------------------------------------------------------------------
// clast-ai migrate: remove what older installs left behind
// ---------------------------------------------------------------------------
//
// Before the plugin, clast was registered by hand (`claude mcp add`) or by the old VS Code extension
// (`.claude/settings.local.json`). With the plugin installed those registrations start a second copy
// of the server and list every tool twice. This finds them, and the v0.1 index file, and removes them.

export interface MigrateOptions {
  /** Make the changes. Default: only report. */
  apply?: boolean;
  /** Run from the plugin at session start: once per version, silent, only when the plugin is installed. */
  auto?: boolean;
  /** Remove hand-made registrations even when the plugin is not installed. */
  force?: boolean;
  home?: string;
  cwd?: string;
  /** Replaces `claude mcp remove` (tests). Returns true on success. */
  remove?: (name: string, scope: 'user' | 'local', cwd: string) => boolean;
}

export type Action =
  | { kind: 'mcp'; scope: 'user' | 'local'; name: string; dir: string; command: string }
  | { kind: 'settings'; file: string; name: string }
  | { kind: 'index'; files: string[] }
  | { kind: 'shared'; file: string; name: string };

interface ServerEntry {
  command?: string;
  args?: unknown[];
}

/** A registration of this server: by name, by the `clast-ai` binary, or by a path to its cli.js. */
function isClast(_name: string, entry: ServerEntry | undefined): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const command = String(entry.command ?? '');
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (/(^|[\\/])clast-ai(\.cmd|\.exe)?$/i.test(command)) return true;
  // dist/cli.js, and dist/server/index.js as the 0.1 README registered a build from source.
  if (args.some(a => /clast[^\\/]*[\\/]dist[\\/](cli|server[\\/]index)\.js$/i.test(a))) return true;
  // `npx clast-ai`, `npx -y clast-ai@0.1`
  if (/(^|[\\/])npx(\.cmd)?$/i.test(command) && args.some(a => /^clast-ai(@|$)/.test(a))) return true;
  return false;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function describe(entry: ServerEntry): string {
  return [entry.command ?? '', ...(Array.isArray(entry.args) ? entry.args.map(String) : [])].join(' ').trim();
}

/** Is the clast plugin installed for this user? */
/**
 * Where Claude Code keeps its configuration: `~/.claude.json` and `~/.claude/`, or both inside
 * CLAUDE_CONFIG_DIR when that is set.
 */
function claudePaths(home: string): { config: string; plugins: string } {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir
    ? { config: join(dir, '.claude.json'), plugins: join(dir, 'plugins') }
    : { config: join(home, '.claude.json'), plugins: join(home, '.claude', 'plugins') };
}

export function pluginInstalled(home: string): boolean {
  const installed = readJson(join(claudePaths(home).plugins, 'installed_plugins.json'));
  const plugins = (installed?.plugins ?? {}) as Record<string, unknown>;
  return Object.keys(plugins).some(id => /^clast@/.test(id));
}

/** Everything an older install left behind, without changing anything. */
export function planMigration(home: string, cwd: string): Action[] {
  const actions: Action[] = [];
  const config = readJson(claudePaths(home).config);
  const servers = (config?.mcpServers ?? {}) as Record<string, ServerEntry>;
  for (const [name, entry] of Object.entries(servers)) {
    if (isClast(name, entry)) actions.push({ kind: 'mcp', scope: 'user', name, dir: cwd, command: describe(entry) });
  }
  const projects = (config?.projects ?? {}) as Record<string, { mcpServers?: Record<string, ServerEntry> }>;
  for (const [dir, project] of Object.entries(projects)) {
    for (const [name, entry] of Object.entries(project?.mcpServers ?? {})) {
      if (isClast(name, entry)) actions.push({ kind: 'mcp', scope: 'local', name, dir, command: describe(entry) });
    }
  }
  // Written by the old VS Code extension.
  const settingsFile = join(cwd, '.claude', 'settings.local.json');
  const settings = readJson(settingsFile);
  for (const [name, entry] of Object.entries((settings?.mcpServers ?? {}) as Record<string, ServerEntry>)) {
    if (isClast(name, entry)) actions.push({ kind: 'settings', file: settingsFile, name });
  }
  // The v0.1 index. v0.2 keeps its own file (.clast/index.db) and never reads this one.
  const old = ['clast.db', 'clast.db-wal', 'clast.db-shm'].map(f => join(cwd, '.clast', f)).filter(f => existsSync(f));
  if (old.length) actions.push({ kind: 'index', files: old });
  // A team's shared file is theirs to change.
  const sharedFile = join(cwd, '.mcp.json');
  const shared = readJson(sharedFile);
  for (const [name, entry] of Object.entries((shared?.mcpServers ?? {}) as Record<string, ServerEntry>)) {
    if (isClast(name, entry)) actions.push({ kind: 'shared', file: sharedFile, name });
  }
  return actions;
}

function claudeRemove(name: string, scope: 'user' | 'local', cwd: string): boolean {
  const windows = process.platform === 'win32';
  // Fixed words plus a server name restricted to safe characters: nothing to escape.
  if (!/^[\w.-]+$/.test(name)) return false;
  const result = windows
    ? spawnSync(`claude mcp remove ${name} -s ${scope}`, { cwd, shell: true, stdio: 'ignore', windowsHide: true, timeout: 30_000 })
    : spawnSync('claude', ['mcp', 'remove', name, '-s', scope], { cwd, stdio: 'ignore', timeout: 30_000 });
  return result.status === 0;
}

function line(a: Action): string {
  switch (a.kind) {
    case 'mcp':
      return a.scope === 'user'
        ? `server "${a.name}" registered for all projects (${a.command})`
        : `server "${a.name}" registered for ${a.dir} (${a.command})`;
    case 'settings':
      return `server "${a.name}" in ${a.file} (written by the old VS Code extension)`;
    case 'index':
      return `v0.1 index: ${a.files.join(', ')}`;
    case 'shared':
      return `server "${a.name}" in ${a.file} (shared with your team: not changed; remove it there if everyone uses the plugin)`;
  }
}

export async function migrate(opts: MigrateOptions = {}): Promise<string> {
  const home = opts.home ?? homedir();
  const cwd = resolve(opts.cwd ?? process.env.CLAST_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const stateDir = process.env.CLAUDE_PLUGIN_DATA || join(home, '.clast-ai');
  const marker = join(stateDir, 'migrated.json');
  const plugin = pluginInstalled(home);

  if (opts.auto) {
    // Only the plugin starts this, but be sure: without it the registrations are the only install there is.
    if (!plugin) return '';
    const done = readJson(marker);
    const fresh = done?.version !== VERSION;
    // The registrations are checked once per version; a project's old index whenever it is seen.
    const plan = planMigration(home, cwd).filter(a => a.kind === 'index' || (fresh && a.kind !== 'shared'));
    const report = plan.length ? apply(plan, opts) : [];
    try {
      mkdirSync(stateDir, { recursive: true });
      if (fresh) writeFileSync(marker, JSON.stringify({ version: VERSION, at: new Date().toISOString() }) + '\n');
      if (report.length) {
        appendFileSync(join(stateDir, 'migrate.log'), `${new Date().toISOString()} clast ${VERSION}\n${report.map(r => '  ' + r).join('\n')}\n`);
      }
    } catch {
      // A read-only home directory must not stop the server.
    }
    return report.join('\n');
  }

  const plan = planMigration(home, cwd);
  const out: string[] = [];
  const removable = plan.filter(a => a.kind !== 'shared');
  const blocked = !plugin && !opts.force;
  if (plan.length === 0) {
    out.push('nothing to migrate: no older clast registration or index found.');
  } else if (!opts.apply) {
    out.push(`found ${plan.length} leftover${plan.length === 1 ? '' : 's'} of an older clast install:`);
    for (const a of plan) out.push(`  - ${line(a)}`);
    if (removable.length) {
      out.push(
        blocked
          ? 'The clast plugin is not installed, so the registrations above are your only install. Install the plugin ' +
              '(/plugin marketplace add xls/clast, /plugin install clast@clast) and run this again, or pass --force.'
          : 'Run `clast-ai migrate --apply` to remove them (the plugin provides the server).'
      );
    }
  } else {
    const todo = blocked ? removable.filter(a => a.kind === 'index') : removable;
    out.push(...apply(todo, opts));
    for (const a of plan.filter(p => p.kind === 'shared')) out.push(`left alone: ${line(a)}`);
    if (blocked && removable.some(a => a.kind !== 'index')) {
      out.push('registrations kept: the clast plugin is not installed (pass --force to remove them anyway).');
    }
    if (todo.some(a => a.kind === 'mcp' || a.kind === 'settings')) out.push('Restart Claude Code to apply.');
  }
  if (!plugin) out.push('plugin: not installed.');
  return out.join('\n');
}

function apply(plan: Action[], opts: MigrateOptions): string[] {
  const remove = opts.remove ?? claudeRemove;
  const report: string[] = [];
  for (const a of plan) {
    try {
      if (a.kind === 'mcp') {
        if (a.scope === 'local' && !existsSync(a.dir)) {
          report.push(`skipped (directory no longer exists): ${line(a)}`);
          continue;
        }
        report.push(`${remove(a.name, a.scope, a.dir) ? 'removed' : 'could not remove (is the claude CLI on PATH?)'}: ${line(a)}`);
      } else if (a.kind === 'settings') {
        const settings = readJson(a.file);
        const servers = settings?.mcpServers as Record<string, unknown> | undefined;
        if (settings && servers && a.name in servers) {
          delete servers[a.name];
          if (Object.keys(servers).length === 0) delete settings.mcpServers;
          writeFileSync(a.file, JSON.stringify(settings, null, 2) + '\n');
          report.push(`removed: ${line(a)}`);
        }
      } else if (a.kind === 'index') {
        for (const f of a.files) rmSync(f, { force: true });
        report.push(`deleted: ${line(a)}`);
      }
    } catch (err) {
      report.push(`failed: ${line(a)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return report;
}
