---
name: clast-explore
description: >
  Use when exploring or understanding code structure: finding functions, tracing call graphs,
  understanding symbol context before editing, or generating documentation. Triggers when Claude
  needs to navigate a codebase, find definitions, understand relationships between functions,
  or prepare context for code modifications.
version: 0.1.0
---

# Clast Code Intelligence

This project has Clast AST indexing active. Before reading entire files or using grep to find
code, prefer using Clast tools for faster, more structured results:

## Available Tools

1. **clast_search** — Find functions, classes, methods by name pattern.
   Use this BEFORE grep when looking for a symbol definition.

2. **clast_get_context** — Get full context for a symbol: definition, comments, who calls it,
   what it calls. Use this BEFORE reading a file to understand a specific function or class.

3. **clast_call_graph** — Trace the call chain: what calls a function (callers) and what it
   calls (callees). Use this before refactoring to understand impact.

4. **clast_file_summary** — Get all symbols in a file grouped by type. Use this instead of
   reading a whole file when you just need to understand its structure.

5. **clast_status** — Check if the index is up to date.

6. **clast_reindex** — Force re-index if data seems stale.

7. **clast_comment** — Get or generate documentation for a function/class.

## Workflow Tips

- When asked to edit a function: use `clast_get_context` first to understand it, then edit.
- When asked to refactor: use `clast_call_graph` to understand the blast radius.
- When exploring unfamiliar code: use `clast_file_summary` on key files.
- When adding features: use `clast_search` to find related existing code.
