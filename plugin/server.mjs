#!/usr/bin/env node
// Starts the clast MCP server for the Claude Code plugin. A plugin is installed by cloning the
// repository, which has no build output, so the server is taken from the first place that has one:
//   1. this checkout, when it has been built (a development clone),
//   2. a global `clast-ai` of the same minor version that is at least as new as the plugin,
//   3. `npx clast-ai@<plugin version>` (downloaded on first use, cached afterwards).
// Standard input and output are passed straight through: they carry the MCP protocol.
//
// After the server is up it also runs `clast-ai migrate --apply --auto` in the background. That
// removes, once per version, what an older install left behind (hand-made MCP registrations that
// would list every tool twice, the v0.1 index file), so installing or upgrading the plugin is
// all a user has to do.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const [major, minor, patch] = version.split('.').map(Number);
const windows = process.platform === 'win32';
// The project the server indexes: the same order the server itself uses.
const projectDir = process.env.CLAST_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const log = msg => process.stderr.write(`[clast plugin] ${msg}\n`);

function pick() {
  const local = join(root, 'dist', 'cli.js');
  if (existsSync(local) && existsSync(join(root, 'node_modules'))) {
    return { command: process.execPath, args: [local], shell: false, what: 'local build' };
  }
  const probe = windows
    ? spawnSync('clast-ai --version', { encoding: 'utf8', shell: true, windowsHide: true })
    : spawnSync('clast-ai', ['--version'], { encoding: 'utf8', windowsHide: true });
  const found = probe.status === 0 ? probe.stdout.trim() : '';
  const [fMajor, fMinor, fPatch] = found.split('.').map(Number);
  if (found && fMajor === major && fMinor === minor && fPatch >= patch) {
    return { command: 'clast-ai', args: [], shell: windows, what: `global clast-ai ${found}` };
  }
  if (found) log(`global clast-ai is ${found}, the plugin is ${version}: using npx instead (npm install -g clast-ai updates it)`);
  // npx runs from a neutral directory: inside a folder whose package.json is itself called clast-ai it
  // would take that folder for the package and start whatever `clast-ai` is on PATH.
  return { command: 'npx', args: ['-y', `clast-ai@${version}`], shell: windows, what: `npx clast-ai@${version}`, cwd: tmpdir() };
}

/** Run the chosen clast-ai with extra arguments. Through a shell (.cmd shims on Windows) the command is one string of fixed words. */
function run(choice, extra, options) {
  const args = [...choice.args, ...extra];
  if (choice.cwd) options = { ...options, cwd: choice.cwd, env: { ...process.env, CLAST_PROJECT_DIR: projectDir } };
  return choice.shell
    ? spawn([choice.command, ...args].join(' '), { ...options, shell: true, windowsHide: true })
    : spawn(choice.command, args, { ...options, windowsHide: true });
}

if (Number(process.versions.node.split('.')[0]) < 22) {
  log(`Node.js 22.22 or newer is required (this is ${process.versions.node}).`);
  process.exit(1);
}
const choice = pick();
log(`starting ${choice.what}`);
const child = run(choice, [], { stdio: 'inherit' });
child.on('error', err => {
  log(`could not start the server: ${err.message}. Install it with: npm install -g clast-ai`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

// Clean up after older installs, without holding up or disturbing the server (no shared stdio).
if (process.env.CLAST_NO_MIGRATE !== '1') {
  try {
    const cleanup = run(choice, ['migrate', '--apply', '--auto'], { stdio: 'ignore', detached: !windows });
    cleanup.on('error', () => {});
    cleanup.unref();
  } catch {
    // Never let the cleanup stop the server.
  }
}
