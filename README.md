# Clast v0.2

A code index for LLM coding agents, served over MCP. Clast parses your repository with
[tree-sitter](https://tree-sitter.github.io/), keeps a live index of symbols, calls, references, imports and
type relationships in SQLite, and exposes tools that answer navigation questions in one call instead of a
chain of greps and file reads.

What an agent gets:

- **Ranked symbol search** - exact names, partial names, abbreviations (`KProd`, `gcn`), typos, qualified
  names (`Parser.parse`) and plain words (`resolve import path`) matched against names, signatures, docs
  and what function bodies mention.
- **Exact symbol source** - the body of one function or class, read fresh from disk with line numbers,
  together with its callers, callees, overrides and subtypes. No need to read the whole file.
- **Type-aware call graph** - calls are resolved with declared receiver types, imports, inheritance,
  `this`/`self`/`super` and argument counts, so `record.topic()` goes to the right class, an overload
  gets its own callers and `list.push()` is not mistaken for your `Stack.push`. Edges that are name-only
  guesses are marked `?`.
- **References, type hierarchy, repo map, text search, git change impact** - see the tool list below.
- **Always fresh** - a file watcher re-indexes on save, and every query re-checks the files it is about to
  quote, so line numbers and source are never stale, even right after the agent edits a file.
- **Fast** - parallel indexing in worker threads; warm start only stats files; queries take milliseconds.
- **No native compilation** - grammars are WASM, storage is Node's built-in `node:sqlite`.

Languages: TypeScript, TSX, JavaScript, Python, Java, C#, Go, Rust, C, C++, Ruby, PHP, Swift, Dart.

---

## Quick start

Requires **Node.js 22.22 or newer** (Clast uses the built-in SQLite module).

```bash
npm install -g clast-ai
claude mcp add -s user clast clast-ai
```

`-s user` registers the server for all projects. Restart Claude Code (or "Developer: Reload Window" in
VS Code) and run `/mcp`: `clast` should be listed with 13 tools. The first start indexes the project in
the background (seconds, about half a minute for 15k files); until that first index is ready the tools
answer with the build progress and ask to be called again. Later starts are ready immediately.

Other ways to install:

```bash
# from GitHub
npm install -g github:xls/clast

# from a clone
git clone https://github.com/xls/clast.git && cd clast
npm install && npm run build
claude mcp add -s user clast node /path/to/clast/dist/cli.js

# as a Claude Code plugin (bundles a skill that teaches Claude when to use the tools)
claude plugin add /path/to/clast
```

Per-project registration: put this in `.mcp.json` in the project root.

```json
{ "mcpServers": { "clast": { "command": "clast-ai" } } }
```

The project root is `CLAST_PROJECT_DIR`, else `CLAUDE_PROJECT_DIR`, else the working directory.

---

## Tools

| Tool | Answers | Typical use |
|------|---------|-------------|
| `clast_overview` | What is in this repo / directory? | First call in an unfamiliar codebase: languages, layout with sizes, most referenced symbols, hub files, entry points |
| `clast_file_summary` | What is in this file / directory? | Outline of a file (signatures, line ranges, doc summaries, imports, importers) or a directory listing with main symbols |
| `clast_search` | Where is X? What is it called? | Ranked symbol search by name, partial name, abbreviation, typo, qualified name or descriptive words (matched against names, signatures, docs and what function bodies mention) |
| `clast_get_context` | Show me X. | Source of one symbol plus callers, callees, overloads, overrides, subtypes. Batch several names in one call |
| `clast_call_graph` | Who calls X? What does X call? | Caller / callee tree to depth N, test callers separated, `within` path filter. Works for external names too |
| `clast_references` | Where is X used? | Every usage of an identifier (calls, types, imports, assignments) with the enclosing symbol of each line |
| `clast_hierarchy` | What implements / extends / overrides X? | Supertypes and transitive subtypes; Ruby mixins; Go interface satisfaction by method set (names plus parameter / result counts); the same method across related types; `within` path filter |
| `clast_grep` | Where does this text appear? | Literal or regex search over all text files; each hit is labelled with its enclosing function |
| `clast_changes` | What did this diff touch? | Symbols changed vs HEAD or a base ref, their callers outside the change, and the tests that exercise them |
| `clast_stats` | How many X are there? What does this code base consist of? | Exact totals grouped by directory, file, kind or name; inventory, endpoints, database access, dependencies |
| `clast_status` | Is the index healthy? | Counts, languages, indexing progress, watcher state |
| `clast_reindex` | Rebuild | Rarely needed; incremental rescan or forced rebuild |
| `clast_comment` | Docs for X | Existing doc comment, or one generated by a local LLM (optional) |

All tools return compact plain text (not JSON): one line per fact, `path:line` locations that can be
passed straight to an editor, and a hint about the next useful call when something is not found.

### Addressing symbols

Anywhere a tool takes a symbol name you can write:

| Form | Example |
|------|---------|
| bare name | `parseConfig` |
| member | `Parser.parse`, `Parser::parse`, `Parser#parse` |
| inherited member | `Engine.GET` (defined on an embedded / base type) |
| package or module path | `django.shortcuts.render`, `page.Clear`, `Illuminate\Pipeline\Pipeline` |
| file and name | `src/db/index.ts:open` |
| file and line | `src/db/index.ts:120` (the symbol containing that line) |

When a bare name has many unrelated definitions the tools list them instead of guessing.

### Example

```
> clast_get_context { "name": "cylinderVolume" }

function cylinderVolume  src/math/volume.ts:4-6  [exported]
3| /** Volume of a cylinder. */
4| export function cylinderVolume(radius: number, height: number): number {
5|   return circleArea(radius) * height;
6| }
callers (1 resolved):
  main  src/app.ts:10
calls (1):
  circleArea  src/math/area.ts:2-4
```

```
> clast_call_graph { "name": "MemTable.Add", "direction": "callers" }

method leveldb.MemTable.Add  db/memtable.cc:76-100
  void MemTable::Add(SequenceNumber s, ValueType type, const Slice& key, const Slice& value)
callers (3; caller  call-site):
  leveldb.MemTableInserter.Put  db/write_batch.cc:122
  leveldb.MemTableInserter.Delete  db/write_batch.cc:126
  leveldb.MemTableConstructor.FinishImpl  table/table_test.cc:315
```

---

## How Claude knows to use it

The server sends usage instructions to the client when it connects, and every tool description says when
to prefer it over grep or reading files. Installed as a plugin, the bundled `clast-explore` skill adds a
short workflow guide. You can also say it once: "use the clast tools to navigate the code".

---

## Command line

The same queries are available from a shell, which is handy for scripts, hooks and debugging:

```bash
clast-ai overview                      # repository map
clast-ai outline src/db                # directory or file outline
clast-ai search "resolve import path"  # ranked symbol search
clast-ai symbol Indexer.indexAll       # source + callers + callees
clast-ai callers resolveImports --depth 2 --no-tests
clast-ai hierarchy Shape
clast-ai refs DEFAULT_CONFIG
clast-ai grep "TODO" --path src
clast-ai changes main                  # symbols changed vs main and their impact
clast-ai index --force                 # rebuild the index
clast-ai parse file.go                 # debug: what the extractor sees
```

Add `--root <dir>` to point at another project. `clast-ai` with no arguments runs the MCP server.

---

## Configuration

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
| `llm.*` | disabled | OpenAI-compatible endpoint for `clast_comment` generation |

Environment: `CLAST_PROJECT_DIR` (project root), `CLAST_DB_PATH` (index location override),
`CLAST_GRAMMARS_DIR` (alternative grammar directory), `CLAST_DEBUG=1` (timings and spec warnings).

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

### Optional: generated doc comments

`clast_comment` can ask a local or hosted OpenAI-compatible model (Ollama, LM Studio, vLLM, OpenAI,
OpenRouter) to write a doc comment for an undocumented symbol. Set `llm.model` to enable it, for example
`{"llm": {"endpoint": "http://localhost:11434/v1", "model": "qwen2.5-coder:7b"}}` for Ollama. Generated
text is stored by file path and qualified name, so it survives re-indexing.

---

## How it works

1. **Scan** - walk the tree honouring `.gitignore` (root and nested) and `ignoredPaths`; compare size and
   mtime with the index so an unchanged file costs one `stat`.
2. **Parse** - changed files are read, hashed and parsed by a pool of worker threads (tree-sitter WASM).
   A per-language spec turns the syntax tree into symbols (with qualified names, signatures, doc comments,
   line ranges), calls (with receiver text and declared receiver type), imports, inheritance and
   identifier occurrences.
3. **Store** - the main thread writes to SQLite (`node:sqlite`, WAL). A cold index uses a bulk-load mode
   that builds secondary indexes at the end. Symbol names, signatures and docs also go into an FTS5 index.
4. **Link at query time** - call edges are stored as "symbol A calls name N on receiver R of type T" and
   resolved when queried, so nothing goes stale when another file changes. Resolution order: declared
   receiver type, then imports and same-file definitions, then `this`/`self` and inheritance, then
   evidence scoring for untyped receivers. Argument counts separate overloads and rule out same-named
   methods of another shape. A call through an interface or base type counts as a caller of the
   implementations it can reach (Go's structural interfaces as "possible"); a call bound to a subclass
   override does not count for the base method, and `super.m()` binds to the inherited method. Types
   are told apart by more than their name where the language allows it: Go packages (`pkg.Type`
   against the file's imports), imports and packages in TS / Python / Java / PHP, C# generic arity and
   partial classes, Ruby lexical constant lookup, Rust module paths.
5. **Stay fresh** - a watcher re-indexes saved files; in addition every tool re-checks the files it is
   about to quote and re-parses them on the spot if they changed.

The index lives in `.clast/index.db` and is a pure cache: delete it at any time.

### Performance

Measured with `npm run bench` (Node 24, Windows 11, Ryzen 9950X3D, up to 12 parser workers). Cold index is a first run on an
empty index; warm rescan is a restart with nothing changed.

<!-- BENCH:START -->
| repo | files | symbols | cold index | warm rescan | db size | search (name) | search (words) | symbol + callers/callees | callers depth 2 | references |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| vscode | 15726 | 461365 | 26.1 s | 1895 ms | 357 MB | 168 ms | 42 ms | 28 ms | 38 ms | 11 ms |
| aspnetcore | 11470 | 145271 | 10.2 s | 1382 ms | 135 MB | 9.3 ms | 86 ms | 33 ms | 38 ms | 6.6 ms |
| kafka | 6481 | 126393 | 9.5 s | 863 ms | 144 MB | 26 ms | 33 ms | 25 ms | 962 ms | 5.6 ms |
| rails | 3580 | 61549 | 3.8 s | 352 ms | 52 MB | 8.7 ms | 15 ms | 22 ms | 35 ms | 3.0 ms |
| framework | 3180 | 44124 | 3.0 s | 337 ms | 38 MB | 1.4 ms | 46 ms | 23 ms | 23 ms | 2.2 ms |
| django | 2987 | 60131 | 3.1 s | 522 ms | 42 MB | 29 ms | 41 ms | 21 ms | 48 ms | 2.5 ms |
| fastapi | 1224 | 10049 | 0.8 s | 161 ms | 7 MB | 5.0 ms | 17 ms | 5.7 ms | 48 ms | 2.4 ms |
| hugo | 939 | 16896 | 1.1 s | 127 ms | 11 MB | 7.2 ms | 38 ms | 18 ms | 18 ms | 2.4 ms |
| redis | 919 | 35752 | 1.9 s | 103 ms | 23 MB | 5.7 ms | 16 ms | 7.0 ms | 26 ms | 2.2 ms |
| tokio | 816 | 12341 | 1.1 s | 85 ms | 11 MB | 3.9 ms | 17 ms | 2.0 ms | 4.2 ms | 1.4 ms |
| http | 362 | 3947 | 0.7 s | 75 ms | 3 MB | 1.3 ms | 9.6 ms | 3.5 ms | 1.6 ms | 5.3 ms |
| express | 142 | 439 | 0.4 s | 20 ms | 1 MB | 0.4 ms | 1.0 ms | 0.8 ms | 0.5 ms | 1.6 ms |
| leveldb | 133 | 3456 | 0.6 s | 14 ms | 2 MB | 2.2 ms | 15 ms | 3.3 ms | 1.8 ms | 2.5 ms |
| Alamofire | 107 | 4085 | 1.5 s | 23 ms | 4 MB | 2.4 ms | 7.1 ms | 1.5 ms | 530 ms | 1.3 ms |
| ripgrep | 103 | 4496 | 0.6 s | 13 ms | 3 MB | 1.3 ms | 13 ms | 1.3 ms | 1.4 ms | 0.5 ms |
| gin | 99 | 2157 | 0.4 s | 12 ms | 2 MB | 1.5 ms | 7.7 ms | 2.2 ms | 4.3 ms | 0.7 ms |
| spring-petclinic | 50 | 323 | 0.2 s | 11 ms | 1 MB | 0.8 ms | 0.7 ms | 0.6 ms | 0.6 ms | 1.3 ms |

Node v24.7.0, win32 x64. Query times are medians of 5 in-process runs on the most-called function of each repo.
<!-- BENCH:END -->

Worst case measured: `callers IDisposable.dispose` on vscode (10.7k call sites, 4.7k definitions of
`dispose`) takes 5-6 s. Scoped with `within` it is fast.

---

## Clast vs grep + read

Measured with real headless Claude Code sessions (`bench/ab.mjs`): every question runs in its own
fresh session, once with clast connected and once with only Read / Grep / Glob. Two large repositories:
vscode (TypeScript, 15.7k files) and OnAir (C++, 7.5k files, 1.6M lines). The index was fully built
before the first session. Answers are scored against facts verified in the source beforehand; an
implementation task is scored on its diff.

"Cost" is the API-price equivalent that Claude Code reports for the session. It weights fresh input and
output above cached prompt tokens, so it is the closest single number to "tokens that matter".

| Kind of work | Repo | Sessions per arm | Tool calls (clast / grep) | Wall time | Cost per question | Correct |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Multi-hop questions (call chains, transitive subclasses, impact) | vscode | 18 | 1.3 / 3.1 | 16.0 s / 19.8 s | $0.063 / $0.126 | 18 / 18 |
| Multi-hop questions | OnAir | 18 | 1.2 / 5.9 | 12.5 s / 25.8 s | $0.056 / $0.212 | 18 / 18 |
| Simple lookups (where is X, who calls X, what implements X) | vscode | 30 | 1.4 / 1.4 | 13.9 s / 13.9 s | $0.053 / $0.059 | 30 / 29 |
| Simple lookups | OnAir | 30 | 1.7 / 1.7 | 12.7 s / 14.3 s | $0.063 / $0.096 | 30 / 30 |
| Counting ("how many receiver classes under core/") | OnAir | 3 | 1.0 / 3.3 | 11 s / 34 s | about $0.02 / $0.29 | 3 / 2 |
| Small implementation tasks (new provider, new enum value, new subclass) | vscode | 6 | 7.5 / 8.5 | 30 s / 31 s | $0.29 / $0.24 | 6 / 6 |
| Small implementation tasks | OnAir | 6 | 11.5 / 12.8 | 39 s / 40 s | $0.58 / $0.56 | 6 / 6 |

What this says:

- **Multi-hop questions are where clast pays off**: half the cost and 20% less time on vscode, a
  quarter of the cost and half the time on OnAir. One call returns a call chain or a full inheritance
  tree that grep needs three to twelve rounds for, and the agent reads 70-85% less tool output.
- **Simple lookups are a tie.** A current model with ripgrep answers them in one or two calls; clast
  does not make that faster, it only returns a little less text.
- **Counting is faster and exact** with `clast_stats`. With grep the agent tallied matches by hand and
  was off by one in one of three runs.
- **Small implementation tasks showed no benefit.** Both arms made the same edits in the same time; the
  agent mostly reads the neighbouring code with Grep and Read before editing either way. With six
  sessions per arm the cost difference is within noise.
- **Small samples.** Two repositories, three runs per question, questions written by the tool's
  author. The figures show the direction, not a precise ratio.

One result changed the server itself. Claude Code defers MCP tools behind its tool search by default,
and in that state the agent never called clast: 0 of 60 sessions, every question answered with Grep.
The navigation tools now ask the client to keep them loaded, after which the agent used clast in every
question session where it helped. The cost is about 7k tokens of tool definitions in the cached prompt.

Reproduce with `node bench/ab.mjs <repo> bench/ab/<set>.json --runs 3`. The question sets are in
`bench/ab/`.

### Answer quality

Reviewer agents asked deliberately hard questions on 17 real repositories and checked every answer
against the source. Over the last five rounds the share of first answers judged correct rose from
roughly 45-60% to 65-78%, with new questions each round.

Two further audits read the cited source lines for call edges that clast shows as certain (no `?`):

| Repo | Language | Wrong | Checked |
| --- | --- | ---: | ---: |
| kafka | Java | 0 | 57 |
| tokio | Rust | 0 | 17 |
| laravel | PHP | 0 | 19 |
| vscode | TypeScript | 1 | 45 |
| django | Python | 1 | 39 |
| aspnetcore | C# | 1 | 58 |
| hugo | Go | 1 | 19 |
| rails | Ruby | 4 | 18 |

The vscode and aspnetcore errors were fixed afterwards; the django, hugo and rails ones are open (see
Known limitations).

---

## Changelog

### 0.2.0

New tools (7 to 13):

- `clast_references`: every use of a symbol, not just calls.
- `clast_hierarchy`: supertypes, subtypes, implementers and overrides, including Go structural
  interfaces and Ruby mixins.
- `clast_overview`: map of a repository or directory.
- `clast_grep`: text search over all text files with the enclosing symbol on every hit.
- `clast_changes`: symbols touched by a git diff, plus their callers.
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
- 263 tests, plus `bench/bench.mjs`, `bench/resolution.mjs` and the A/B harness `bench/ab.mjs`.
- The navigation tools ask Claude Code to keep them loaded instead of deferring them behind tool
  search; deferred, the agent never called them.

### Upgrading from 0.1

- Node.js 22.22+ is required (was 18).
- The index moved from `.clast/clast.db` (sql.js) to `.clast/index.db` (`node:sqlite`). Nothing is
  migrated: the index is a cache and is rebuilt on first start. The old file is ignored and can be
  deleted.
- A later schema change deletes and rebuilds the index automatically.
- Tool output is compact text instead of JSON.
- `clast_call_graph` defaults to depth 1 and gained `within` and `includeTests`.
- The binary entry point is `dist/cli.js`; `dist/server/index.js` still starts the server for old configs.

---

## Known limitations

- **Untyped receivers**: `obj.save()` in dynamic code cannot be attributed. Such calls are listed as
  "receiver type unknown", not guessed.
- **Same-named types**: classes with the same short name in different PHP namespaces or Java packages
  can be confused when the calling file gives no hint.
- **Ruby**: the least trustworthy language. Classes with very common names (`Base`, `ClassMethods`)
  are matched by short name, so some edges shown as certain are wrong (4 of 18 in the rails audit).
  Methods defined by metaprogramming are invisible.
- **Overloads**: those that differ only in parameter types, not count, are one target.
- **Generics and inference**: no generic substitution; TypeScript return types are known only when
  annotated.
- **Framework conventions**: Django managers, Laravel facades and container lookups, and services
  injected by string are not modelled.
- **Python**: a local variable that holds a class is not followed.
- **Go**: a call through a chain of fields can be attributed to the wrong type; the module path is
  inferred from imports, not from go.mod.
- **Swift**: the grammar fails on some files depending on parse order, which can drop a class while
  keeping its members. Swift and Dart are new and less exercised.
- **Search is lexical**: a description that shares no word with the code finds the neighbourhood, not
  always the function.
- **Not indexed**: Kotlin, Scala and other languages without a bundled grammar. `clast_grep` still
  searches those files as text.
- **Size and cold start**: the index takes about 12-25 MB per 1,000 source files; a cold index of
  vscode takes about 26 s.

The full list with examples is in [docs/v0.2-summary.md](docs/v0.2-summary.md).

---

## Development

```bash
npm install
npm run build        # tsc
npm test             # node:test, 260+ tests incl. an end-to-end MCP session
npm run bench -- /path/to/dir-with-repos
```

Adding a language: create `src/parser/langs/<name>.ts` exporting a `LangSpec` (see `typescript.ts` and
`python.ts` for the two reference implementations), register it in `src/parser/registry.ts`, and add a
test under `test/langs/`. `clast-ai ast <file>` dumps the syntax tree and `clast-ai parse <file>` shows what
your spec extracts. The grammar must be available in `@repomix/tree-sitter-wasms`.

## License

MIT
