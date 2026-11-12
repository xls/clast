import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const clients: Client[] = [];

async function start(): Promise<{ root: string; client: Client }> {
  const root = mkdtempSync(join(tmpdir(), 'clast-optin-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export function hello(): number { return 1; }\n');
  const env = { ...(process.env as Record<string, string>), CLAST_PROJECT_DIR: root };
  delete env.CLAST_ALWAYS;
  delete env.CLAST_DB_PATH;
  const client = new Client({ name: 'clast-optin-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', join(repoRoot, 'src', 'cli.ts')], cwd: repoRoot, env, stderr: 'ignore',
  }));
  clients.push(client);
  return { root, client };
}
const toolNames = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map(t => t.name).sort();
const textOf = (r: unknown): string => (r as { content: Array<{ text?: string }> }).content.map(c => c.text ?? '').join('\n');

after(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('opt-in per project', () => {
  it('stays dormant without a .clast folder: one tool, nothing written', async () => {
    const { root, client } = await start();
    assert.deepEqual(await toolNames(client), ['clast_enable']);
    assert.match(client.getInstructions() ?? '', /off for this project/);
    assert.ok(!existsSync(join(root, '.clast')));
  });

  it('clast_enable creates the folder, builds the index and brings the tools', async () => {
    const { root, client } = await start();
    const out = textOf(await client.callTool({ name: 'clast_enable', arguments: {} }));
    assert.match(out, /clast is on/);
    assert.ok(existsSync(join(root, '.clast')));
    const names = await toolNames(client);
    assert.equal(names.length, 15);
    assert.ok(!names.includes('clast_enable'));
    const found = textOf(await client.callTool({ name: 'clast_search', arguments: { query: 'hello' } }));
    assert.match(found, /function hello {2}src\/a\.ts/);
  });

  it('wakes up when the folder appears by other means', async () => {
    const { root, client } = await start();
    mkdirSync(join(root, '.clast'));
    let names: string[] = [];
    for (let i = 0; i < 40 && names.length < 15; i++) {
      await new Promise(r => setTimeout(r, 250));
      names = await toolNames(client);
    }
    assert.equal(names.length, 15);
  });
});
