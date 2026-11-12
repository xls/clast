#!/usr/bin/env node
// More I/O threads: the startup scan stats every source file, which is the
// dominant warm-start cost. Must be set before the first async fs call.
process.env.UV_THREADPOOL_SIZE ??= '16';

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clast } from './engine.js';
import { SourceParser } from './parser/index.js';
import { ToolContext } from './tools/context.js';
import { callGraph, getContext, hierarchy, search } from './tools/search.js';
import { changes, fileSummary, grep, overview, references, reindex, status } from './tools/explore.js';
import { impact, unused } from './tools/impact.js';
import { match } from './tools/match.js';
import { stats, type StatsArgs } from './tools/stats.js';
import { VERSION } from './version.js';

const HELP = `clast-ai ${VERSION} - code index for LLM agents

usage: clast-ai [command] [args] [--root <dir>]

  (no command), serve        run the MCP server on stdio (what Claude Code launches)
  index [--force]            build / update the index
  status                     index statistics
  overview [path]            repository map
  outline <path>             file or directory outline
  search <query...>          ranked symbol search   [--kind k] [--path p] [--lang l] [--limit n]
  symbol <name...>           source + callers + callees of a symbol   [--path p] [--max-lines n] [--no-body]
  callers <name>             who calls it   [--depth n] [--limit n] [--within path] [--no-tests|--tests] [--uncertain]
  callees <name>             what it calls  [--depth n] [--limit n]
  hierarchy <name>           supertypes / subtypes / overrides   [--depth n] [--limit n] [--within path]
  refs <name>                all references to an identifier   [--path p] [--limit n]
  match <code pattern>       code by shape: $X = any one node, $$$X = any arguments or statements,
                             e.g. 'fetch($URL, $$$REST)'   [--lang l] [--path p] [--limit n]
  grep <pattern>             text search with enclosing symbols   [--regex] [--path p] [--limit n]
  changes [base]             symbols touched by the git diff and their impact
  impact <name>              what must change with it, who reaches it, which tests to run   [--depth n] [--limit n]
  unused [path]              dead code   [--kind k] [--lang l] [--limit n] [--no-exported]
  stats [what] [name]        exact counts: inventory | symbols | subtypes | calls | text | imports | endpoints | database
                             [--kind k] [--on receiver] [--path p] [--lang l] [--group-by g] [--depth n] [--limit n] [--tests]
  guide                      print the usage guide for agents (append it to AGENTS.md, GEMINI.md or a rules file)
  migrate [--apply]          find (and with --apply remove) what older installs left behind: duplicate
                             MCP registrations next to the plugin, the v0.1 index file
  parse <file> [--json]      debug: show what the extractor produces for a file
  ast <file>                 debug: dump the tree-sitter syntax tree

Query commands refresh the index incrementally first (skip with --no-scan).`;

const CLI_NAMES: Record<string, string> = {
  clast_search: 'clast-ai search',
  clast_get_context: 'clast-ai symbol',
  clast_call_graph: 'clast-ai callers / callees',
  clast_references: 'clast-ai refs',
  clast_hierarchy: 'clast-ai hierarchy',
  clast_file_summary: 'clast-ai outline',
  clast_overview: 'clast-ai overview',
  clast_grep: 'clast-ai grep',
  clast_match: 'clast-ai match',
  clast_changes: 'clast-ai changes',
  clast_stats: 'clast-ai stats',
  clast_impact: 'clast-ai impact',
  clast_unused: 'clast-ai unused',
  clast_reindex: 'clast-ai index',
  clast_status: 'clast-ai status',
};

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set([
  'force', 'json', 'regex', 'no-body', 'no-scan', 'no-tests', 'tests', 'uncertain', 'help', 'version', 'all', 'no-exported', 'apply', 'auto',
]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (BOOLEAN_FLAGS.has(a.slice(2)) || i + 1 >= argv.length) flags.set(a.slice(2), true);
      else flags.set(a.slice(2), argv[++i]!);
    } else if (a === '-h') flags.set('help', true);
    else positional.push(a);
  }
  return { positional, flags };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined;
  const { positional, flags } = parseArgs(cmd ? argv.slice(1) : argv);
  const str = (k: string): string | undefined => {
    const v = flags.get(k);
    return typeof v === 'string' ? v : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = str(k);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  };

  if (flags.has('version')) return void console.log(VERSION);
  if (flags.has('help') || cmd === 'help') return void console.log(HELP);

  if (cmd === undefined || cmd === 'serve') {
    if (str('root')) process.env.CLAST_PROJECT_DIR = resolve(str('root')!);
    const { startServer } = await import('./server/index.js');
    await startServer();
    return;
  }

  if (cmd === 'guide') {
    // The usage guide the Claude Code plugin ships as a skill, as plain Markdown for agents that take
    // their instructions from a file: `clast-ai guide >> AGENTS.md`.
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'explore', 'SKILL.md');
    const text = readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
    const body = text.replace(/^---\n[\s\S]*?\n---\n+/, '').replace(/\nSlash commands in this plugin:[\s\S]*$/, '\n');
    return void console.log(body.trimEnd());
  }

  if (cmd === 'migrate') {
    const { migrate } = await import('./migrate.js');
    const out = await migrate({ apply: flags.has('apply'), auto: flags.has('auto'), force: flags.has('force'), cwd: str('root') });
    if (out) console.log(out);
    return;
  }

  if (cmd === 'parse' || cmd === 'ast') {
    const file = positional[0];
    if (!file) throw new Error(`usage: clast-ai ${cmd} <file>`);
    const source = readFileSync(file, 'utf-8');
    const parser = new SourceParser();
    if (cmd === 'ast') return void console.log(await parser.dumpTree(file, source));
    const ex = await parser.extract(file, source);
    if (!ex) throw new Error('unsupported file type');
    if (flags.has('json')) return void console.log(JSON.stringify(ex, null, 1));
    for (const s of ex.symbols) {
      console.log(
        `${String(s.startLine).padStart(5)}-${String(s.endLine).padEnd(5)} ${s.kind.padEnd(11)} ${s.qname}` +
          `${s.exported ? ' [exported]' : ''}\n${' '.repeat(12)}sig: ${s.signature}` +
          (s.doc ? `\n${' '.repeat(12)}doc: ${s.doc.split('\n')[0]}` : '')
      );
    }
    console.log(`\ncalls (${ex.calls.length}):`);
    for (const c of ex.calls) {
      const caller = c.caller >= 0 ? ex.symbols[c.caller]!.qname : '<file>';
      console.log(`  ${caller} -> ${c.receiver ? c.receiver + '.' : ''}${c.name} @${c.line}${c.count > 1 ? ' x' + c.count : ''}`);
    }
    console.log(`\nimports (${ex.imports.length}):`);
    for (const i of ex.imports) console.log(`  ${i.source} {${i.names.join(', ')}} @${i.line}`);
    console.log(`\nheritage (${ex.heritage.length}):`);
    for (const h of ex.heritage) console.log(`  ${ex.symbols[h.symbol]!.qname} ${h.kind} ${h.name}`);
    console.log(`\nidentifiers: ${ex.occ.length} distinct, parse errors: ${ex.hadError}`);
    return;
  }

  const root = resolve(str('root') ?? process.env.CLAST_PROJECT_DIR ?? process.cwd());
  const clast = new Clast(root);
  const ctx = new ToolContext(clast);
  try {
    if (cmd === 'index') {
      const target = positional[0];
      if (target) {
        // Convenience: `clast-ai index <dir>` indexes another directory.
        clast.close();
        const other = new Clast(resolve(target));
        const octx = new ToolContext(other);
        console.log(await reindex(octx, { force: flags.has('force') }));
        other.close();
        return;
      }
      console.log(await reindex(ctx, { force: flags.has('force') }));
      return;
    }

    if (!flags.has('no-scan')) await clast.indexer.indexAll();
    const includeTests = flags.has('no-tests') ? false : flags.has('tests') ? true : undefined;
    let out: string;
    switch (cmd) {
      case 'status':
        out = await status(ctx);
        break;
      case 'overview':
      case 'map':
        out = await overview(ctx, { path: positional[0] });
        break;
      case 'outline':
      case 'file':
        out = await fileSummary(ctx, { path: positional[0] ?? '.', members: flags.has('all') ? 'all' : 'auto' });
        break;
      case 'search':
        out = await search(ctx, {
          query: positional.join(' '), kind: str('kind'), path: str('path'), lang: str('lang'), limit: num('limit'),
        });
        break;
      case 'symbol':
      case 'context':
        out = await getContext(ctx, {
          name: positional, path: str('path'), maxLines: num('max-lines'), includeBody: !flags.has('no-body'),
        });
        break;
      case 'callers':
      case 'callees':
      case 'graph':
        out = await callGraph(ctx, {
          name: positional[0] ?? '', path: str('path'),
          direction: cmd === 'graph' ? 'both' : cmd,
          depth: num('depth'), limit: num('limit'), includeTests, within: str('within'), uncertain: flags.has('uncertain'),
        });
        break;
      case 'hierarchy':
      case 'types':
        out = await hierarchy(ctx, {
          name: positional[0] ?? '', path: str('path'), depth: num('depth'), limit: num('limit'), within: str('within'),
          direction: str('direction') as 'supertypes' | 'subtypes' | 'both' | undefined,
        });
        break;
      case 'refs':
      case 'references':
        out = await references(ctx, { name: positional[0] ?? '', path: str('path'), limit: num('limit'), includeTests });
        break;
      case 'match':
        out = await match(ctx, {
          pattern: positional.join(' '), path: str('path'), lang: str('lang'), limit: num('limit'), includeTests,
        });
        break;
      case 'grep':
        out = await grep(ctx, {
          pattern: positional.join(' '), regex: flags.has('regex'), path: str('path'), lang: str('lang'),
          limit: num('limit'), includeTests,
        });
        break;
      case 'changes':
        out = await changes(ctx, { base: positional[0] });
        break;
      case 'impact':
        out = await impact(ctx, { name: positional.join(' '), path: str('path'), depth: num('depth'), limit: num('limit') });
        break;
      case 'unused':
      case 'dead':
        out = await unused(ctx, {
          path: positional[0] ?? str('path'), lang: str('lang'), kind: str('kind'), limit: num('limit'),
          exported: flags.has('no-exported') ? false : undefined,
        });
        break;
      case 'stats':
      case 'count': {
        const WHATS = ['inventory', 'symbols', 'subtypes', 'calls', 'text', 'imports', 'endpoints', 'database'];
        const hasWhat = WHATS.includes(positional[0] ?? '');
        out = await stats(ctx, {
          what: hasWhat ? (positional[0] as StatsArgs['what']) : undefined,
          name: (hasWhat ? positional.slice(1) : positional).join(' ') || undefined,
          kind: str('kind'), on: str('on'), path: str('path'), lang: str('lang'),
          groupBy: str('group-by') as StatsArgs['groupBy'], depth: num('depth'), limit: num('limit'),
          includeTests: includeTests === true,
        });
        break;
      }
      default:
        console.error(`unknown command: ${cmd}\n\n${HELP}`);
        process.exitCode = 1;
        return;
    }
    // Tool hints name MCP tools; say the same thing in CLI terms here.
    console.log(
      out
        .replace(/clast_[a-z_]+/g, t => CLI_NAMES[t] ?? t)
        .replace(/\buncertain=true\b/g, '--uncertain')
        .replace(/\bincludeTests=true\b/g, '--tests')
        .replace(/\braise maxLines\b/g, 'raise --max-lines')
    );
    if (out.startsWith('error:')) process.exitCode = 1;
  } finally {
    try { clast.close(); } catch { /* closed above */ }
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
