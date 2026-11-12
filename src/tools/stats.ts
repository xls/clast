import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isTestPath, isVendoredPath, plural } from '../query/format.js';
import { directSubtypes } from '../query/hierarchy.js';
import { findSymbols, pathMatches } from '../query/resolve.js';
import type { SymbolRow } from '../types.js';
import { ToolContext } from './context.js';

// ---------------------------------------------------------------------------
// clast_stats: exact counts over the index, for "how many X" questions
// ---------------------------------------------------------------------------

export type StatsWhat = 'inventory' | 'symbols' | 'calls' | 'subtypes' | 'text' | 'imports' | 'endpoints' | 'database';
export type StatsGroup = 'dir' | 'file' | 'kind' | 'lang' | 'name' | 'container' | 'callee' | 'caller' | 'receiver' | 'match';

export interface StatsArgs {
  /** What to count. Default: inventory. */
  what?: StatsWhat;
  /**
   * symbols: name pattern with `*` wildcards (`*Receiver`), alternatives with `|`.
   * calls: called name(s) (`query|execute`). subtypes: the base type. text: a regular expression.
   */
  name?: string;
  /** symbols: only these kinds (comma separated). */
  kind?: string;
  /** calls: only calls whose receiver or receiver type matches this pattern (`*Repository|db|conn`). */
  on?: string;
  path?: string;
  lang?: string;
  groupBy?: StatsGroup;
  /** Directory depth for groupBy=dir. Default 2 (below `path` when given). */
  depth?: number;
  /** Rows per table. Default 25. */
  limit?: number;
  /** Count test / example code too. Default: counted separately, not in the tables. */
  includeTests?: boolean;
}

interface Filters {
  path?: string;
  lang?: string;
  includeTests: boolean;
}

/** `*Foo|Bar*` -> SQL GLOB patterns (case-sensitive, like the names themselves). */
function globs(pattern: string): string[] {
  return pattern.split('|').map(p => p.trim()).filter(Boolean);
}

function globToRegExp(pattern: string): RegExp {
  const alts = globs(pattern).map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
  return new RegExp(`^(?:${alts.join('|')})$`);
}

function dirKey(path: string, depth: number, base?: string): string {
  const parts = path.split('/');
  parts.pop();
  let skip = 0;
  if (base) {
    const b = base.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').split('/');
    if (b.every((seg, i) => parts[i] === seg)) skip = b.length;
  }
  const kept = parts.slice(0, skip + depth);
  return kept.length ? kept.join('/') + '/' : '(root)';
}

class Tally {
  private readonly counts = new Map<string, number>();
  total = 0;
  add(key: string, n = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
    this.total += n;
  }
  get size(): number {
    return this.counts.size;
  }
  top(limit: number): Array<[string, number]> {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit);
  }
  lines(title: string, limit: number, indent = '  '): string[] {
    if (this.size === 0) return [];
    const rows = this.top(limit);
    const width = String(rows[0]![1]).length;
    const out = [`${title} (${this.size}):`];
    for (const [key, n] of rows) out.push(`${indent}${String(n).padStart(width)}  ${key}`);
    if (this.size > rows.length) out.push(`${indent}... ${this.size - rows.length} more (raise limit)`);
    return out;
  }
}

/** Splits production / test / vendored so that headline numbers mean "code this project wrote". */
class Split {
  prod = 0;
  tests = 0;
  vendored = 0;
  private testsShown = false;
  /** Returns true when the item belongs in the main tables. */
  add(path: string, includeTests: boolean, n = 1): boolean {
    if (isVendoredPath(path)) { this.vendored += n; return false; }
    if (isTestPath(path)) { this.tests += n; this.testsShown = includeTests; return includeTests; }
    this.prod += n;
    return true;
  }
  describe(): string {
    const inside = this.testsShown && this.tests ? ` (${this.tests} of them in tests/examples)` : '';
    const extra: string[] = [];
    if (this.tests && !this.testsShown) extra.push(`${this.tests} in tests/examples`);
    if (this.vendored) extra.push(`${this.vendored} in vendored/generated code`);
    return inside + (extra.length ? ` (plus ${extra.join(', ')}; not in the tables below)` : '');
  }
}

function fileOk(path: string, lang: string | null, f: Filters): boolean {
  if (f.path && !pathMatches(path, f.path)) return false;
  if (f.lang && lang !== f.lang) return false;
  return true;
}

// --- symbols ----------------------------------------------------------------

function symbolStats(ctx: ToolContext, args: StatsArgs, f: Filters, limit: number, depth: number): string {
  const where: string[] = [];
  const params: string[] = [];
  if (args.name) {
    const g = globs(args.name);
    where.push('(' + g.map(() => 's.name GLOB ?').join(' OR ') + ')');
    params.push(...g);
  }
  const kinds = (args.kind ?? '').split(',').map(k => k.trim()).filter(Boolean);
  if (kinds.length) {
    where.push('s.kind IN (' + kinds.map(() => '?').join(',') + ')');
    params.push(...kinds);
  }
  const rows = ctx.db.all<{ name: string; qname: string; kind: string; path: string; lang: string }>(
    `SELECT s.name, s.qname, s.kind, f.path, f.lang FROM symbols s JOIN files f ON f.id = s.file_id` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : ''),
    ...params
  );
  const split = new Split();
  const groupBy = args.groupBy ?? 'dir';
  const main = new Tally();
  const byKind = new Tally();
  const names = new Set<string>();
  for (const r of rows) {
    if (!fileOk(r.path, r.lang, f)) continue;
    if (!split.add(r.path, f.includeTests)) continue;
    names.add(r.name);
    byKind.add(r.kind);
    const key =
      groupBy === 'file' ? r.path
      : groupBy === 'kind' ? r.kind
      : groupBy === 'lang' ? r.lang
      : groupBy === 'name' ? r.name
      : groupBy === 'container' ? (r.qname.includes('.') ? r.qname.slice(0, r.qname.lastIndexOf('.')) : '(top level)')
      : dirKey(r.path, depth, f.path);
    main.add(key);
  }
  const what = [args.name ? `named ${args.name}` : '', kinds.length ? `of kind ${kinds.join('/')}` : ''].filter(Boolean).join(' ');
  const out = [
    `${plural(main.total, 'symbol definition')}${what ? ' ' + what : ''}${scopeNote(f)}${split.describe()}`,
    `distinct names: ${names.size}`,
  ];
  if (groupBy !== 'kind') out.push(...byKind.lines('by kind', 12));
  out.push(...main.lines(`by ${groupBy}`, limit));
  return out.join('\n');
}

function scopeNote(f: Filters): string {
  const parts: string[] = [];
  if (f.path) parts.push(`under ${f.path}`);
  if (f.lang) parts.push(`in ${f.lang}`);
  return parts.length ? ' ' + parts.join(' ') : '';
}

// --- calls ------------------------------------------------------------------

function callStats(ctx: ToolContext, args: StatsArgs, f: Filters, limit: number, depth: number): string {
  if (!args.name) return 'error: name is required for what=calls (the called name, e.g. "query|execute" or "find*")';
  const g = globs(args.name);
  const rows = ctx.db.all<{
    name: string; path: string; lang: string; receiver: string | null; rtype: string | null; count: number; caller: string | null;
  }>(
    `SELECT n.name, f.path, f.lang, c.receiver, c.rtype, c.count, s.qname AS caller
       FROM calls c JOIN names n ON n.id = c.name_id JOIN files f ON f.id = c.file_id
       LEFT JOIN symbols s ON s.id = c.caller_id
      WHERE ${g.map(() => 'n.name GLOB ?').join(' OR ')}`,
    ...g
  );
  const on = args.on ? globToRegExp(args.on) : null;
  const split = new Split();
  const groupBy = args.groupBy ?? 'dir';
  const main = new Tally();
  const byCallee = new Tally();
  const byReceiver = new Tally();
  const files = new Set<string>();
  for (const r of rows) {
    if (!fileOk(r.path, r.lang, f)) continue;
    const recv = r.rtype ?? r.receiver ?? '';
    if (on && !on.test(recv) && !(r.receiver && on.test(r.receiver))) continue;
    if (!split.add(r.path, f.includeTests, r.count)) continue;
    files.add(r.path);
    byCallee.add(r.name, r.count);
    byReceiver.add(recv || '(no receiver)', r.count);
    const key =
      groupBy === 'file' ? r.path
      : groupBy === 'lang' ? r.lang
      : groupBy === 'callee' || groupBy === 'name' ? r.name
      : groupBy === 'receiver' ? recv || '(no receiver)'
      : groupBy === 'caller' ? r.caller ?? '(top level)'
      : dirKey(r.path, depth, f.path);
    main.add(key, r.count);
  }
  const out = [
    `${plural(main.total, 'call site')} of ${args.name}${args.on ? ` on ${args.on}` : ''}${scopeNote(f)} in ${plural(files.size, 'file')}${split.describe()}`,
    'counted by called name' + (args.on ? ' and receiver text / declared receiver type' : '') +
      '; use clast_call_graph for the resolved callers of one definition',
  ];
  if (groupBy !== 'callee' && groupBy !== 'name' && byCallee.size > 1) out.push(...byCallee.lines('by called name', 15));
  if (groupBy !== 'receiver' && byReceiver.size > 1) out.push(...byReceiver.lines('by receiver (declared type where known)', 12));
  out.push(...main.lines(`by ${groupBy}`, limit));
  return out.join('\n');
}

// --- subtypes ---------------------------------------------------------------

function subtypeStats(ctx: ToolContext, args: StatsArgs, f: Filters, limit: number, depth: number): string {
  if (!args.name) return 'error: name is required for what=subtypes (the base class or interface)';
  const roots = findSymbols(ctx.db, args.name, { exact: true }).filter(s => /class|interface|struct|trait|protocol|type|enum/.test(s.kind));
  const seen = new Map<number, { sym: SymbolRow; level: number }>();
  let frontier: SymbolRow[] = [];
  let startLevel = 1;
  let root: SymbolRow | null = roots[0] ?? null;
  if (root) {
    frontier = [root];
  } else {
    // A library type (JpaRepository, React.Component): start from the types that name it as a supertype.
    const bare = args.name.split(/[.:\\]/).pop()!;
    const ids = ctx.db.all<{ symbol_id: number }>(`SELECT DISTINCT symbol_id FROM heritage WHERE name = ?`, bare);
    for (const { symbol_id } of ids) {
      const sym = ctx.db.symbolById(symbol_id);
      if (!sym) continue;
      seen.set(sym.id, { sym, level: 1 });
      frontier.push(sym);
    }
    if (frontier.length === 0) return `no type named ${args.name} in the index, and nothing extends or implements it (try clast_search)`;
    startLevel = 2;
  }
  for (let level = startLevel; frontier.length && level <= 40 && seen.size < 20000; level++) {
    const next: SymbolRow[] = [];
    for (const s of frontier) {
      for (const sub of directSubtypes(ctx.db, ctx.resolver, s)) {
        if (sub.sym.id === root?.id || seen.has(sub.sym.id)) continue;
        seen.set(sub.sym.id, { sym: sub.sym, level });
        next.push(sub.sym);
      }
    }
    frontier = next;
  }
  const split = new Split();
  const groupBy = args.groupBy ?? 'dir';
  const main = new Tally();
  const byLevel = new Tally();
  let direct = 0;
  for (const { sym, level } of seen.values()) {
    if (f.path && !pathMatches(sym.path, f.path)) continue;
    if (!split.add(sym.path, f.includeTests)) continue;
    if (level === 1) direct++;
    byLevel.add(level === 1 ? 'direct' : `level ${level}`);
    main.add(groupBy === 'file' ? sym.path : groupBy === 'kind' ? sym.kind : groupBy === 'name' ? sym.qname : dirKey(sym.path, depth, f.path));
  }
  const out = [
    `${plural(main.total, 'subtype')} of ` +
      (root ? `${root.kind} ${root.qname} (${root.path}:${root.start_line})` : `${args.name} (not defined in this project: a library type, matched by name)`) +
      `${scopeNote(f)}: ${direct} direct, ${main.total - direct} indirect${split.describe()}`,
  ];
  if (roots.length > 1) out.push(`note: ${roots.length} types are named ${args.name}; counted the first. Select another with path:name.`);
  if (byLevel.size > 1) out.push(...byLevel.lines('by inheritance level', 10));
  out.push(...main.lines(`by ${groupBy}`, limit));
  if (root) out.push(`(clast_hierarchy ${root.name} lists them as a tree)`);
  else if (main.size <= limit && groupBy !== 'name') out.push('(groupBy=name lists them)');
  return out.join('\n');
}

// --- imports ----------------------------------------------------------------

function importStats(ctx: ToolContext, f: Filters, limit: number): string {
  const rows = ctx.db.all<{ source: string; path: string; lang: string; resolved_id: number | null }>(
    `SELECT i.source, f.path, f.lang, i.resolved_id FROM imports i JOIN files f ON f.id = i.file_id`
  );
  const split = new Split();
  const external = new Map<string, Set<string>>();
  let internal = 0;
  for (const r of rows) {
    if (!fileOk(r.path, r.lang, f)) continue;
    if (!split.add(r.path, f.includeTests)) continue;
    if (r.resolved_id !== null) { internal++; continue; }
    // Package name: `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`, `a.b.c` (Java / Python) -> `a.b`.
    let pkg = r.source.replace(/^<|>$/g, '');
    if (pkg.startsWith('.')) continue;
    if (pkg.startsWith('@')) pkg = pkg.split('/').slice(0, 2).join('/');
    else if (pkg.includes('/')) pkg = /\.(h|hpp|hh)$/.test(pkg) ? pkg.split('/')[0]! : pkg.includes('.') && !pkg.startsWith('node:') ? pkg.split('/').slice(0, 3).join('/') : pkg.split('/')[0]!;
    else if (pkg.includes('::')) pkg = pkg.split('::')[0]!;
    else if (/^[\w$]+(\.[\w$]+){2,}$/.test(pkg)) pkg = pkg.split('.').slice(0, 2).join('.');
    let set = external.get(pkg);
    if (!set) external.set(pkg, (set = new Set()));
    set.add(r.path);
  }
  const tally = new Tally();
  for (const [pkg, files] of external) tally.add(pkg, files.size);
  const out = [
    `imports${scopeNote(f)}: ${internal} resolve to files of this project, ${external.size} distinct external packages / headers${split.describe()}`,
    ...tally.lines('external dependencies by number of importing files', limit),
  ];
  return out.join('\n');
}

// --- text / presets ---------------------------------------------------------

interface Pattern {
  label: string;
  re: RegExp;
  /** Only files in these languages (index language ids). */
  langs?: string[];
  /** Only files whose path matches. */
  file?: RegExp;
  /** Count non-indexed text files too (proto, sql, config). */
  others?: boolean;
  /** Counts files, not text: keep the matched text out of the keyword table. */
  filesOnly?: boolean;
}

interface TextCount {
  byLabel: Tally;
  byDir: Tally;
  byFile: Tally;
  byMatch: Tally;
  split: Split;
  scanned: number;
  timedOut: boolean;
  examples: Map<string, string[]>;
}

async function countText(
  ctx: ToolContext, patterns: Pattern[], f: Filters, depth: number, budgetMs = 25000
): Promise<TextCount> {
  const res: TextCount = {
    byLabel: new Tally(), byDir: new Tally(), byFile: new Tally(), byMatch: new Tally(), split: new Split(),
    scanned: 0, timedOut: false, examples: new Map(),
  };
  const indexed = ctx.db.all<{ path: string; lang: string }>(`SELECT path, lang FROM files ORDER BY path`);
  const work: Array<{ path: string; lang: string | null }> = indexed.filter(x => fileOk(x.path, x.lang, f));
  if (!f.lang && patterns.some(p => p.others)) {
    for (const p of ctx.indexer.rules.otherTextFiles()) if (fileOk(p, null, f)) work.push({ path: p, lang: null });
  }
  const started = performance.now();
  const BATCH = 96;
  for (let i = 0; i < work.length; i += BATCH) {
    if (performance.now() - started > budgetMs) { res.timedOut = true; break; }
    const batch = work.slice(i, i + BATCH).filter(w =>
      patterns.some(p => (w.lang === null ? p.others : !p.langs || p.langs.includes(w.lang)) && (!p.file || p.file.test(w.path)))
    );
    const bufs = await Promise.all(batch.map(w => readFile(join(ctx.clast.root, w.path)).catch(() => null)));
    for (let k = 0; k < batch.length; k++) {
      const buf = bufs[k];
      const w = batch[k]!;
      if (!buf || buf.length > 4_000_000 || buf.subarray(0, 1024).includes(0)) continue;
      res.scanned++;
      const text = buf.toString('utf-8');
      for (const p of patterns) {
        if (w.lang === null ? !p.others : p.langs && !p.langs.includes(w.lang)) continue;
        if (p.file && !p.file.test(w.path)) continue;
        p.re.lastIndex = 0;
        let n = 0;
        let m: RegExpExecArray | null;
        const local = new Map<string, number>();
        while ((m = p.re.exec(text)) !== null) {
          if (m[0].length === 0) { p.re.lastIndex++; continue; }
          n++;
          const shown = (m[1] ?? m[0]).trim().replace(/\s+/g, ' ').slice(0, 60);
          local.set(shown, (local.get(shown) ?? 0) + 1);
        }
        if (n === 0) continue;
        if (!res.split.add(w.path, f.includeTests, n)) continue;
        res.byLabel.add(p.label, n);
        res.byDir.add(dirKey(w.path, depth, f.path), n);
        res.byFile.add(w.path, n);
        if (!p.filesOnly) for (const [key, c] of local) res.byMatch.add(key, c);
        const ex = res.examples.get(p.label) ?? [];
        if (ex.length < 3) { ex.push(w.path); res.examples.set(p.label, ex); }
      }
    }
  }
  return res;
}

async function textStats(ctx: ToolContext, args: StatsArgs, f: Filters, limit: number, depth: number): Promise<string> {
  if (!args.name) return 'error: name is required for what=text (a regular expression)';
  let re: RegExp;
  try {
    re = new RegExp(args.name, /[A-Z]/.test(args.name) ? 'g' : 'gi');
  } catch (err) {
    return `error: invalid regular expression: ${err instanceof Error ? err.message : err}`;
  }
  const res = await countText(ctx, [{ label: 'matches', re, others: true }], f, depth);
  const groupBy = args.groupBy ?? 'dir';
  const main = groupBy === 'file' ? res.byFile : groupBy === 'match' || groupBy === 'name' ? res.byMatch : res.byDir;
  const out = [
    `${plural(res.byLabel.total, 'match')} of /${args.name}/${scopeNote(f)} in ${plural(res.byFile.size, 'file')}` +
      ` (${res.scanned} files read)${res.split.describe()}` + (res.timedOut ? '  INCOMPLETE: time budget hit, narrow with path' : ''),
  ];
  if (groupBy !== 'match' && res.byMatch.size > 1 && res.byMatch.size <= 40) out.push(...res.byMatch.lines('by matched text', 15));
  out.push(...main.lines(`by ${groupBy === 'name' ? 'match' : groupBy}`, limit));
  return out.join('\n');
}

const JS = ['javascript', 'typescript', 'tsx'];

/** Route declarations of the common web frameworks. Pattern-based: a count to start from, not a proof. */
const ENDPOINT_PATTERNS: Pattern[] = [
  // (Not `api.get(...)` / `client.post(...)`: in front-end code those are outbound requests, counted separately.)
  { label: 'Express / Koa / Fastify / Hono route calls', langs: JS, re: /\b(?:app|router|routes?|server|fastify)\.(get|post|put|patch|delete|head|options|all)\(\s*['"`\/]/g },
  { label: 'NestJS / TypeScript route decorators', langs: JS, re: /@(Get|Post|Put|Patch|Delete|All|Head|Options)\(/g },
  { label: 'Spring mappings', langs: ['java', 'kotlin'], re: /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\b/g },
  { label: 'JAX-RS verbs', langs: ['java', 'kotlin'], re: /^\s*@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*$/gm },
  { label: 'ASP.NET attributes', langs: ['csharp'], re: /\[(Http(?:Get|Post|Put|Patch|Delete|Head|Options))\b/g },
  { label: 'ASP.NET minimal API', langs: ['csharp'], re: /\.(Map(?:Get|Post|Put|Patch|Delete))\(/g },
  { label: 'Flask / FastAPI decorators', langs: ['python'], re: /^\s*@[\w.]+\.(get|post|put|patch|delete|route|websocket|api_route)\(/gm },
  { label: 'Django url patterns', langs: ['python'], file: /(^|\/)urls[^/]*\.py$/, re: /\b((?:re_)?path|url)\(\s*r?['"]/g },
  { label: 'Rails routes', langs: ['ruby'], file: /(^|\/)routes(\.rb|\/[^/]+\.rb)$/, re: /^\s*(get|post|put|patch|delete|match|root|resources?)\s+['":]/gm },
  { label: 'Laravel routes', langs: ['php'], re: /Route::(get|post|put|patch|delete|any|match|resource|apiResource)\(/g },
  { label: 'Go router registrations', langs: ['go'], re: /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"/g },
  { label: 'Rust route attributes (actix / rocket)', langs: ['rust'], re: /#\[(get|post|put|patch|delete)\(/g },
  { label: 'Rust axum routes', langs: ['rust'], re: /\.(route)\(\s*"/g },
  { label: 'gRPC methods (.proto)', others: true, file: /\.proto$/, re: /^\s*(rpc)\s+\w+\s*\(/gm },
  { label: 'GraphQL operations (schema files)', others: true, file: /\.(graphql|gql)$/, re: /^\s*(?:extend\s+)?type\s+(Query|Mutation|Subscription)\b/gm },
];

/** Requests this code sends to other services. Reported next to the endpoints, never added to them. */
const CLIENT_PATTERNS: Pattern[] = [
  { label: 'JS HTTP client calls (axios / api client)', langs: JS, re: /\b(?:axios|api|apiClient|client|http|httpClient|\$http|request)\.(get|post|put|patch|delete)\(/g },
  { label: 'fetch()', langs: JS, re: /\b(fetch)\(/g },
  { label: 'Python requests / httpx', langs: ['python'], re: /\b(?:requests|httpx|session|client)\.(get|post|put|patch|delete)\(/g },
  { label: 'Java / C# HTTP clients', langs: ['java', 'kotlin', 'csharp'], re: /\b(RestTemplate|WebClient|HttpClient|OkHttpClient)\b/g },
];

const DB_PATTERNS: Pattern[] = [
  { label: 'SQL statements in source', re: /\b(SELECT)\s[^;'"`]{0,200}?\sFROM\b|\b(?:INSERT\s+INTO|UPDATE\s+[\w."`\[\]]+\s+SET|DELETE\s+FROM)\b/g },
  { label: 'CREATE TABLE statements (schema files and every migration)', others: true, re: /\b(CREATE\s+TABLE)\b/gi },
  { label: 'ORM entities / models', re: /@(Entity|Document|MappedSuperclass)\b|\bclass\s+\w+\((?:[\w.]*\.)?Model\)|\bextends\s+(?:Model|ActiveRecord::Base|ApplicationRecord)\b|<\s*(?:ApplicationRecord|ActiveRecord::Base)\b|\bDbSet<\w+>|\b(?:sequelize\.define|mongoose\.model)\(/g },
  { label: 'Prisma models (schema.prisma)', others: true, file: /\.prisma$/, re: /^\s*(model)\s+\w+\s*\{/gm },
  { label: 'migration files', others: true, file: /(^|\/)migrations?\/.*\.(sql|py|rb|ts|js|php|cs)$/i, re: /^[\s\S]/g, filesOnly: true },
];

const DB_CALLS = 'query|execute|exec|executeQuery|executeUpdate|prepare|prepareStatement|rawQuery|raw|findOne|findMany|findAll|findById|findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|aggregate|groupBy|count|create|createMany|update|upsert|delete|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|$queryRaw|$queryRawUnsafe|$executeRaw|$executeRawUnsafe|$transaction|ExecuteReader|ExecuteNonQuery|ExecuteScalar|SaveChanges|SaveChangesAsync|fetchall|fetchone|executemany|QueryRow|QueryContext|ExecContext';
const DB_RECEIVERS = /^(?:.*(?:db|database|conn|connection|pool|client|session|cursor|cur|tx|trx|transaction|repo|repository|dao|knex|prisma|sequelize|mongo|collection|em|entitymanager|context|dbcontext|stmt|statement).*)$/i;

async function presetStats(
  ctx: ToolContext, title: string, patterns: Pattern[], f: Filters, limit: number, depth: number
): Promise<string[]> {
  const res = await countText(ctx, patterns, f, depth);
  const out = [
    `${title}${scopeNote(f)}: ${res.byLabel.total} found by pattern in ${plural(res.byFile.size, 'file')}${res.split.describe()}` +
      (res.timedOut ? '  INCOMPLETE: time budget hit, narrow with path' : ''),
  ];
  if (res.byLabel.total === 0) return out;
  out.push(`by kind (${res.byLabel.size}):`);
  for (const [label, n] of res.byLabel.top(40)) {
    out.push(`  ${String(n).padStart(6)}  ${label}   e.g. ${(res.examples.get(label) ?? []).slice(0, 2).join(', ')}`);
  }
  if (res.byMatch.size > 1 && res.byMatch.size <= 60) out.push(...res.byMatch.lines('by matched keyword', 20));
  out.push(...res.byDir.lines('by dir', limit));
  out.push(...res.byFile.lines('densest files', Math.min(limit, 10)));
  return out;
}

async function endpointStats(ctx: ToolContext, f: Filters, limit: number, depth: number): Promise<string> {
  const out = await presetStats(ctx, 'HTTP / RPC endpoints', ENDPOINT_PATTERNS, f, limit, depth);
  const clients = await countText(ctx, CLIENT_PATTERNS, f, depth);
  if (clients.byLabel.total) {
    out.push('');
    out.push(
      `outbound HTTP requests (calls this code makes; not endpoints): ${clients.byLabel.total} in ${plural(clients.byFile.size, 'file')}${clients.split.describe()}`
    );
    for (const [label, n] of clients.byLabel.top(10)) out.push(`  ${String(n).padStart(6)}  ${label}`);
    out.push(...clients.byDir.lines('by dir', Math.min(limit, 8)));
  }
  out.push(
    'Pattern-based: counts route declarations of common frameworks (Express, NestJS, Spring, JAX-RS, ASP.NET, Flask, FastAPI, ' +
      'Django, Rails, Laravel, Go routers, actix, axum, gRPC, GraphQL). Routes built in loops or by a custom framework are not ' +
      'seen; count those with what=text or what=calls and your own pattern.'
  );
  return out.join('\n');
}

async function databaseStats(ctx: ToolContext, f: Filters, limit: number, depth: number): Promise<string> {
  const out = await presetStats(ctx, 'database access', DB_PATTERNS, f, limit, depth);
  // Call sites of query-like methods on receivers that look like a database handle.
  const g = globs(DB_CALLS);
  const rows = ctx.db.all<{ name: string; path: string; lang: string; receiver: string | null; rtype: string | null; count: number }>(
    `SELECT n.name, f.path, f.lang, c.receiver, c.rtype, c.count
       FROM calls c JOIN names n ON n.id = c.name_id JOIN files f ON f.id = c.file_id
      WHERE n.name IN (${g.map(() => '?').join(',')})`,
    ...g
  );
  const split = new Split();
  const byName = new Tally();
  const byDir = new Tally();
  const byTarget = new Tally();
  for (const r of rows) {
    if (!fileOk(r.path, r.lang, f)) continue;
    const recv = `${r.rtype ?? ''} ${r.receiver ?? ''}`.trim();
    if (!recv || !recv.split(/[\s.]+/).some(part => DB_RECEIVERS.test(part))) continue;
    if (!split.add(r.path, f.includeTests, r.count)) continue;
    byName.add(r.name, r.count);
    byDir.add(dirKey(r.path, depth, f.path), r.count);
    // `this.prisma.user.findMany()`, `userRepository.save()`: the last receiver segment names the table / model.
    const target = (r.receiver ?? r.rtype ?? '').replace(/^(?:this|self)\./, '').replace(/^@/, '');
    if (target) byTarget.add(target, r.count);
  }
  out.push('');
  out.push(
    `query-method call sites on database-like receivers (db, conn, pool, session, cursor, repository, ...): ${byName.total}${split.describe()}`
  );
  out.push(...byName.lines('by method', 20));
  out.push(...byTarget.lines('by receiver (model / table / handle)', Math.min(limit, 20)));
  out.push(...byDir.lines('by dir', limit));
  out.push(
    'Heuristic: SQL text, schema statements, ORM model declarations, and calls named like query methods on receivers named like ' +
      'a database handle. Treat as an inventory to verify, not an exact count; refine with what=calls name=... on=...'
  );
  return out.join('\n');
}

// --- inventory --------------------------------------------------------------

function inventory(ctx: ToolContext, f: Filters, limit: number, depth: number): string {
  const files = ctx.db.all<{ id: number; path: string; lang: string; line_count: number; symbol_count: number }>(
    `SELECT id, path, lang, line_count, symbol_count FROM files`
  ).filter(x => fileOk(x.path, x.lang, f));
  const groups = { prod: { files: 0, lines: 0 }, tests: { files: 0, lines: 0 }, vendored: { files: 0, lines: 0 } };
  const langFiles = new Tally();
  const langLines = new Tally();
  const dirLines = new Tally();
  const prodIds = new Set<number>();
  const biggest: Array<{ path: string; lines: number }> = [];
  for (const file of files) {
    const g = isVendoredPath(file.path) ? groups.vendored : isTestPath(file.path) ? groups.tests : groups.prod;
    g.files++;
    g.lines += file.line_count;
    if (g !== groups.prod && !(f.includeTests && g === groups.tests)) continue;
    prodIds.add(file.id);
    langFiles.add(file.lang);
    langLines.add(file.lang, file.line_count);
    dirLines.add(dirKey(file.path, depth, f.path), file.line_count);
    biggest.push({ path: file.path, lines: file.line_count });
  }
  const out = [
    `inventory${scopeNote(f)}: ${files.length} indexed source files, ${groups.prod.lines + groups.tests.lines + groups.vendored.lines} lines`,
    `  production: ${groups.prod.files} files, ${groups.prod.lines} lines`,
    `  tests / examples: ${groups.tests.files} files, ${groups.tests.lines} lines`,
    `  vendored / generated: ${groups.vendored.files} files, ${groups.vendored.lines} lines`,
    `The tables below cover production code${f.includeTests ? ' and tests' : ''}.`,
    `by language (${langFiles.size}):`,
  ];
  for (const [lang, lines] of langLines.top(20)) {
    out.push(`  ${lang.padEnd(12)} ${String(langFiles.top(100).find(x => x[0] === lang)?.[1] ?? 0).padStart(6)} files ${String(lines).padStart(9)} lines`);
  }
  out.push(...dirLines.lines('lines by dir', limit));

  const kinds = new Tally();
  const longest: Array<{ qname: string; path: string; line: number; len: number }> = [];
  const members = new Map<number, number>();
  const syms = ctx.db.all<{ id: number; file_id: number; qname: string; kind: string; start_line: number; end_line: number; parent_id: number | null; path: string }>(
    `SELECT s.id, s.file_id, s.qname, s.kind, s.start_line, s.end_line, s.parent_id, f.path FROM symbols s JOIN files f ON f.id = s.file_id`
  );
  const byId = new Map<number, { qname: string; path: string; line: number; kind: string }>();
  for (const s of syms) {
    if (!prodIds.has(s.file_id)) continue;
    kinds.add(s.kind);
    byId.set(s.id, { qname: s.qname, path: s.path, line: s.start_line, kind: s.kind });
    if (s.kind === 'function' || s.kind === 'method') {
      longest.push({ qname: s.qname, path: s.path, line: s.start_line, len: s.end_line - s.start_line + 1 });
      if (s.parent_id !== null) members.set(s.parent_id, (members.get(s.parent_id) ?? 0) + 1);
    }
  }
  out.push(...kinds.lines('symbols by kind', 20));

  const callable = longest.length;
  longest.sort((a, b) => b.len - a.len);
  const over = (n: number): number => longest.filter(x => x.len > n).length;
  out.push(`functions and methods: ${callable}; longer than 50 lines: ${over(50)}, than 100: ${over(100)}, than 300: ${over(300)}`);
  out.push('longest functions:');
  for (const x of longest.slice(0, 8)) out.push(`  ${String(x.len).padStart(6)} lines  ${x.qname}  ${x.path}:${x.line}`);
  biggest.sort((a, b) => b.lines - a.lines);
  out.push('largest files:');
  for (const x of biggest.slice(0, 8)) out.push(`  ${String(x.lines).padStart(6)} lines  ${x.path}`);
  const fat = [...members.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (fat.length) {
    out.push('types with the most methods:');
    for (const [id, n] of fat) {
      const t = byId.get(id);
      if (t) out.push(`  ${String(n).padStart(6)} methods  ${t.kind} ${t.qname}  ${t.path}:${t.line}`);
    }
  }
  out.push(
    'More: what=endpoints (routes), what=database (SQL / ORM / query calls), what=imports (external dependencies), ' +
      'what=symbols name=*Controller, what=subtypes name=BaseClass, what=calls name=..., what=text name=<regex>.'
  );
  return out.join('\n');
}

// --- entry point ------------------------------------------------------------

export async function stats(ctx: ToolContext, args: StatsArgs = {}): Promise<string> {
  const note = await ctx.ready();
  const limit = Math.max(1, Math.min(args.limit ?? 25, 500));
  const depth = Math.max(1, Math.min(args.depth ?? 2, 12));
  const f: Filters = { path: args.path?.trim() || undefined, lang: args.lang?.trim() || undefined, includeTests: args.includeTests ?? false };
  const what = args.what ?? (args.name ? 'symbols' : 'inventory');
  let body: string;
  switch (what) {
    case 'symbols': body = symbolStats(ctx, args, f, limit, depth); break;
    case 'calls': body = callStats(ctx, args, f, limit, depth); break;
    case 'subtypes': body = subtypeStats(ctx, args, f, limit, depth); break;
    case 'text': body = await textStats(ctx, args, f, limit, depth); break;
    case 'imports': body = importStats(ctx, f, limit); break;
    case 'endpoints': body = await endpointStats(ctx, f, limit, depth); break;
    case 'database': body = await databaseStats(ctx, f, limit, depth); break;
    case 'inventory': body = inventory(ctx, f, limit, depth); break;
    default: return `error: unknown what=${String(what)}`;
  }
  return note + body;
}
