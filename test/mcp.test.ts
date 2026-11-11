import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createProject, type Project } from './fixture.js';
import { VERSION } from '../src/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

let project: Project;
let client: Client;

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map(c => c.text ?? '').join('\n');
}

before(async () => {
  project = await createProject();
  // Close our handle: the server process owns the database from here on.
  project.clast.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(repoRoot, 'src', 'cli.ts')],
    cwd: repoRoot,
    env: { ...(process.env as Record<string, string>), CLAST_PROJECT_DIR: project.root },
    stderr: 'ignore',
  });
  client = new Client({ name: 'clast-test', version: '0.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  project?.dispose();
});

describe('MCP server', () => {
  it('reports its version and usage instructions', () => {
    assert.equal(client.getServerVersion()?.name, 'clast');
    assert.equal(client.getServerVersion()?.version, VERSION);
    assert.match(client.getInstructions() ?? '', /clast_search/);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { version: string };
    assert.equal(pkg.version, VERSION, 'src/version.ts must match package.json');
  });

  it('lists all tools with schemas and annotations', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'clast_call_graph', 'clast_changes', 'clast_comment', 'clast_file_summary', 'clast_get_context',
      'clast_grep', 'clast_hierarchy', 'clast_overview', 'clast_references', 'clast_reindex', 'clast_search',
      'clast_status',
    ]);
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 40, `${tool.name} description`);
      assert.equal(tool.inputSchema.type, 'object');
    }
    const searchTool = tools.find(t => t.name === 'clast_search')!;
    assert.equal(searchTool.annotations?.readOnlyHint, true);
    assert.deepEqual(searchTool.inputSchema.required, ['query']);
  });

  it('answers queries end to end', async () => {
    const found = textOf(await client.callTool({ name: 'clast_search', arguments: { query: 'cylinder volume' } }));
    assert.match(found, /function cylinderVolume {2}src\/math\/volume\.ts:4-6/);

    const ctx = textOf(await client.callTool({ name: 'clast_get_context', arguments: { name: ['Circle.area', 'format_row'] } }));
    assert.match(ctx, /method Circle\.area/);
    assert.match(ctx, /function format_row {2}tools\/util\.py:1-3/);

    const graph = textOf(
      await client.callTool({ name: 'clast_call_graph', arguments: { name: 'circleArea', direction: 'callers', depth: 2 } })
    );
    assert.match(graph, /cylinderVolume/);
    assert.match(graph, /main {2}src\/app\.ts/);

    const st = textOf(await client.callTool({ name: 'clast_status', arguments: {} }));
    assert.match(st, /index: 10 files/);
  });

  it('rejects invalid arguments without crashing', async () => {
    const res = await client.callTool({ name: 'clast_search', arguments: { query: 'x', limit: 100000 } }).catch(e => e);
    const failed = res instanceof Error || (res as { isError?: boolean }).isError === true;
    assert.ok(failed, 'out-of-range limit must be rejected');
    const ok = textOf(await client.callTool({ name: 'clast_overview', arguments: {} }));
    assert.match(ok, /languages:/);
  });
});
