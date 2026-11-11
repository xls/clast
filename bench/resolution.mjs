// Diagnostic: how well does call resolution do on real repositories?
//
//   npm run build
//   node bench/resolution.mjs <dir-with-repos> [repo-name ...]
//
// For a random sample of call sites per repository it reports how the
// resolver classified them:
//   resolved   - linked to one definition with confidence
//   name-only  - a candidate was found but could not be confirmed ("?")
//   unknown    - a member call on a receiver whose type could not be determined
//   external   - no definition in the project (library / runtime / builtin)

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

process.env.CLAST_DB_PATH = '.clast/bench.db';
process.env.UV_THREADPOOL_SIZE ??= '16';

const { Clast } = await import('../dist/engine.js');
const { Resolver } = await import('../dist/query/resolve.js');

const base = resolve(process.argv[2] ?? '.bench/repos');
const only = new Set(process.argv.slice(3));
const repos = readdirSync(base).filter(
  name => statSync(join(base, name)).isDirectory() && (only.size === 0 || only.has(name))
);
const SAMPLE = 4000;

const rows = [];
for (const name of repos) {
  const root = join(base, name);
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(root, '.clast', 'bench.db' + suffix), { force: true });
  const clast = new Clast(root);
  await clast.indexer.indexAll();
  const db = clast.db;
  const resolver = new Resolver(db);
  const total = db.get(`SELECT COUNT(*) AS n FROM calls`).n;
  const sample = db.all(
    `SELECT c.rowid AS id, n.name, c.file_id, c.caller_id, c.receiver, c.rtype, c.via, f.path, f.lang
     FROM calls c JOIN names n ON n.id = c.name_id JOIN files f ON f.id = c.file_id
     WHERE c.rowid IN (SELECT rowid FROM calls ORDER BY random() LIMIT ?)`,
    SAMPLE
  );
  const count = { resolved: 0, nameOnly: 0, unknown: 0, external: 0 };
  const member = { resolved: 0, nameOnly: 0, unknown: 0, external: 0, n: 0 };
  for (const row of sample) {
    const caller = row.caller_id !== null ? db.symbolById(row.caller_id) ?? null : null;
    const site = { fileId: row.file_id, path: row.path, lang: row.lang, receiver: row.receiver, rtype: row.rtype, via: row.via, caller };
    const res = resolver.resolve(row.name, site);
    let kind;
    if (res.candidates.length) kind = res.confident ? 'resolved' : 'nameOnly';
    else kind = resolver.isOpaqueReceiver(site) && resolver.candidates(row.name).length ? 'unknown' : 'external';
    count[kind]++;
    if (row.receiver) {
      member[kind]++;
      member.n++;
    }
  }
  clast.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(root, '.clast', 'bench.db' + suffix), { force: true });
  rows.push({ name, total, n: sample.length, count, member });
  console.error(`${name}: done`);
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + '%' : '-');
rows.sort((a, b) => b.total - a.total);
console.log('| repo | call edges | resolved | name-only "?" | unknown receiver | external | member calls: resolved / unknown |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  console.log(
    `| ${r.name} | ${r.total} | ${pct(r.count.resolved, r.n)} | ${pct(r.count.nameOnly, r.n)} | ${pct(r.count.unknown, r.n)} | ` +
      `${pct(r.count.external, r.n)} | ${pct(r.member.resolved, r.member.n)} / ${pct(r.member.unknown, r.member.n)} |`
  );
}
console.log(`\nSample: up to ${SAMPLE} random call sites per repository. "external" includes calls into libraries and language builtins, which no index of the project alone can resolve.`);
