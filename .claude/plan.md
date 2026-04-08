# Clast — AST Code Intelligence Plugin for Claude Code

## Context

Build a Claude Code plugin that creates and maintains a live AST database for any repository. It parses code using tree-sitter, extracts symbols/comments/call graphs, watches for changes, and exposes MCP tools so Claude can query code structure instead of reading raw files. Optionally uses a local LLM to generate missing function descriptions.

**Key user requirements:**
- Comment priority: read existing comments first; LLM generates only when no comment exists (configurable to always use LLM)
- AST database stored per-project (`.clast/` in project root) so multi-repo workflows each get their own DB
- Cross-platform: Windows, macOS, Linux
- Deployable to Git + registerable as a public Claude Code plugin (both CLI and Desktop)
- Runtime: TypeScript + Node.js
- LLM: OpenAI-compatible API (optional, disabled by default)

---

## Project Structure

```
D:\Development\Clast\
├── .claude-plugin/
│   └── plugin.json                   # Plugin marketplace metadata
├── .mcp.json                         # MCP server config for Claude Code
├── package.json
├── tsconfig.json
├── .gitignore
├── LICENSE                           # MIT
├── README.md
├── src/
│   ├── server/
│   │   ├── index.ts                  # Entry: McpServer + stdio transport
│   │   ├── register-tools.ts         # Wire all tools
│   │   └── tools/
│   │       ├── clast-search.ts
│   │       ├── clast-call-graph.ts
│   │       ├── clast-file-summary.ts
│   │       ├── clast-get-context.ts
│   │       ├── clast-status.ts
│   │       ├── clast-reindex.ts
│   │       └── clast-comment.ts
│   ├── parser/
│   │   ├── index.ts                  # ParserManager: tree-sitter instances
│   │   ├── languages.ts              # Extension → grammar mapping
│   │   ├── extractor.ts              # CST → AstNode[] extraction
│   │   └── call-resolver.ts          # Call graph edge extraction + resolution
│   ├── db/
│   │   ├── index.ts                  # Database class (better-sqlite3 wrapper)
│   │   ├── schema.ts                 # CREATE TABLE + migrations
│   │   ├── queries.ts                # Prepared statement wrappers
│   │   └── types.ts                  # Row types
│   ├── watcher/
│   │   ├── index.ts                  # Chokidar file watcher + debounce
│   │   └── gitignore.ts              # .gitignore → ignore patterns
│   ├── llm/
│   │   ├── index.ts                  # OpenAI-compatible API client
│   │   ├── comment-generator.ts      # Orchestration + batch processing
│   │   └── prompts.ts                # Prompt templates per language
│   ├── config/
│   │   ├── index.ts                  # Config loader + Zod validation
│   │   └── defaults.ts               # Default values
│   └── types.ts                      # Shared types: AstNode, CallEdge, etc.
├── skills/
│   └── clast-explore/
│       └── SKILL.md                  # Model-invoked: suggests clast tools
├── commands/
│   └── clast-status.md               # /clast-status slash command
└── test/
    ├── parser/
    ├── db/
    ├── watcher/
    ├── tools/
    └── fixtures/                     # Sample files in multiple languages
```

---

## Phase 1: Scaffolding

**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `src/types.ts`, `src/config/`

- **package.json**: `bin` → `dist/server/index.js`, scripts: `build` (tsc), `start`, `dev` (tsx), `test` (vitest)
- Dependencies: `@modelcontextprotocol/sdk`, `tree-sitter`, 10 language grammars, `better-sqlite3`, `chokidar`, `zod`
- DevDeps: `typescript`, `@types/node`, `@types/better-sqlite3`, `tsx`, `vitest`
- **Shared types**: `AstNode`, `CallEdge`, `FileInfo`, `CommentInfo` (with `source: 'original' | 'generated'`)
- **Config** (`clast.config.json` in project root or `.claude/clast.config.json`):
  - `languages`: string[] (all 10 by default)
  - `ignoredPaths`: `['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', '.clast']`
  - `dbPath`: `.clast/clast.db` (relative to project root)
  - `llm.endpoint`: `http://localhost:11434/v1` (default)
  - `llm.model`: `""` (empty = disabled)
  - `llm.apiKey`: `""`
  - `llm.alwaysGenerate`: `false` (when true, LLM generates description even if comment exists)
  - `watch.debounceMs`: 300
  - `watch.enabled`: true

---

## Phase 2: Database Layer

**Files:** `src/db/schema.ts`, `src/db/queries.ts`, `src/db/types.ts`, `src/db/index.ts`

**Tables:**
- `files` — `file_path` PK, `hash` (SHA-256), `language`, `last_indexed`, `node_count`
- `ast_nodes` — `id` auto PK, `file_path` FK, `name`, `type`, `signature`, lines/cols, `parent_id`, `language`, `body_text`
- `call_edges` — `caller_id` FK, `callee_id` FK (nullable), `callee_name`, `file_path`, `line`
- `comments` — `node_id` FK, `text`, `source` ('original'|'generated'), `generated_at`
- `_clast_meta` — migration version tracking

SQLite WAL mode + foreign keys enabled. Bulk inserts use transactions. Recursive CTEs for call graph traversal (callers/callees with configurable depth).

**Key queries:** `searchNodes`, `getNodesByFile`, `getCallersOf`/`getCalleesOf` (recursive CTE), `getNodeWithContext` (node + comments + callers + callees), `getStatus`.

DB path: `{projectRoot}/.clast/clast.db` — each repo gets its own database. Claude working across repos sees separate AST stores per project.

---

## Phase 3: Parser Layer

**Files:** `src/parser/languages.ts`, `src/parser/extractor.ts`, `src/parser/call-resolver.ts`, `src/parser/index.ts`

- **Languages**: TS/TSX, JS/JSX, Python, Java, C#, Go, Rust, C/C++, Ruby, PHP — lazy-loaded grammars
- **Extractor**: Walk tree-sitter CST, extract functions, methods, classes, interfaces, enums, imports, exports, type aliases. Extract `signature` (up to opening brace), `bodyText` (capped 2000 chars)
- **Comment extraction priority**:
  1. Look for `comment` nodes immediately preceding a function/class (within 2 lines)
  2. For Python: first `expression_statement > string` child (docstring)
  3. Store as `source: 'original'`
  4. If no comment found AND LLM configured AND (`alwaysGenerate` OR no existing comment) → mark for LLM generation (deferred to Phase 5)
- **Call resolver**: Second pass after all files parsed. Extract `call_expression` nodes, resolve callee by name against DB (same file → imports → global fallback). Unresolved edges stored with `callee_id = null`

Uses **path.posix** for all stored paths (normalized forward slashes) for cross-platform consistency.

---

## Phase 4: File Watcher

**Files:** `src/watcher/index.ts`, `src/watcher/gitignore.ts`

- Chokidar watches project root, filtered to supported extensions
- Respects `.gitignore` + `config.ignoredPaths`
- Debounced per-file (300ms default)
- `add`/`change`: hash → compare → re-parse if different
- `unlink`: cascade delete from DB
- Cross-platform: chokidar handles FSEvents (macOS), inotify (Linux), ReadDirectoryChangesW (Windows)

---

## Phase 5: LLM Comment Generation (Optional)

**Files:** `src/llm/index.ts`, `src/llm/comment-generator.ts`, `src/llm/prompts.ts`

- **Disabled by default** (`llm.model` empty)
- Generic OpenAI-compatible client (works with Ollama, LM Studio, vLLM, etc.)
- **Comment priority logic**:
  1. If original comment exists AND `alwaysGenerate` is false → use original comment, done
  2. If original comment exists AND `alwaysGenerate` is true → generate LLM description anyway, store alongside original
  3. If no comment → generate via LLM if configured, else return nothing
- Batch mode for initial scan, concurrency-limited (`maxConcurrent: 3`)
- Prompt includes function signature, body, language, and surrounding context

---

## Phase 6: MCP Server + Tools

**Files:** `src/server/index.ts`, `src/server/register-tools.ts`, `src/server/tools/*.ts`

**Entry point** (`src/server/index.ts`):
1. Determine project root: `process.env.CLAST_PROJECT_DIR` → `process.env.CLAUDE_PROJECT_DIR` → `process.cwd()`
2. Load config, open DB (creates `.clast/` dir if needed)
3. Full index (async, logs progress)
4. Start file watcher
5. Create `McpServer`, register tools, connect stdio transport
6. Graceful shutdown on SIGINT/SIGTERM

**7 MCP Tools:**

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `clast_search` | Search symbols by name/type/pattern | Yes |
| `clast_call_graph` | Caller/callee graph with depth control | Yes |
| `clast_file_summary` | All symbols in a file, grouped by type | Yes |
| `clast_get_context` | Full symbol context (def + comments + relationships) — the "edit context" tool | Yes |
| `clast_status` | Index stats, watcher state | Yes |
| `clast_reindex` | Force re-index file or whole repo | No |
| `clast_comment` | Get/generate comments for a symbol | No |

---

## Phase 7: Plugin Packaging

**Files:** `.claude-plugin/plugin.json`, `.mcp.json`, `skills/clast-explore/SKILL.md`, `commands/clast-status.md`, `README.md`, `LICENSE`, `.gitignore`

**`.claude-plugin/plugin.json`:**
```json
{
  "name": "clast",
  "version": "0.1.0",
  "description": "AST-based code intelligence: search symbols, trace call graphs, generate comments, and provide structured context for any repository",
  "author": { "name": "Thomas" },
  "keywords": ["ast", "code-intelligence", "call-graph", "tree-sitter", "mcp"]
}
```

**`.mcp.json`:**
```json
{
  "mcpServers": {
    "clast": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server/index.js"],
      "env": {
        "CLAST_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}"
      }
    }
  }
}
```

**Plugin installation**: Users install via `git clone` + register, or via Claude Code plugin marketplace once published. The `README.md` will include install instructions for both CLI and Desktop.

**Model-invoked skill** (`skills/clast-explore/SKILL.md`): Auto-triggers when Claude is exploring code, suggests using `clast_search`, `clast_get_context`, `clast_call_graph` before reading raw files.

---

## Phase 8: Testing + Verification

- **Unit tests**: parser extraction (all 10 languages), DB CRUD + recursive CTEs, watcher debounce, each MCP tool
- **Integration test**: create temp dir with fixture files → full index → verify DB → modify file → verify incremental update → call each tool
- **Cross-platform CI**: test on Windows, macOS, Linux (native modules need platform-specific builds)

**Verification checklist:**
- `npm run build` succeeds
- All tests pass
- Server starts and responds to MCP protocol on stdio
- Plugin installs in Claude Code (CLI and Desktop)
- Tools return correct data after indexing a real repo
- File watcher detects changes and re-indexes
- LLM comment generation works when Ollama is running
- Large repo (1000+ files) indexes in < 30 seconds
- Cross-platform: forward-slash paths in DB, no platform-specific path handling

---

## Implementation Order

```
Phase 1 (scaffold) → Phase 2 (DB) → Phase 3 (parser) → Phase 4 (watcher) ─┐
                                                       → Phase 5 (LLM)    ─┤
                                                                            → Phase 6 (MCP server)
                                                                            → Phase 7 (plugin)
                                                                            → Phase 8 (tests)
```

Phases 4 and 5 are independent and can be built in parallel after Phase 3.
