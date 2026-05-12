# Clast v0.1a

AST-based code intelligence plugin for Claude Code. Indexes your repository using [tree-sitter](https://tree-sitter.github.io/), maintains a live AST database, and exposes MCP tools for fast symbol search, call graph traversal, and context retrieval.

## Features

- **Multi-language AST parsing** — TypeScript, JavaScript, Python, Java, C#, Go, Rust, C/C++, Ruby, PHP
- **Call graph tracking** — Trace callers and callees with configurable depth
- **Live file watching** — Automatic incremental re-indexing on file changes
- **Comment extraction** — Reads existing docstrings/comments; optionally generates missing ones via local LLM
- **Per-project database** — Each repo gets its own `.clast/` SQLite database with file hashes for change detection
- **Cross-platform** — Pure WASM (no native compilation), works on Windows, macOS, Linux
- **Zero config** — Automatically indexes the current working directory on startup

---

## Quick Start

**Two steps:** install the package, then register it with Claude Code.

### Step 1: Install

```bash
npm install -g clast-ai
```

### Step 2: Register with Claude Code

```bash
claude mcp add -s user clast clast-ai
```

The `-s user` flag makes it available globally across all projects. Without it, the server is only registered for the current directory.

### Step 3: Reload

- **VS Code:** Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac) → type "Developer: Reload Window" → Enter
- **CLI:** Just relaunch `claude`

### Step 4: Verify

Type `/mcp` in the Claude Code chat panel. You should see `clast` listed with 7 tools.

> **That's it.** Clast will automatically index your project when Claude Code starts. No config files needed.

---

### Alternative Install Methods

**From GitHub (no npm publish needed):**

```bash
npm install -g github:xls/clast
claude mcp add -s user clast clast-ai
```

**Clone and build:**

```bash
git clone https://github.com/xls/clast.git
cd clast
npm install && npm run build
claude mcp add clast node /path/to/clast/dist/server/index.js
```

**As a Claude Code Plugin** (includes auto-triggering skill):

```bash
git clone https://github.com/xls/clast.git
cd clast
npm install && npm run build
claude plugin add /path/to/clast
```

> The plugin install bundles a model-invoked skill that automatically tells Claude to prefer Clast tools over grep/file reading. With the MCP-only install, you may need to tell Claude to use the clast tools.

---

## Setup for CLI

Add to `~/.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "clast": {
      "command": "clast-ai"
    }
  }
}
```

Or using the CLI:

```bash
claude mcp add -s user clast clast-ai
#              ^^^^^^^ ^^^^^ ^^^^^^^^
#              global   name  command
```

> `-s user` makes it global (available in all projects). `clast` is the server name. `clast-ai` is the npm binary.

Reload VS Code (`Ctrl+Shift+P` → "Developer: Reload Window") or relaunch the CLI. Clast will automatically index whichever project directory you open.

## Setup for VS Code (Claude Code Extension)

The Claude Code extension for VS Code uses the **same MCP configuration files** as the CLI. There is no separate VS Code-specific config.

**Step 1:** Open VS Code's integrated terminal and run:

```bash
claude mcp add -s user clast clast-ai
```

Or manually add to `~/.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "clast": {
      "command": "clast-ai"
    }
  }
}
```

**Step 2:** Reload VS Code:

- Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
- Type "Developer: Reload Window" and hit Enter

**Step 3:** Verify by typing `/mcp` in the Claude Code chat panel — you should see `clast` listed with 7 tools.

> **Note:** When VS Code spawns the MCP server, the working directory is your open workspace folder. Clast automatically indexes that directory — no path configuration needed.

If you built from source instead of installing globally:

```json
{
  "mcpServers": {
    "clast": {
      "command": "node",
      "args": ["/path/to/clast/dist/server/index.js"]
    }
  }
}
```

## Per-Project Config (Optional)

To only enable Clast for a specific project instead of globally, create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "clast": {
      "command": "clast-ai"
    }
  }
}
```

This way Clast only activates when you open that project.

---

## Usage

### What happens when you start Claude Code?

1. Claude Code spawns the Clast MCP server as a background process
2. Clast automatically scans and indexes your entire project (typically under a second)
3. The file watcher starts monitoring for changes
4. All 7 `clast_*` tools become available to Claude

**You don't need to do anything** — the AST database is created automatically. There's no manual "index" step.

### How does Claude know to use Clast?

**If installed as a plugin** (`claude plugin add`): The bundled skill automatically tells Claude to prefer Clast tools over `Grep`/`Read` when exploring code.

**If installed as an MCP server** (`claude mcp add`): Claude sees the tools and their descriptions, which instruct it to prefer Clast for symbol lookups, call graphs, and file structure. You can also explicitly ask Claude to use them:

- *"Use clast to find the Database class"*
- *"What calls parseAndStore? Check the call graph"*
- *"Show me the structure of queries.ts using clast"*

Or you can tell Claude once at the start of a session:

> *"Use the clast tools to navigate code instead of reading files directly"*

### What can you ask Claude?

| What you want | What to ask | Tool Claude uses |
|---------------|-------------|------------------|
| Find a function | *"Find the extractFromTree function"* | `clast_search` |
| Understand a function before editing | *"What does parseAndStore do? Show me its context"* | `clast_get_context` |
| Check what calls a function | *"What calls resolveCallEdges?"* | `clast_call_graph` |
| Understand a file's structure | *"What's in src/db/queries.ts?"* | `clast_file_summary` |
| Check if the index is working | *"Show clast status"* | `clast_status` |
| Force re-index after big changes | *"Reindex the project"* | `clast_reindex` |
| Generate a missing docstring | *"Generate a comment for the insertNodes function"* | `clast_comment` |

### Does the index stay up to date?

Yes. The file watcher detects changes in real-time:

- **File saved** → re-parsed, AST database updated, call edges re-resolved
- **File deleted** → removed from database
- **New file created** → parsed and added

Only changed files are re-parsed (SHA-256 hash comparison), so incremental updates are near-instant.

---

## Testing with MCP Inspector

To interactively test the tools without Claude Code:

```bash
npx @modelcontextprotocol/inspector node /path/to/clast/dist/server/index.js
```

Opens a web UI where you can call each tool and see responses.

---

## How It Detects Your Project

Clast resolves the project root in this order:

1. `CLAST_PROJECT_DIR` environment variable (explicit override)
2. `CLAUDE_PROJECT_DIR` (set automatically by Claude Code for plugins)
3. `process.cwd()` — the current working directory

**In most cases you don't need to set anything.** Claude Code (both CLI and VS Code) sets the working directory to your project folder when spawning MCP servers.

Override example (for indexing a different directory):

```json
{
  "mcpServers": {
    "clast": {
      "command": "clast-ai",
      "env": {
        "CLAST_PROJECT_DIR": "/path/to/other/project"
      }
    }
  }
}
```

---

## MCP Tools

| Tool | Description | Read-only |
|------|-------------|-----------|
| `clast_search` | Search symbols by name, type, or pattern | Yes |
| `clast_call_graph` | Trace callers/callees with configurable depth (1-5 levels) | Yes |
| `clast_file_summary` | All symbols in a file, grouped by type (imports, classes, functions, etc.) | Yes |
| `clast_get_context` | Full symbol context: definition, comments, callers, callees, parent class | Yes |
| `clast_status` | Index statistics: files, nodes, edges, watcher state | Yes |
| `clast_reindex` | Force re-index a specific file or the entire repo | No |
| `clast_comment` | Get existing or generate new documentation comments via LLM | No |

### Example Usage in Claude Code

- *"Search for the ParserManager class"* → Claude uses `clast_search`
- *"What calls the `parseAndStore` function?"* → Claude uses `clast_call_graph`
- *"Show me the structure of `src/db/queries.ts`"* → Claude uses `clast_file_summary`
- *"I need to refactor `extractFromTree` — what's the blast radius?"* → Claude uses `clast_get_context` + `clast_call_graph`

---

## Configuration

Configuration is optional. Clast works with sensible defaults out of the box.

To customize, create `clast.config.json` in your project root (or `.claude/clast.config.json`):

```json
{
  "languages": ["typescript", "javascript", "python", "java", "go", "rust"],
  "ignoredPaths": ["node_modules", ".git", "dist", "build"],
  "dbPath": ".clast/clast.db",
  "maxBodySize": 2000,
  "llm": {
    "endpoint": "http://localhost:11434/v1",
    "model": "qwen2.5-coder:7b",
    "apiKey": "",
    "alwaysGenerate": false,
    "maxConcurrent": 3
  },
  "watch": {
    "debounceMs": 300,
    "enabled": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `languages` | All supported (see below) | Which languages to parse |
| `ignoredPaths` | `node_modules`, `.git`, `dist`, etc. | Directories to skip |
| `dbPath` | `.clast/clast.db` | SQLite database location (relative to project root) |
| `maxBodySize` | `2000` | Max characters of function body stored per node |
| `llm.endpoint` | `http://localhost:11434/v1` | OpenAI-compatible API endpoint |
| `llm.model` | `""` (disabled) | LLM model name — empty string disables comment generation |
| `llm.apiKey` | `""` | API key if the endpoint requires one |
| `llm.alwaysGenerate` | `false` | Generate LLM comments even when original comments exist |
| `llm.maxConcurrent` | `3` | Max parallel LLM requests during batch generation |
| `watch.enabled` | `true` | Watch filesystem for changes |
| `watch.debounceMs` | `300` | Debounce delay for file change events |

### Supported Languages

| Language | Config name | File extensions |
|----------|-------------|-----------------|
| TypeScript | `typescript` | `.ts` |
| TSX | `tsx` | `.tsx` |
| JavaScript | `javascript` | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `python` | `.py`, `.pyw` |
| Java | `java` | `.java` |
| C# | `csharp` | `.cs` |
| Go | `go` | `.go` |
| Rust | `rust` | `.rs` |
| C | `c` | `.c`, `.h` |
| C++ | `cpp` | `.cpp`, `.hpp`, `.cc`, `.hh`, `.cxx`, `.hxx` |
| Ruby | `ruby` | `.rb` |
| PHP | `php` | `.php` |

Use the **Config name** values in the `languages` array to enable/disable specific languages:

```json
{
  "languages": ["typescript", "javascript", "python", "go"]
}
```

---

## LLM Comment Generation

Clast can generate documentation comments for functions and classes that lack them. This is **optional and disabled by default** — you need to configure an OpenAI-compatible API endpoint.

### Comment Priority Logic

1. If a function has an existing comment/docstring → use it (no LLM call)
2. If no comment exists and LLM is configured → generate on demand via `clast_comment`
3. Set `llm.alwaysGenerate: true` to generate LLM descriptions even when original comments exist

### Setup with Ollama (Free, Local)

[Ollama](https://ollama.com/) runs models locally on your machine. No API key needed.

```bash
# Install Ollama (https://ollama.com/download)
# Then pull a code model:
ollama pull qwen2.5-coder:7b
```

Add to your `clast.config.json`:

```json
{
  "llm": {
    "endpoint": "http://localhost:11434/v1",
    "model": "qwen2.5-coder:7b"
  }
}
```

Ollama's default port (11434) and Clast's default endpoint already match — so you only need to set the model name.

**Recommended Ollama models for code:**

| Model | Size | VRAM | Quality |
|-------|------|------|---------|
| `qwen2.5-coder:7b` | 4.7 GB | ~6 GB | Good |
| `qwen2.5-coder:14b` | 9 GB | ~12 GB | Better |
| `qwen2.5-coder:32b` | 18 GB | ~24 GB | Best |
| `codellama:7b` | 3.8 GB | ~6 GB | Good |
| `deepseek-coder-v2:16b` | 8.9 GB | ~12 GB | Very good |

### Setup with LM Studio (Free, Local)

[LM Studio](https://lmstudio.ai/) provides a GUI for running local models.

1. Download and install LM Studio
2. Download a code model (search for "Qwen 2.5 Coder" or "DeepSeek Coder")
3. Start the local server (LM Studio → Local Server → Start)
4. LM Studio serves on `http://localhost:1234/v1` by default

```json
{
  "llm": {
    "endpoint": "http://localhost:1234/v1",
    "model": "qwen2.5-coder-7b-instruct"
  }
}
```

> **Note:** The model name in `clast.config.json` must match exactly what LM Studio shows in its server panel.

### Setup with OpenAI / OpenRouter / Any Cloud API

Any service that exposes an OpenAI-compatible `/v1/chat/completions` endpoint works:

```json
{
  "llm": {
    "endpoint": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKey": "sk-..."
  }
}
```

**OpenRouter** (access many models via one API):

```json
{
  "llm": {
    "endpoint": "https://openrouter.ai/api/v1",
    "model": "qwen/qwen-2.5-coder-32b-instruct",
    "apiKey": "sk-or-..."
  }
}
```

### Setup with vLLM (Self-Hosted)

If you run [vLLM](https://docs.vllm.ai/) on a server or cloud GPU:

```json
{
  "llm": {
    "endpoint": "http://your-server:8000/v1",
    "model": "Qwen/Qwen2.5-Coder-7B-Instruct"
  }
}
```

---

## How It Works

1. **Startup** — Clast scans your project and parses all supported files using tree-sitter (WASM)
2. **Storage** — Extracted symbols (functions, classes, methods, imports, etc.) are stored in a SQLite database at `.clast/clast.db`, along with SHA-256 file hashes
3. **Call graph** — Call relationships are extracted from function bodies and resolved across files using name matching
4. **Watching** — A file watcher detects changes and incrementally re-indexes only modified files (hash comparison skips unchanged files)
5. **Querying** — Claude Code queries the AST database through MCP tools instead of reading raw files, getting structured context with file paths and line numbers

### What Gets Indexed

For each supported file, Clast extracts:
- **Functions and methods** — name, signature, body, line numbers
- **Classes, interfaces, structs, traits** — with their methods as children
- **Imports and exports** — module relationships
- **Enums and type aliases**
- **Call edges** — which function calls which (resolved across files)
- **Comments and docstrings** — linked to their parent symbol

### Database Location

Each project gets its own database at `{project_root}/.clast/clast.db`. Add `.clast/` to your `.gitignore` — the database is regenerated on startup from source files.

---

## VS Code Extension (Optional)

The `vscode/` directory contains a VS Code extension scaffold that:
- Auto-detects workspace folders
- Configures Claude Code's MCP settings automatically
- Provides commands: `Clast: Reindex`, `Clast: Status`, `Clast: Configure`

This is optional — most users just need the MCP server config described in [Setup for VS Code](#setup-for-vs-code).

## Requirements

- Node.js >= 18
- For LLM comment generation: an OpenAI-compatible API endpoint (optional)
- No native compilation required — all dependencies are pure JS/WASM

## License

MIT
