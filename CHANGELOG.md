# Changelog

## 0.3.0

- Opt-in per project. The server process still starts in every project, but it indexes and offers
  its tools only where a `.clast` folder exists in the project root. Elsewhere it is dormant: one
  small tool (`clast_enable`), no index, no watcher, nothing written. `/clast:use` (or the tool, or
  `mkdir .clast`) turns it on, also in a running session; deleting the folder turns it off.
  Projects indexed before already have the folder and stay on. `CLAST_ALWAYS=1` restores the old
  behaviour.
- Six tools stay loaded in Claude Code instead of eleven (search, call graph, hierarchy, impact,
  unused, stats); the rest load through tool search. The fixed prompt cost in a project where clast
  is on drops from about 5.3k to about 3.5k tokens per turn, with the same benchmark results.
- Benchmark tables show tokens in and out instead of price.

## 0.2.5

- Search: a common name plus context words ("write socket", "reset viterbi decoder") ranks the
  definitions of that name by what surrounds each one: its container, signature and doc comment,
  the calls and receivers in its body, its path. On kafka, "write socket channel" now puts
  `PlaintextTransportLayer.write` first of 77 definitions called `write` (it was fourth). On OnAir
  such questions take 1.0 call against 3.6 with grep.

## 0.2.4

- The server instructions and the usage skill tell the agent not to use clast for a rename or a
  signature change of a distinctive name (one grep finds every site). In the refactor benchmark the
  clast sessions had made about three extra calls on such tasks; after the change they make none
  (8.3 calls against 8.3 for plain grep on OnAir).
- The usage skills are rewritten as rules only, about 40% smaller.
- Start-up in a very large folder (a home or temp directory): the directory walk blocked the server,
  so the client got no answer to its first request and gave up after 30 seconds. The walk now yields
  every few milliseconds (the server answers in half a second) and stops at 150,000 directories with
  a warning in `clast_status`.

## 0.2.3

- `clast-ai guide` prints the usage guide (the Claude Code plugin's `explore` skill) as Markdown,
  for agents that take their instructions from a file: `clast-ai guide >> AGENTS.md`.
- Checked with other agents: Codex CLI 0.167 starts the server (`codex mcp add clast -- clast-ai`,
  also through `npx`) and calls the tools in a session; Gemini CLI connects to it. Install steps for
  both are in the README.
- README rewritten; the changelog and the full benchmark tables moved to `CHANGELOG.md` and
  `docs/benchmarks.md`.

## 0.2.2

- The clean-up of older installs also finds servers registered as `node .../dist/server/index.js` (how
  the 0.1 README registered a build from source) and reads the configuration from `CLAUDE_CONFIG_DIR`
  when that is set. Both were found by installing the plugin into an empty configuration next to an
  old-style registration.

## 0.2.1

- `clast-ai migrate`: finds and removes what older installs left behind (duplicate MCP registrations
  next to the plugin, entries written by the old VS Code extension, the v0.1 index file). The plugin
  runs it automatically, once per version, at the first session after an install or update.
- The plugin uses a global `clast-ai` only when it is at least as new as the plugin itself, so a
  plugin update is not held back by an older global install.

## 0.2.0

New tools (7 to 13):

- `clast_references`: every use of a symbol, not just calls.
- `clast_hierarchy`: supertypes, subtypes, implementers and overrides, including Go structural
  interfaces and Ruby mixins.
- `clast_overview`: map of a repository or directory.
- `clast_grep`: text search over all text files with the enclosing symbol on every hit.
- `clast_changes`: symbols touched by a git diff, plus their callers.
- `clast_impact`: for one symbol, what has to change with it (declarations, overrides, implementations,
  overloads), every direct caller by file and line, the reach through indirect callers, and the test
  files to run, including tests that only reach it through its callers.
- `clast_unused`: dead code. A name counts as unused when it is never referenced outside its own
  definitions, or only from other unused code (so a deleted feature's helpers are found with it).
  Reported separately: code used only by tests, names that still appear in a string, config or
  template, and (Java, C#, C, C++, Rust) methods whose every call binds to another definition. Left
  out, with counts: entry points, decorated or attribute-marked symbols, subclasses of library types
  and their methods, object-literal members, exported Go methods, C# extension classes.
- `clast_stats`: exact counts grouped by directory, file, kind or name: inventory, symbols by name
  pattern, direct and indirect subtypes, call sites by name and receiver, text matches, external
  dependencies, and pattern-based inventories of HTTP / RPC endpoints and database access.

Call graph:

- Calls are resolved at query time using declared receiver types, imports and aliases, field types
  across files, return types of call chains, inheritance and `super`.
- Edges are shown as certain, uncertain, or `?` (matched by name only).
- Argument counts separate overloads. A bare name means all overloads; `path:line` selects one.
- A call bound to a subclass override no longer counts as a caller of the base method.
- Language rules: Go packages and structural interfaces, Rust `impl Trait for Arc<T>` and std types,
  C# generic arity / partial / static classes, Ruby mixins and bare calls, Java static imports, Python
  submodule calls and imported instances, TypeScript renamed re-exports, C macro bodies, C++ namespace
  functions.

Search:

- Ranked by exact name, prefix, abbreviation, typo and plain words.
- Descriptive queries also match what function bodies mention (marked `[body]`).
- Overloads fold into one hit.

Performance and storage:

- `node:sqlite` on disk (WAL, FTS5) replaces in-memory sql.js.
- Parsing runs in worker threads, with an inline fallback if a worker fails.
- The server connects first and indexes afterwards; on a first build, tools wait for the index.
- A watcher re-indexes changed files, and every tool re-checks the files it quotes.

Other:

- Swift and Dart added (14 languages).
- All dependencies updated (MCP SDK 1.32, web-tree-sitter 0.27).
- 291 tests, plus `bench/bench.mjs`, `bench/resolution.mjs` and the A/B harness `bench/ab.mjs`.
- Installable as a Claude Code plugin from this repository (`/plugin marketplace add xls/clast`,
  `/plugin install clast@clast`): the MCP server, a usage skill, and the slash commands
  `/clast:deadcode`, `/clast:impact`, `/clast:audit` and `/clast:status`. The old VS Code extension
  scaffold that wrote the server into `.claude/settings.local.json` is removed.
- The navigation tools ask Claude Code to keep them loaded instead of deferring them behind tool
  search; deferred, the agent never called them.
- Ruby classes and their ancestors are compared by qualified name (`Rails::Generators::Base` is not
  `ActiveRecord::Base`; `Thor::Group` is not a project class called `Group`).
- C++ functions declared through a head-building macro (`FN(jstring, nativeStart)(args)`) are indexed
  under their real name.
- C / C++ function pointers whose calling convention is a macro (`err_t (MY_CALL* find)(args)`) are
  indexed as a field called `find`, not as a method called `err_t`.

## Upgrading from 0.1

How to upgrade: see [Upgrading from an older install](README.md#coming-from-an-older-install). What changed:

- Node.js 22.22+ is required (was 18).
- The index moved from `.clast/clast.db` (sql.js) to `.clast/index.db` (`node:sqlite`). Nothing is
  migrated: the index is a cache and is rebuilt on first start. The old file is ignored; the plugin
  (or `clast-ai migrate --apply`) deletes it.
- A later schema change deletes and rebuilds the index automatically (the schema is at version 26).
- Tool output is compact text instead of JSON.
- `clast_call_graph` defaults to depth 1 and gained `within` and `includeTests`.
- The binary entry point is `dist/cli.js`; `dist/server/index.js` still starts the server for old configs.
