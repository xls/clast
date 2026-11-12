<div align="center">

# Clast

### Ask the code. Skip the grep marathon.

A code index for coding agents. One call tells Claude who calls a function, what implements an<br>
interface, what breaks if you change it, and what nobody uses any more.

**Built for Claude Code** &nbsp; | &nbsp; **Works with Codex, Gemini CLI and any MCP client** &nbsp; | &nbsp; **14 languages** &nbsp; | &nbsp; **MIT licensed**

[Install](#install) &nbsp; / &nbsp; [What it does](#made-for-the-questions-grep-cannot-answer) &nbsp; / &nbsp; [Measured results](#measured-not-promised) &nbsp; / &nbsp; [First steps](#your-first-minute) &nbsp; / &nbsp; [Changelog](CHANGELOG.md)

</div>

An agent with only grep finds a name. To follow a call chain, list every subclass or count the
endpoints it has to search, read, and search again. Clast parses your repository with tree-sitter,
keeps a live index of symbols, calls, imports and type relationships, and answers those questions
directly, with exact `file:line` locations. The index follows every edit, so answers are never stale.

## Install

**Claude Code (recommended).** Two commands inside Claude Code, then restart:

```
/plugin marketplace add xls/clast
/plugin install clast@clast
```

The plugin brings the index server, a short skill that teaches Claude which tool answers which
question, and four slash commands:

| Command | What it does |
| --- | --- |
| `/clast:deadcode [path]` | Finds unused functions, methods and types, verifies them, and removes the ones you confirm |
| `/clast:impact <symbol>` | What must change with a symbol, every caller, and the tests to run |
| `/clast:audit [path]` | Inventory for due diligence or onboarding: size, structure, endpoints, database access, dependencies, dead code |
| `/clast:status` | State of the index |

Requires **Node.js 22.22 or newer**. The first start indexes the project in the background (seconds;
about half a minute for 15,000 files). Later starts are ready immediately.

**Codex, Gemini CLI and other agents.** Clast is a standard MCP server, so any agent that speaks MCP
can use it:

```sh
npm install -g clast-ai

codex mcp add clast -- clast-ai          # Codex
gemini mcp add -s user clast clast-ai    # Gemini CLI
```

Then give the agent the usage guide the Claude plugin ships as a skill:

```sh
clast-ai guide >> AGENTS.md              # or GEMINI.md, or your rules file
```

<details>
<summary><strong>Coming from an older install?</strong></summary>

If clast is already set up the old way (`npm install -g clast-ai` plus `claude mcp add`, or through
the old VS Code extension), install the plugin as above and restart. That is all, provided Node.js is
22.22 or newer (0.1 ran on Node 18; check with `node --version`).

The first session after that cleans up in the background, once per plugin version:

- clast servers registered with `claude mcp add`, for all projects or for single ones, are removed
  (the plugin provides the server; with both, every tool would be listed twice),
- entries the old VS Code extension wrote into `.claude/settings.local.json` are removed,
- the v0.1 index file `.clast/clast.db` is deleted (the new index is rebuilt by itself).

Restart Claude Code once more and `/mcp` shows a single `clast` server.

One case is left to you: a project whose `.mcp.json` lists clast. That file is shared with a team, so
it is never changed, and in that project the server stays listed twice until the entry is removed
from the file (`clast-ai migrate` names the file).

Optional: `npm uninstall -g clast-ai` removes the old global package. The plugin does not need it; it
only uses a global install that is at least as new as the plugin itself.

To see what would be removed, or to do it by hand:

```sh
clast-ai migrate           # report only
clast-ai migrate --apply   # remove the leftovers
```

What was removed is logged to `migrate.log` in the plugin's data folder. `CLAST_NO_MIGRATE=1` switches
the automatic clean-up off.

</details>

<details>
<summary><strong>Updating, and how the plugin starts the server</strong></summary>

Update with `/plugin marketplace update clast`, then `/plugin update clast@clast`.

The plugin starts the server from a global `clast-ai` that is at least as new as the plugin, otherwise
through `npx clast-ai@<plugin version>` (downloaded on first use, cached afterwards).

</details>

<details>
<summary><strong>Cursor, VS Code and other editors</strong></summary>

Add the server to the editor's MCP configuration. These follow each editor's documented format; they
have not been tested the way Claude Code, Codex and Gemini CLI have.

Cursor, `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json`):

```json
{ "mcpServers": { "clast": { "command": "clast-ai", "env": { "CLAST_PROJECT_DIR": "${workspaceFolder}" } } } }
```

VS Code, `.vscode/mcp.json`:

```json
{ "servers": { "clast": { "command": "clast-ai", "env": { "CLAST_PROJECT_DIR": "${workspaceFolder}" } } } }
```

Clast indexes the directory in `CLAST_PROJECT_DIR`, else `CLAUDE_PROJECT_DIR`, else the directory the
agent starts it in. Editors do not always start servers in the project, hence the variable above.

</details>

<details>
<summary><strong>Claude Code without the plugin, a team-wide setup, building from source</strong></summary>

**As a plain MCP server** (the tools, without the skill and the slash commands):

```sh
npm install -g clast-ai
claude mcp add -s user clast clast-ai
```

Use the plugin or this, not both: with both, every tool is listed twice.

**For a whole team**, put this in `.mcp.json` in the project root:

```json
{ "mcpServers": { "clast": { "command": "clast-ai" } } }
```

**From source** (also how to work on clast itself):

```sh
git clone https://github.com/xls/clast.git && cd clast
npm install && npm run build
claude --plugin-dir /path/to/clast                          # try the plugin for one session
claude mcp add -s user clast node /path/to/clast/dist/cli.js   # or register the build
```

</details>

## Made for the questions grep cannot answer

### Know what breaks before you change it

Ask about one function and get everything a change touches: the overrides and declarations that must
change with it, every caller with its line, and the tests to run. That includes tests that never name
the function but reach it through its callers.

```
> clast_impact  Context.Render                                   (gin)

method Context.Render  context.go:1201-1215
direct callers: 18 resolved in 1 file (each must be checked when the signature changes):
  context.go: Context.HTML :1222 (x2), Context.IndentedJSON :1235, Context.SecureJSON :1242, ...
indirect callers (through the direct ones, up to depth 3): 5 functions in 2 files
tests to run (11 files: 2 call it directly, 9 reach it through callers):
  context_test.go     direct  (TestContextRenderIfErr, TestContextRenderSSE, +26)
  auth_test.go        via Context.String  (TestBasicAuthSucceed, TestBasicAuth401, +3)
  routes_test.go      via Context.String  (TestRouteQuery, TestRouterMethod, +4)
  ...
```

### Find the code nobody uses

Agents write a lot of code and refactors leave helpers behind. `clast_unused` lists functions, methods
and types that nothing references, and what only that dead code uses, so a removed feature's helpers
are found with it. Code used only by tests and names that still appear in a string, a template or a
config file are listed separately, because those need a look before they go.

```
> clast_unused  path: app                                        (a C++ application)

unused code: 80 symbols, 415 lines in 51 files - the name is never referenced outside
its own definition, or only from other unused code (10594 symbols judged under app)
app/panels/agc_ui.cpp  (6 symbols, 109 lines)
  function reasonText   :12-23    (used only by unused agcGear)
  function ampNow       :42-49    (used only by unused agcStep)
  function agcStep      :79-111   exported
  function agcGear      :126-169  exported
  ...
```

Entry points, routes and tests marked by a decorator or attribute, subclasses of library types and
other things a framework calls for you are left out, and counted so you can see what was skipped.

### Follow the call chain in one step

Calls are resolved with declared types, imports, inheritance and argument counts, so `record.topic()`
goes to the right class and `list.push()` is not mistaken for your `Stack.push`. Ask for depth 2 or 3
and get the chain, not just the next hop. An edge that is only a name match is marked `?`, so the
agent knows what to verify.

```
> clast_call_graph  Engine.handleHTTPRequest  depth: 2           (gin)

callers (2 resolved; depth 2):
  Engine.ServeHTTP  gin.go:701
    Context.FileFromFS  context.go:1352  ?
    RouterGroup.createStaticHandler  routergroup.go:273  ?
  Engine.HandleContext  gin.go:713
```

### Describe it. Clast finds it.

No name to search for? Describe the behaviour. Search covers names, signatures, doc comments and
what function bodies mention, and copes with partial names, abbreviations and typos.

A name that is everywhere is no problem either. One code base here has 1,157 methods called `reset`
and grep returns them all. Ask for "reset viterbi decoder" and clast puts the right one first: it
takes every definition with that name and lets the other words choose, by the class it sits in, its
comment, and what its body calls.

```
> clast_search  "client ip from forwarded headers"               (gin)

method Context.ClientIP  context.go:997-1046
  // ClientIP implements one best effort algorithm to return the real client IP.
method Engine.validateHeader  gin.go:505-524
  // validateHeader will parse X-Forwarded-For header and return the trusted client IP address
```

### Count it exactly

How many endpoints, how many receivers, which models does the database layer touch most? `clast_stats`
returns exact totals grouped by directory, file, kind or name, with production, test and vendored
code kept apart. `/clast:audit` turns that into a due-diligence inventory: size, structure, HTTP
endpoints, database access, dependencies and dead code.

### Read the function, not the file

`clast_get_context` returns exactly the lines of one function or class, read fresh from disk, with
its callers, callees and overrides. The agent spends its context on the code it needs.

### Always current, nothing to maintain

A watcher re-indexes files as they are saved, and every answer re-checks the files it quotes, so line
numbers are right even a second after the agent edited a file. The index is a cache in `.clast/`:
delete it whenever you like. Grammars are WebAssembly and storage is Node's built-in SQLite, so
there is nothing to compile.

**Languages:** TypeScript, TSX, JavaScript, Python, Java, C#, Go, Rust, C, C++, Ruby, PHP, Swift, Dart.

## Measured, not promised

Every figure comes from real headless Claude Code sessions: the same question asked once with clast
and once with only grep and file reads. The rows below are from OnAir (C++, 7.5k files, 1.6M lines);
the vscode results (TypeScript, 15.7k files) are in the full tables.

| Kind of work | Tool calls (clast / grep) | Time | Cost |
| --- | ---: | ---: | ---: |
| Find dead code in a directory | 2 / 16 | 20 s / 124 s | $0.15 / $1.89 |
| Multi-hop questions (call chains, subclasses, impact) | 1.2 / 5.9 | 12.5 s / 25.8 s | $0.056 / $0.212 |
| Code described by behaviour, in a repo the model has not seen | 1.8 / 4.2 | 12.0 s / 20.5 s | $0.068 / $0.197 |
| One of many same-named methods ("which `reset` belongs to the Viterbi decoder") | 1.0 / 3.6 | 11.2 s / 17.4 s | $0.06 / $0.13 (median) |
| Counting ("how many receiver classes") | 1.0 / 3.3 | 11 s / 34 s | about $0.02 / $0.29 |
| Simple lookups (where is X, who calls X) | 1.7 / 1.7 | 12.7 s / 14.3 s | $0.063 / $0.096 |
| Cross-cutting refactors (rename a method, add a parameter everywhere) | 8.3 / 8.3 | 27 s / 26 s | $0.26 / $0.25 |

Both sides answered correctly almost everywhere; the difference is how much searching it took.

**Where it does not help.** Looking up one name is a tie: a current model with ripgrep does that in
one call. Writing code is a tie too: the agent reads the surrounding code before it edits, index or
not. Clast tells the agent to skip it for those edits, so it adds no calls there, only the fixed size of its tool definitions in the prompt. Clast earns its place on questions that take several hops, on counting, and on dead code. The
samples are small (two repositories, three runs per question), so read them as direction.

Full tables, method, answer-quality audits and index speed: [docs/benchmarks.md](docs/benchmarks.md).

## Your first minute

Open a project in Claude Code with the plugin installed, then try these:

1. **Get the lie of the land:** "Give me an overview of this repository."
2. **Trace something:** "Who ends up calling `saveOrder`, two levels up?"
3. **Plan a change:** `/clast:impact OrderService.save`
4. **Clean up:** `/clast:deadcode src/billing`
5. **Take stock:** `/clast:audit`

**Not sure it is running?** `/clast:status` shows the index, and `/mcp` lists the server with 15 tools.

## Reference

<details>
<summary><strong>All 15 tools</strong></summary>

| Tool | Answers |
|------|---------|
| `clast_overview` | What is in this repo or directory? Languages, layout, most referenced symbols, entry points |
| `clast_file_summary` | What is in this file or directory? Outline with signatures, line ranges, imports |
| `clast_search` | Where is X, what is it called? By name, partial name, abbreviation, typo, or a description |
| `clast_get_context` | Show me X: its source plus callers, callees, overloads, overrides, subtypes |
| `clast_call_graph` | Who calls X, what does X call, to depth N |
| `clast_references` | Where is X used at all: calls, types, imports, assignments |
| `clast_hierarchy` | What implements, extends or overrides X? Including Go interfaces by method set |
| `clast_impact` | What must change with X, who reaches it, which tests to run |
| `clast_unused` | What is dead code? |
| `clast_stats` | How many X? Inventory, endpoints, database access, dependencies |
| `clast_grep` | Where does this text appear? Each hit labelled with its function |
| `clast_changes` | What did this git diff touch, and who calls it? |
| `clast_status` | Is the index healthy? |
| `clast_reindex` | Rebuild (rarely needed) |
| `clast_comment` | Doc comment for X, optionally generated by a local model |

All tools return compact plain text: one line per fact, `path:line` locations, and a hint about the
next useful call when something is not found.

**Addressing symbols.** Anywhere a tool takes a name you can write:

| Form | Example |
|------|---------|
| bare name | `parseConfig` |
| member | `Parser.parse`, `Parser::parse`, `Parser#parse` |
| package or module path | `django.shortcuts.render`, `Illuminate\Pipeline\Pipeline` |
| file and name | `src/db/index.ts:open` |
| file and line | `src/db/index.ts:120` (the symbol containing that line) |

When a bare name has many unrelated definitions the tools list them instead of guessing.

</details>

<details>
<summary><strong>Command line</strong></summary>

The same queries work from a shell, for scripts, hooks and debugging:

```sh
clast-ai overview                      # repository map
clast-ai outline src/db                # directory or file outline
clast-ai search "resolve import path"  # ranked symbol search
clast-ai symbol Indexer.indexAll       # source + callers + callees
clast-ai callers resolveImports --depth 2 --no-tests
clast-ai hierarchy Shape
clast-ai refs DEFAULT_CONFIG
clast-ai impact Shape.area             # what must change with it, callers, tests to run
clast-ai unused src/billing            # dead code under a directory (or the whole project)
clast-ai stats endpoints               # exact counts: inventory, symbols, endpoints, database, ...
clast-ai changes main                  # symbols changed vs main and their impact
clast-ai guide                         # the usage guide for agents, as Markdown
clast-ai migrate                       # leftovers of older installs
clast-ai index --force                 # rebuild the index
```

Add `--root <dir>` to point at another project. `clast-ai` with no arguments runs the MCP server.

</details>

<details>
<summary><strong>Configuration and languages</strong></summary>

Optional. Create `clast.config.json` (or `.claude/clast.config.json`) in the project root:

```json
{
  "languages": ["typescript", "python"],
  "ignoredPaths": ["node_modules", "dist", "*.min.js"],
  "respectGitignore": true,
  "maxFileSize": 1000000,
  "workers": 0,
  "watch": { "enabled": true, "debounceMs": 200 },
  "llm": { "endpoint": "http://localhost:11434/v1", "model": "" }
}
```

| Setting | Default | Meaning |
|---------|---------|---------|
| `languages` | all | Language ids to index (see below) |
| `ignoredPaths` | common build / dependency dirs | gitignore-style patterns to skip, in addition to `.gitignore` |
| `respectGitignore` | `true` | Honour `.gitignore` files, including nested ones |
| `dbPath` | `.clast/index.db` | Index location (the directory gets its own `.gitignore`) |
| `maxFileSize` | `1000000` | Skip files larger than this many bytes |
| `workers` | `0` (auto) | Parser threads for bulk indexing; `1` disables workers |
| `watch.enabled` | `true` | Re-index files as they change |
| `watch.debounceMs` | `200` | Debounce for file change events |
| `llm.*` | disabled | OpenAI-compatible endpoint for `clast_comment` (Ollama, LM Studio, vLLM, OpenAI, OpenRouter) |

Environment: `CLAST_PROJECT_DIR` (project root), `CLAST_DB_PATH` (index location), `CLAST_GRAMMARS_DIR`
(alternative grammar directory), `CLAST_NO_MIGRATE=1` (no automatic clean-up), `CLAST_DEBUG=1` (timings).

| Language | id | Extensions |
|----------|----|------------|
| TypeScript | `typescript` (also enables `tsx`) | `.ts`, `.mts`, `.cts`, `.tsx` |
| JavaScript | `javascript` | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `python` | `.py`, `.pyi`, `.pyw` |
| Java | `java` | `.java` |
| C# | `csharp` | `.cs` |
| Go | `go` | `.go` |
| Rust | `rust` | `.rs` |
| C | `c` | `.c`, `.h` (headers that look like C++ are parsed as C++) |
| C++ | `cpp` | `.cpp`, `.hpp`, `.cc`, `.hh`, `.cxx`, `.hxx`, `.inl`, `.ipp` |
| Ruby | `ruby` | `.rb`, `.rake`, `.gemspec` |
| PHP | `php` | `.php` |
| Swift | `swift` | `.swift` |
| Dart | `dart` | `.dart` |

</details>

<details>
<summary><strong>How it works</strong></summary>

1. **Scan.** Walk the tree honouring `.gitignore` and `ignoredPaths`; compare size and modification
   time with the index, so an unchanged file costs one `stat`.
2. **Parse.** Changed files are parsed by a pool of worker threads (tree-sitter WebAssembly). A
   per-language spec turns the syntax tree into symbols, calls (with the receiver and its declared
   type), imports, inheritance and identifier occurrences.
3. **Store.** SQLite (`node:sqlite`, WAL) with a full-text index over names, signatures and docs.
4. **Link at query time.** A call is stored as "symbol A calls name N on receiver R of type T" and
   resolved when asked, so nothing goes stale when another file changes. Resolution uses the declared
   receiver type, then imports and same-file definitions, then `this` / `self` and inheritance, then
   evidence scoring for untyped receivers. Argument counts separate overloads. A call through an
   interface or base type counts as a caller of the implementations it can reach; a call bound to a
   subclass override does not count for the base method.
5. **Stay fresh.** A watcher re-indexes saved files, and every tool re-checks the files it quotes.

The index lives in `.clast/index.db` and takes about 12-25 MB per 1,000 source files. A cold index of
vscode (15.7k files) takes about 26 s; a restart with nothing changed about 2 s; most queries are
under 50 ms.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

- **Untyped receivers**: `obj.save()` in dynamic code cannot be attributed. Such calls are listed as
  "receiver type unknown", not guessed.
- **Dead code is judged by name**: a member whose name is also used by other symbols (`get`, `run`,
  `close`) is never listed, so the list is incomplete for common method names. Calls built from
  strings at run time are only caught when the prefix is a literal (`getattr(x, "as_" + vendor)`).
  Code found by convention (Django `AppConfig` classes inside Django itself) can be listed wrongly.
  Treat the list as candidates and let the compiler or the tests confirm a deletion.
- **Same-named types**: classes with the same short name in different PHP namespaces or Java packages
  can be confused when the calling file gives no hint.
- **Overloads**: those that differ only in parameter types, not count, are one target.
- **Generics and inference**: no generic substitution; TypeScript return types are known only when
  annotated.
- **Framework conventions**: Django managers, Laravel facades and container lookups, and services
  injected by string are not modelled. Endpoint and database statistics are pattern-based.
- **Python**: a local variable that holds a class is not followed.
- **Go**: the module path is inferred from imports, not from go.mod.
- **Ruby, Swift, Dart**: the least exercised languages. Ruby methods defined by metaprogramming are
  invisible; the Swift grammar fails on some files.
- **Search is lexical**: a description that shares no word with the code finds the neighbourhood, not
  always the function.
- **Not indexed**: Kotlin, Scala and other languages without a bundled grammar. `clast_grep` still
  searches those files as text.
- **Prompt cost**: the tool definitions add about 5k tokens to every session.

More detail and examples: [docs/v0.2-summary.md](docs/v0.2-summary.md).

</details>

## Try it. Tell us what you think.

Point clast at a code base you know well and ask it something you already know the answer to. If an
answer is wrong, a language construct is missed, or an agent you use needs something different,
[open an issue](https://github.com/xls/clast/issues). Include the language, the question you asked and
the clast version (`clast-ai --version`).

<details>
<summary><strong>Working on clast</strong></summary>

```sh
npm install
npm run build        # tsc
npm test             # node:test, incl. an end-to-end MCP session
npm run bench -- /path/to/dir-with-repos
```

Adding a language: create `src/parser/langs/<name>.ts` exporting a `LangSpec` (see `typescript.ts` and
`python.ts`), register it in `src/parser/registry.ts`, and add a test under `test/langs/`.
`clast-ai ast <file>` dumps the syntax tree and `clast-ai parse <file>` shows what your spec extracts.
The grammar must be available in `@repomix/tree-sitter-wasms`.

The A/B harness that produced the figures above is `bench/ab.mjs`; the question sets are in `bench/ab/`.

</details>

## License

[MIT](LICENSE). Free to use, modify and share.
