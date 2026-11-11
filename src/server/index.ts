import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
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
import { VERSION } from '../version.js';

const INSTRUCTIONS = `Clast is a pre-built, always-fresh code index for this repository (symbols, call graph, references, imports). Its tools answer in one call what would otherwise take several grep + file-read round trips, and they return exact file:line locations.

Use it first for code navigation:
- Unfamiliar repo or directory -> clast_overview, then clast_file_summary on a directory or file.
- "Where is X defined / what is it called?" -> clast_search (accepts exact names, partial or abbreviated names, Class.method, or plain words describing the behaviour).
- "Show me X" / before editing X -> clast_get_context (returns the source of just that symbol plus its callers and callees; no need to read the whole file).
- "Who calls X / what breaks if I change X?" -> clast_call_graph (callers/callees, depth N) and clast_references (every usage, including non-call uses, types and imports).
- "What implements / extends / overrides X?" -> clast_hierarchy.
- Text that is not a symbol (strings, comments, config keys) -> clast_grep (matches are labelled with the enclosing function).
- Reviewing or finishing a change -> clast_changes (symbols touched by the git diff, their callers, and the tests that exercise them).

Tips: most tools accept several names at once (arrays) - batch lookups instead of calling repeatedly. Symbols can be addressed as name, Container.name, or path/to/file.ext:name. Results marked "?" are name-based guesses. The index updates itself when files change; edits you make are visible immediately.`;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

export async function startServer(): Promise<void> {
  const projectRoot = resolve(
    process.env.CLAST_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  );
  const log = (msg: string): void => {
    console.error(`[clast] ${msg}`);
  };
  log(`v${VERSION} project root: ${projectRoot}`);

  const clast = new Clast(projectRoot);
  const ctx = new ToolContext(clast);
  const watcher = new FileWatcher(clast.indexer, clast.config.watch.debounceMs);
  const commentGen = new CommentGenerator(clast.db, clast.config, ctx.lines);

  const server = new McpServer({ name: 'clast', version: VERSION }, { instructions: INSTRUCTIONS });

  const names = z.union([z.string(), z.array(z.string()).max(20)]);
  const guard = <A>(fn: (args: A) => Promise<string>) => async (args: A) => {
    try {
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
        'Find functions, classes, methods, types and variables in the code index. Ranked: exact name > prefix > camelCase/snake_case word match > substring > fuzzy. The query can be an identifier ("parseConfig"), a partial or abbreviated name ("parseConf", "pcfg"), a qualified name ("Parser.parse"), or plain words describing behaviour ("resolve import path") which are matched against names, signatures and doc comments. Returns kind, qualified name, file:line range, signature and first doc line per hit. Prefer this over grep for locating definitions. Pass an array to run several searches in one call.',
      inputSchema: {
        query: names.describe('Name, partial name, Container.name, or descriptive words. Array = several searches.'),
        kind: z.enum(SYMBOL_KINDS as [string, ...string[]]).optional().describe('Only this kind of symbol'),
        path: z.string().optional().describe('Only symbols in files under / matching this path (e.g. "src/db" or "parser.ts")'),
        lang: z.string().optional().describe('Only this language id (typescript, python, go, ...)'),
        exported: z.boolean().optional().describe('Only exported / public symbols'),
        limit: z.number().int().min(1).max(100).default(15).describe('Max results per query'),
      },
      annotations: READ_ONLY,
    },
    guard(args => search(ctx, args))
  );

  server.registerTool(
    'clast_get_context',
    {
      title: 'Symbol source and context',
      description:
        'Everything needed to understand or edit one symbol, in one call: its exact source (read fresh from disk, with line numbers, including the doc comment), plus who calls it, what it calls, and for classes the member outline, supertypes and subtypes. Use this INSTEAD of reading a whole file when you care about a specific function, method or class. Address symbols as "name", "Class.method" or "path/file.ext:name"; when several definitions share a name the best one is shown and the rest are listed. Pass an array of names to fetch several symbols at once.',
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
        'Callers (who calls this) and/or callees (what this calls) of a function, method or class, as an indented tree with file:line per edge; depth > 1 follows the chain. Use before changing a signature or behaviour to see the blast radius, or to trace a request path. Calls are resolved with declared receiver types, imports, inheritance (a call through an interface or base class counts for the implementation) and this/self; edges marked "?" are name-only matches on an untyped receiver. Also works for names not defined in the project (library functions): it then lists the call sites by name.',
      inputSchema: {
        name: z.string().describe('Symbol name, Container.name, or path:name'),
        path: z.string().optional().describe('Disambiguate by file or directory path'),
        direction: z.enum(['callers', 'callees', 'both']).default('both'),
        depth: z.number().int().min(1).max(6).default(1).describe('Levels to traverse (1 = direct only; 2-3 to follow a chain)'),
        limit: z.number().int().min(1).max(2000).default(50).describe('Max nodes per direction'),
        includeTests: z.boolean().default(true).describe('Include callers / callees located in test files'),
        within: z.string().optional().describe('Only callers located under this path (e.g. "src/server")'),
      },
      annotations: READ_ONLY,
    },
    guard(args => callGraph(ctx, args))
  );

  server.registerTool(
    'clast_hierarchy',
    {
      title: 'Type hierarchy',
      description:
        'Supertypes and subtypes of a class, interface, struct or trait (transitive, as a tree): what it extends/implements and everything that extends/implements it, including Go types that satisfy an interface by method set. Given a method, lists the same method on related types (interface declaration, overrides, implementations). Use for "what implements X", "which classes override Y", "what does Z inherit from".',
      inputSchema: {
        name: z.string().describe('Type or method: name, Container.name, or path:name'),
        path: z.string().optional().describe('Disambiguate by file or directory path'),
        direction: z.enum(['supertypes', 'subtypes', 'both']).default('both'),
        depth: z.number().int().min(1).max(8).default(3).describe('Levels to expand'),
        limit: z.number().int().min(1).max(1000).default(80).describe('Max lines per direction'),
      },
      annotations: READ_ONLY,
    },
    guard(args => hierarchy(ctx, args))
  );

  server.registerTool(
    'clast_references',
    {
      title: 'Find references',
      description:
        'Every place an identifier is used in code (calls, type annotations, imports, assignments), grouped by file, each line shown with its text and the enclosing function/class. Faster and more precise than grep -w: it only matches real identifiers (not substrings, strings or comments) and tells you which symbol each usage sits in. Use for variables, types, fields and constants, or when clast_call_graph is too narrow.',
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
        'Outline of a file: every symbol as an indented tree of signatures with line ranges and doc summaries, plus what the file imports and which files import it. Use INSTEAD of reading a file to learn its structure, then fetch only the symbols you need with clast_get_context. Given a directory, lists its files with their main symbols and sub-directories with sizes. Partial paths are resolved ("queries.ts", "db/queries").',
      inputSchema: {
        path: z.string().describe('File or directory path (relative; partial paths are matched)'),
        members: z
          .enum(['auto', 'all', 'callable'])
          .default('auto')
          .describe('Whether to list fields/properties/constants inside classes (auto hides them in very large files)'),
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
        'Compact map of the repository (or a sub-directory): languages, directory layout with sizes, the most widely referenced classes/functions, hub files that many others import, and entry points. Call this first in an unfamiliar codebase instead of listing directories and opening files.',
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
        'Search the text of indexed source files (literal by default, regex optional, smart-case). Each matching line is labelled with the function/class it is inside, so you can jump straight to clast_get_context. Use for string literals, comments, error messages, config keys and other non-identifier text; for identifiers prefer clast_search / clast_references.',
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
    guard(() => status(ctx, watcher))
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
    guard(args => reindex(ctx, args))
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

  // Connect first so the client never waits on indexing; the index builds
  // (or revalidates) in the background and tools report progress meanwhile.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server running on stdio');

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

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    watcher
      .stop()
      .catch(() => undefined)
      .finally(() => {
        try { clast.close(); } catch { /* already closed */ }
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The client closing stdin is the normal way an MCP server is stopped.
  process.stdin.on('close', shutdown);
}
