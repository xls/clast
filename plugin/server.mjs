#!/usr/bin/env node
// Starts the clast MCP server for the Claude Code plugin. A plugin is installed by cloning the
// repository, which has no build output, so the server is taken from the first place that has one:
//   1. this checkout, when it has been built (a development clone),
//   2. a global `clast-ai` of the same major.minor version,
//   3. `npx clast-ai@<major.minor>` (downloaded on first use, cached afterwards).
// Standard input and output are passed straight through: they carry the MCP protocol.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wanted = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('.').slice(0, 2).join('.');
const windows = process.platform === 'win32';
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
  if (found.startsWith(wanted + '.')) {
    return { command: 'clast-ai', args: [], shell: windows, what: `global clast-ai ${found}` };
  }
  if (found) log(`global clast-ai is ${found}, the plugin needs ${wanted}.x: using npx instead`);
  return { command: 'npx', args: ['-y', `clast-ai@${wanted}`], shell: windows, what: `npx clast-ai@${wanted}` };
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  log(`Node.js 22.22 or newer is required (this is ${process.versions.node}).`);
  process.exit(1);
}
const choice = pick();
log(`starting ${choice.what}`);
// Through a shell (needed for .cmd shims on Windows) the command goes in as one string of fixed words.
const child = choice.shell
  ? spawn([choice.command, ...choice.args].join(' '), { stdio: 'inherit', shell: true, windowsHide: true })
  : spawn(choice.command, choice.args, { stdio: 'inherit', windowsHide: true });
child.on('error', err => {
  log(`could not start the server: ${err.message}. Install it with: npm install -g clast-ai`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
