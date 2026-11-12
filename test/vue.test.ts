import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project } from './fixture.js';
import { callGraph, getContext, search } from '../src/tools/search.js';
import { match } from '../src/tools/match.js';
import { vueScript } from '../src/parser/langs/typescript.js';

const COMPONENT = `<template>
  <button @click="save(item)">{{ label }}</button>
</template>

<script setup lang="ts">
import { formatLabel } from './format';

const props = defineProps<{ item: string }>();

function save(item: string): void {
  console.log(formatLabel(item));
}
</script>

<style scoped>
button { color: red; }
</style>
`;

let p: Project;

before(async () => {
  p = await createProject({
    'src/SaveButton.vue': COMPONENT,
    'src/format.ts': `export function formatLabel(s: string): string { return s.trim(); }\n`,
    'src/Legacy.vue': `<template><div/></template>\n<script>\nexport default {\n  methods: {\n    reload() { return formatAll(); },\n  },\n};\nfunction formatAll() { return 1; }\n</script>\n`,
  });
});
after(() => p.dispose());

describe('Vue single-file components', () => {
  it('keeps only the script blocks, with every line where it was', () => {
    const out = vueScript(COMPONENT);
    assert.equal(out.split('\n').length, COMPONENT.split('\n').length);
    assert.equal(out.length, COMPONENT.length);
    assert.ok(!out.includes('button'));
    assert.ok(!out.includes('color'));
    assert.equal(out.split('\n')[9], 'function save(item: string): void {');
  });

  it('indexes the script with line numbers of the .vue file', async () => {
    const found = await search(p.ctx, { query: 'save' });
    assert.match(found, /function save {2}src\/SaveButton\.vue:10-12/);
    const ctx = await getContext(p.ctx, { name: 'save' });
    assert.match(ctx, /10\| function save\(item: string\): void \{/);
  });

  it('links calls from a component into TypeScript files', async () => {
    const graph = await callGraph(p.ctx, { name: 'formatLabel', direction: 'callers' });
    assert.match(graph, /save {2}src\/SaveButton\.vue:11/);
  });

  it('reads a plain JavaScript script block', async () => {
    const graph = await callGraph(p.ctx, { name: 'formatAll', direction: 'callers' });
    assert.match(graph, /reload {2}src\/Legacy\.vue:5/);
  });

  it('is searched by shape like any other file', async () => {
    const out = await match(p.ctx, { pattern: 'console.log($X)' });
    assert.match(out, /SaveButton\.vue/);
  });
});
