// Benchmark: cold index, warm rescan and query latency on real repositories.
//
//   npm run build
//   node bench/bench.mjs <dir-with-repos> [repo-name ...]
//
// Each sub-directory of <dir-with-repos> is treated as one repository. The
// benchmark uses its own database file (.clast/bench.db) so it never touches
// a real index. Output is a Markdown table.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

process.env.CLAST_DB_PATH = '.clast/bench.db';
process.env.UV_THREADPOOL_SIZE ??= '16';

const { Clast } = await import('../dist/engine.js');
const { ToolContext } = await import('../dist/tools/context.js');
const { search, getContext, callGraph } = await import('../dist/tools/search.js');
const { overview, references } = await import('../dist/tools/explore.js');

const base = resolve(process.argv[2] ?? '.bench/repos');
const only = new Set(process.argv.slice(3));
const repos = readdirSync(base).filter(
  name => statSync(join(base, name)).isDirectory() && (only.size === 0 || only.has(name))
);

const ms = n => (n < 10 ? n.toFixed(1) : Math.round(n).toString());

async function time(fn) {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

/** Median of several runs of an async function, in ms. */
async function median(fn, runs = 5) {
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(await time(fn));
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const rows = [];
for (const name of repos) {
  const root = join(base, name);
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(root, '.clast', 'bench.db' + suffix), { force: true });

  let clast = new Clast(root);
  const cold = await clast.indexer.indexAll();
  const stats = clast.db.stats();
  clast.close();

  // Warm start: new process state, nothing changed on disk.
  clast = new Clast(root);
  const warm = await clast.indexer.indexAll();
  const ctx = new ToolContext(clast);

  // Pick a real, well-connected symbol to query: the most called function / method.
  const busiest = clast.db.get(
    `SELECT s.name AS name, s.qname AS qname, COUNT(*) AS n FROM calls c
     JOIN names nm ON nm.id = c.name_id JOIN symbols s ON s.name = nm.name
     WHERE s.kind IN ('function', 'method') AND length(s.name) > 6
     GROUP BY s.name HAVING COUNT(DISTINCT s.id) = 1 ORDER BY n DESC LIMIT 1`
  );
  const target = busiest?.qname ?? 'main';
  const word = busiest?.name ?? 'main';

  const tSearch = await median(() => search(ctx, { query: word }));
  const tText = await median(() => search(ctx, { query: 'parse config file' }));
  const tSymbol = await median(() => getContext(ctx, { name: target }));
  const tCallers = await median(() => callGraph(ctx, { name: target, direction: 'callers', depth: 2 }));
  const tRefs = await median(() => references(ctx, { name: word }));
  const tOverview = await time(() => overview(ctx, {}));

  const dbFile = join(root, '.clast', 'bench.db');
  const dbMb = existsSync(dbFile) ? statSync(dbFile).size / 1e6 : 0;
  clast.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + suffix, { force: true });

  rows.push({
    name, files: stats.files, symbols: stats.symbols, calls: stats.calls,
    cold: cold.durationMs, workers: cold.workers, warm: warm.durationMs, dbMb,
    tSearch, tText, tSymbol, tCallers, tRefs, tOverview, target,
  });
  console.error(`${name}: cold ${cold.durationMs}ms, warm ${warm.durationMs}ms`);
}

rows.sort((a, b) => b.files - a.files);
console.log('| repo | files | symbols | call edges | cold index | warm rescan | db size | search (name) | search (words) | symbol + callers/callees | callers depth 2 | references | overview |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  console.log(
    `| ${r.name} | ${r.files} | ${r.symbols} | ${r.calls} | ${(r.cold / 1000).toFixed(1)} s | ${ms(r.warm)} ms | ` +
      `${r.dbMb.toFixed(0)} MB | ${ms(r.tSearch)} ms | ${ms(r.tText)} ms | ${ms(r.tSymbol)} ms | ${ms(r.tCallers)} ms | ` +
      `${ms(r.tRefs)} ms | ${ms(r.tOverview)} ms |`
  );
}
console.log(`\nNode ${process.version}, ${process.platform} ${process.arch}. Query times are medians of 5 in-process runs on the most-called function of each repo.`);
