import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { Clast } from '../engine.js';
import { FileWatcher } from '../watcher/index.js';
import { CommentGenerator } from '../llm/comment-generator.js';
import { SYMBOL_KINDS } from '../types.js';
import { findSymbols } from '../query/resolve.js';
import { symLine } from '../query/format.js';
import { ToolContext } from '../tools/context.js';
import { callGraph, getContext, hierarchy, search } from '../tools/search.js';
import { changes, fileSummary, grep, overview, references, reindex, status } from '../tools/explore.js';
import { impact, unused } from '../tools/impact.js';
import { stats } from '../tools/stats.js';
import { VERSION } from '../version.js';

const INSTRUCTIONS = `Clast is a code index for this repository. One call answers what takes several grep + read round trips, with exact file:line locations.
- Find code by name, partial name, description of what it does, or a common name plus context ("write socket") -> clast_search.
- Who calls X, what X calls, N levels deep -> clast_call_graph.
- What implements / extends / overrides X -> clast_hierarchy.
- Before changing or deleting X: what changes with it, which tests to run -> clast_impact.
- How many X, size, endpoints, database access, dependencies -> clast_stats (never count search results by hand).
- Dead code -> clast_unused.
Further clast tools load through tool search when needed: clast_get_context (source of one symbol with callers and callees), clast_references, clast_file_summary, clast_overview, clast_grep, clast_changes, clast_status.
For one exact, distinctive name plain Grep is as good. Renaming a distinctive name or changing its signature: no clast, Grep then edit.
Symbols: name, Container.name, or path/to/file.ext:name. "?" marks a name-only match. The index follows file changes, including your own edits.`;

const DORMANT_INSTRUCTIONS =
  'Clast (code index) is installed but off for this project: there is no .clast folder in the project root. Do not mention it. If the user asks to use clast, call clast_enable.';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

// Claude Code defers MCP tools behind its tool search by default. Measured on vscode and OnAir
// (bench/ab.mjs): with the tools deferred the agent answered every question with Grep and never
// called clast (0 of 60 sessions); loaded up front it used clast in 8 of 10. This asks the client
// to keep tools loaded. Only six ask for it: the ones whose description has to be in view for the
// agent to choose them over grep (a count, a call chain, a hierarchy, impact, dead code, search).
// The rest stay behind tool search; that cut the fixed prompt cost by more than half.
const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true } as const;

export async function startServer(): Promise<void> {
  const projectRoot = resolve(
    process.env.CLAST_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  );
  const log = (msg: string): void => {
    console.error(`[clast] ${msg}`);
  };
  log(`v${VERSION} project root: ${projectRoot}`);

  // Opt-in per project. The client starts this process in every project, code or not. It indexes and
  // offers its tools only where a `.clast` folder exists in the project root (`/clast:use` or the
  // `clast_enable` tool creates it; the index lives there). Anywhere else it stays dormant: one small
  // tool, no index, no watcher. CLAST_ALWAYS=1 or an explicit CLAST_DB_PATH switches it on regardless.
  const marker = join(projectRoot, '.clast');
  const wanted = (): boolean => process.env.CLAST_ALWAYS === '1' || !!process.env.CLAST_DB_PATH || existsSync(marker);
  const startActive = wanted();
  const server = new McpServer(
    { name: 'clast', version: VERSION },
    { instructions: startActive ? INSTRUCTIONS : DORMANT_INSTRUCTIONS }
  );
  let active: { clast: Clast; watcher: FileWatcher } | null = null;
  let connected = false;
  let begin: (() => void) | null = null;

  const activate = (): void => {
  if (active) return;
  mkdirSync(marker, { recursive: true });
  const clast = new Clast(projectRoot);
  const ctx = new ToolContext(clast);
  const watcher = new FileWatcher(clast.indexer, clast.config.watch.debounceMs);
  const commentGen = new CommentGenerator(clast.db, clast.config, ctx.lines);
  active = { clast, watcher };

  const names = z.union([z.string(), z.array(z.string()).max(20)]);
  const guard = <A>(fn: (args: A) => Promise<string>, gated = true) => async (args: A) => {
    try {
      if (gated) {
        const building = await ctx.gate();
        if (building) return text(building);
      }
      return text(await fn(args));
    } catch (err) {
      log(`tool error: ${err instanceof Error ? err.stack ?? err.message : err}`);
      return { ...text(`error: ${err instanceof Error ? err.message : String(err)}`), isError: true };
    }
  };

  server.registerTool(
    'clast_search',
    {
      title: 'Search symbols',
      description:
        'Ranked symbol search. Query by exact, partial or abbreviated name ("parseConf", "pcfg"), typo, "Class.method", or plain words describing behaviour (matched against names, signatures, docs and the identifiers used in function bodies). Returns kind, qualified name, file:line, signature and doc summary. Prefer over grep for finding definitions. Array = several searches.',
      inputSchema: {
        query: names.describe('Name, partial name, Container.name, or descriptive words. Array = several searches.'),
        kind: z.enum(SYMBOL_KINDS as [string, ...string[]]).optional().describe('Only this kind of symbol'),
        path: z.string().optional().describe('Only symbols in files under / matching this path (e.g. "src/db" or "parser.ts")'),
        lang: z.string().optional().describe('Only this language id (typescript, python, go, ...)'),
        exported: z.boolean().optional().describe('Only exported / public symbols'),
        limit: z.number().int().min(1).max(100).default(10).describe('Max results per query'),
      },
      annotations: READ_ONLY,
      _meta: ALWAYS_LOAD,
    },
    guard(args => search(ctx, args))
  );

  server.registerTool(
    'clast_get_context',
    {
      title: 'Symbol source and context',
      description:
        'One symbol in one call: its exact source with line numbers plus callers, callees, overloads, overrides and, for classes, members and sub/supertypes. Use INSTEAD of reading a whole file, and before editing a symbol. Address as "name", "Class.method", "path/file.ext:name" or "path/file.ext:<line>". Array = several symbols.',
      inputSchema: {
        name: names.describe('Symbol name, Container.name, or path:name. Array = several symbols.'),
        path: z.string().optional().describe('Disambiguate by file or directory path'),
        includeBody: z.boolean().default(true).describe('Include source code (false = signature + docs only)'),
        maxLines: z.number().int().min(5).max(2000).default(120).describe('Max source lines per symbol; large classes fall back to a member outline'),
        includeCalls: z.boolean().default(true).describe('Include callers and callees'),
      },
      annotations: READ_ONLY,
    },
    guard(args => getContext(ctx, args))
  );

  server.registerTool(
    'clast_call_graph',
    {
      title: 'Call graph',
      description:
        'Callers and/or callees as a tree with file:line per edge; depth > 1 follows the chain. Use for the blast radius before a change (every caller to update) or to trace a path. Resolved by receiver type, imports and inheritance; "?" marks name-only matches. Test callers are summarised. Library names list their call sites.',
      inputSchema: {
        name: z.string().describe('Symbol name, Container.name, or path:name'),
        path: z.string().optional().describe('Disambiguate by file or directory path'),
        direction: z.enum(['callers', 'callees', 'both']).default('both'),
        depth: z.number().int().min(1).max(6).default(1).describe('Levels to traverse (1 = direct only; 2-3 to follow a chain)'),
        limit: z.number().int().min(1).max(2000).default(50).describe('Max nodes per direction'),
        includeTests: z.boolean().optional().describe('true = list test callers in full, false = drop them; default: one summary line naming the test files'),
        within: z.string().optional().describe('Only callers located under this path (e.g. "src/server")'),
        uncertain: z.boolean().default(false).describe('List every unconfirmed caller instead of a short summary'),
      },
      annotations: READ_ONLY,
      _meta: ALWAYS_LOAD,
    },
    guard(args => callGraph(ctx, args))
  );

  server.registerTool(
    'clast_hierarchy',
    {
      title: 'Type hierarchy',
      description:
        'Supertypes and all direct and indirect subtypes of a class, interface, struct or trait as a tree (including Go interface satisfaction). For a method: the same method on related types (declaration, overrides, implementations). Use for "what implements X", "which classes override Y", "which base class do the others extend".',
      inputSchema: {
        name: z.string().describe('Type or method: name, Container.name, or path:name'),
        path: z.string().optional().describe('Disambiguate by file or directory path'),
        direction: z.enum(['supertypes', 'subtypes', 'both']).default('both'),
        depth: z.number().int().min(1).max(8).default(3).describe('Levels to expand'),
        limit: z.number().int().min(1).max(1000).default(80).describe('Max lines per direction'),
        within: z.string().optional().describe('Only subtypes / overrides located under this path'),
      },
      annotations: READ_ONLY,
      _meta: ALWAYS_LOAD,
    },
    guard(args => hierarchy(ctx, args))
  );

  server.registerTool(
    'clast_references',
    {
      title: 'Find references',
      description:
        'Every use of an identifier (calls, type annotations, imports, assignments) grouped by file, each line with its enclosing function/class. Matches real identifiers only, not substrings, strings or comments. Use for variables, types, fields, constants and enum members, or when clast_call_graph is too narrow.',
      inputSchema: {
        name: z.string().describe('Identifier (or Container.name; matching is by the last name segment)'),
        path: z.string().optional().describe('Only references in files under / matching this path'),
        limit: z.number().int().min(1).max(500).default(40).describe('Max reference lines'),
        includeTests: z.boolean().default(true),
      },
      annotations: READ_ONLY,
    },
    guard(args => references(ctx, args))
  );

  server.registerTool(
    'clast_file_summary',
    {
      title: 'File or directory outline',
      description:
        'Outline of a file: symbols as a tree of signatures with line ranges and doc summaries, plus its imports and importers. Use INSTEAD of reading a file to learn its structure. For a directory: its files with main symbols and sub-directories with sizes. Partial paths work ("db/queries").',
      inputSchema: {
        path: z.string().describe('File or directory path (relative; partial paths are matched)'),
        members: z
          .enum(['auto', 'all', 'callable'])
          .default('auto')
          .describe('Whether to list fields/properties/constants inside classes (auto hides them in very large files)'),
        limit: z.number().int().min(20).max(5000).default(300).describe('Max outline lines for a file'),
      },
      annotations: READ_ONLY,
    },
    guard(args => fileSummary(ctx, args))
  );

  server.registerTool(
    'clast_overview',
    {
      title: 'Repository map',
      description:
        'Map of the repository or a sub-directory: languages, layout with sizes, most referenced classes/functions, hub files, entry points. Call first in an unfamiliar codebase.',
      inputSchema: {
        path: z.string().optional().describe('Sub-directory to map (default: whole repository)'),
      },
      annotations: READ_ONLY,
    },
    guard(args => overview(ctx, args))
  );

  server.registerTool(
    'clast_grep',
    {
      title: 'Text search with symbol context',
      description:
        'Text search over all text files (literal or regex, smart-case); each hit is labelled with its enclosing function/class. Use for strings, comments, error messages and config keys; for identifiers prefer clast_search / clast_references.',
      inputSchema: {
        pattern: z.string().describe('Text to find (literal unless regex=true)'),
        regex: z.boolean().default(false).describe('Interpret pattern as a JavaScript regular expression'),
        path: z.string().optional().describe('Only files under / matching this path'),
        lang: z.string().optional().describe('Only this language id'),
        caseSensitive: z.boolean().optional().describe('Default: case-insensitive unless the pattern contains uppercase'),
        limit: z.number().int().min(1).max(500).default(50).describe('Max matching lines'),
        includeTests: z.boolean().default(true),
      },
      annotations: READ_ONLY,
    },
    guard(args => grep(ctx, args))
  );

  server.registerTool(
    'clast_stats',
    {
      title: 'Count and aggregate',
      description:
        'Exact counts for "how many ..." questions, grouped by directory, file, kind or name; do not tally search results by hand. what = inventory (size, languages, production vs tests, symbols by kind, longest functions), symbols (name pattern "*Receiver|*Service" and/or kind), subtypes (direct and indirect subclasses / implementers), calls (call sites of "query|execute", optionally on a receiver), text (regex), imports (external dependencies), endpoints (route declarations of common web frameworks), database (SQL, schema, ORM models, query calls; heuristic).',
      inputSchema: {
        what: z.enum(['inventory', 'symbols', 'subtypes', 'calls', 'text', 'imports', 'endpoints', 'database']).optional()
          .describe('What to count (default inventory, or symbols when name is given)'),
        name: z.string().optional().describe('symbols: name pattern with * and | ; subtypes: base type; calls: called name(s); text: regular expression'),
        kind: z.string().optional().describe('symbols: only these kinds, comma separated (class, interface, function, method, ...)'),
        on: z.string().optional().describe('calls: only on receivers / receiver types matching this pattern'),
        path: z.string().optional().describe('Only files under / matching this path'),
        lang: z.string().optional().describe('Only this language id'),
        groupBy: z.enum(['dir', 'file', 'kind', 'lang', 'name', 'container', 'callee', 'caller', 'receiver', 'match']).optional()
          .describe('Grouping of the main table (default dir)'),
        depth: z.number().int().min(1).max(12).optional().describe('Directory depth for groupBy=dir (default 2)'),
        limit: z.number().int().min(1).max(500).optional().describe('Rows per table (default 25)'),
        includeTests: z.boolean().optional().describe('Include tests/examples in the tables (default: counted separately)'),
      },
      annotations: READ_ONLY,
      _meta: ALWAYS_LOAD,
    },
    guard(args => stats(ctx, args))
  );

  server.registerTool(
    'clast_impact',
    {
      title: 'Impact of changing a symbol',
      description:
        'Before changing a signature, behaviour or deleting a symbol: one answer with the declarations / overrides / implementations that must change together, every direct caller by file and line, how far the change reaches through indirect callers, and the test files to run (those that call it directly or through its callers).',
      inputSchema: {
        name: z.string().describe('Symbol: name, Container.name, or path:name'),
        path: z.string().optional().describe('Disambiguate by file or directory path'),
        depth: z.number().int().min(1).max(6).optional().describe('Caller levels to follow (default 3)'),
        limit: z.number().int().min(1).max(500).optional().describe('Max lines per section (default 30)'),
      },
      annotations: READ_ONLY,
      _meta: ALWAYS_LOAD,
    },
    guard(args => impact(ctx, args))
  );

  server.registerTool(
    'clast_unused',
    {
      title: 'Unused code',
      description:
        'Dead code: functions, methods and types that nothing references (or that only other unused code references), grouped by file with line ranges; plus code used only by tests, and names that only appear in strings or comments. Entry points, decorated / attribute-marked symbols and overrides of library types are left out. Use after a refactor or to clean up a directory.',
      inputSchema: {
        path: z.string().optional().describe('Only judge symbols under / matching this path'),
        lang: z.string().optional().describe('Only this language id'),
        kind: z.string().optional().describe('Kinds to judge, comma separated (default function, method, class, struct, interface, trait, enum, type)'),
        exported: z.boolean().optional().describe('false: leave out exported / public symbols'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max symbols listed (default 60)'),
      },
      annotations: READ_ONLY,
      _meta: ALWAYS_LOAD,
    },
    guard(args => unused(ctx, args))
  );

  server.registerTool(
    'clast_changes',
    {
      title: 'Changed symbols and impact',
      description:
        'Map the current git diff to code structure: which functions/classes were touched (uncommitted changes by default, or relative to a base ref such as "main"), which callers outside the change may be affected, and which test files exercise the changed symbols. Use when reviewing a change, before committing, or to decide which tests to run.',
      inputSchema: {
        base: z.string().optional().describe('Git ref to diff against (default HEAD = uncommitted changes; e.g. "main", "HEAD~3")'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(args => changes(ctx, args))
  );

  server.registerTool(
    'clast_status',
    {
      title: 'Index status',
      description: 'Index statistics and health: files, symbols, languages, whether indexing is in progress, watcher state.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard(() => status(ctx, watcher), false)
  );

  server.registerTool(
    'clast_reindex',
    {
      title: 'Re-index',
      description:
        'Re-scan the repository (incremental: only changed files are re-parsed) or force re-index one file. Rarely needed - the index follows file changes automatically and re-checks files when they are queried. Use force=true to rebuild from scratch.',
      inputSchema: {
        path: z.string().optional().describe('Single file to re-index (default: whole repository)'),
        force: z.boolean().default(false).describe('Re-parse every file even if unchanged'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(args => reindex(ctx, args), false)
  );

  server.registerTool(
    'clast_comment',
    {
      title: 'Get or generate documentation',
      description:
        'Return the documentation comment of a symbol. With generate=true and a local LLM configured (llm.model in clast.config.json), generates and stores a doc comment for undocumented symbols.',
      inputSchema: {
        name: z.string().describe('Symbol name, Container.name, or path:name'),
        generate: z.boolean().default(false).describe('Generate with the configured LLM if no comment exists'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(async ({ name, generate }: { name: string; generate: boolean }) => {
      await ctx.ready();
      const matches = findSymbols(ctx.db, name);
      if (matches.length === 0) return `"${name}": no symbol with this name.`;
      const out: string[] = [];
      for (const sym of matches.slice(0, 5)) {
        out.push(symLine(sym));
        const stored = commentGen.stored(sym);
        if (sym.doc) out.push(sym.doc);
        else if (stored) out.push(`[generated] ${stored}`);
        else if (generate) {
          if (!commentGen.isAvailable) out.push('(no comment; LLM not configured - set llm.model in clast.config.json)');
          else out.push((await commentGen.generate(sym)) ?? '(generation failed; see server log)');
        } else out.push('(no comment)');
      }
      return out.join('\n');
    })
  );

  // The index builds (or revalidates) in the background and tools report progress meanwhile.
  begin = (): void => {
  clast.indexer
    .indexAll()
    .then(r => {
      const s = clast.db.stats();
      log(
        `index ready: scanned ${r.scanned}, parsed ${r.parsed}, removed ${r.removed} in ${r.durationMs}ms ` +
          `(${s.files} files, ${s.symbols} symbols)`
      );
    })
    .catch(err => log(`indexing failed: ${err instanceof Error ? err.stack : err}`))
    .finally(() => {
      if (clast.config.watch.enabled) {
        try {
          watcher.start();
          log('file watcher active');
        } catch (err) {
          log(`watcher failed to start: ${err instanceof Error ? err.message : err}`);
        }
      }
    });

  watcher.on('error', ({ filePath, error }: { filePath: string; error: Error }) => {
    log(`watch error ${filePath}: ${error.message}`);
  });
  };
  if (connected) begin();
  }; // activate

  if (startActive) {
    activate();
  } else {
    log('dormant: no .clast folder in the project root');
    const enableTool = server.registerTool(
      'clast_enable',
      {
        title: 'Turn clast on for this project',
        description:
          'Clast (code index) is off for this project. Call this only when the user asks to use clast: it creates the .clast folder in the project root, builds the index and adds the clast tools.',
        inputSchema: {},
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        try {
          activate();
          enableTool.remove();
          return text(
            `clast is on for ${projectRoot}. The index is building; the clast tools are available now ` +
              `(reconnect the server or restart the session if they do not appear). ` +
              `To turn it off again, delete the .clast folder.\n\n${INSTRUCTIONS}`
          );
        } catch (err) {
          return { ...text(`error: ${err instanceof Error ? err.message : String(err)}`), isError: true };
        }
      }
    );
    // The folder can also appear without the tool (a skill, the CLI, the user): pick that up.
    const poll = setInterval(() => {
      if (active) return void clearInterval(poll);
      if (!existsSync(marker)) return;
      clearInterval(poll);
      try {
        activate();
        enableTool.remove();
        log('.clast folder found: active');
      } catch (err) {
        log(`could not activate: ${err instanceof Error ? err.message : err}`);
      }
    }, 2000);
    poll.unref();
  }

  // Connect first so the client never waits on indexing.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  connected = true;
  log('MCP server running on stdio');
  (begin as (() => void) | null)?.();

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    const live = active;
    if (!live) return void process.exit(0);
    live.watcher
      .stop()
      .catch(() => undefined)
      .finally(() => {
        try { live.clast.close(); } catch { /* already closed */ }
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The client closing stdin is the normal way an MCP server is stopped.
  process.stdin.on('close', shutdown);
}

// Backwards compatibility: configurations written for 0.1.x launch this file
// directly (`node dist/server/index.js`). Keep that working.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  startServer().catch(err => {
    console.error('[clast] Fatal error:', err);
    process.exit(1);
  });
}