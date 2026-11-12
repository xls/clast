---
name: explore
description: Which clast tool answers which question, and when to skip clast. Use when navigating, reviewing or about to change code in a repository that has the clast MCP tools.
---

# clast

Use clast for multi-hop questions, counts, dead code and code described by behaviour.
Skip clast for one exact name (Grep) and for mechanical edits.

| Question | Tool |
|----------|------|
| What is in this repo / directory / file? | `clast_overview`, `clast_file_summary` |
| Where is the code that does X (no name known)? | `clast_search` with a short description |
| Which of many same-named definitions? | `clast_search` with the name plus context words (`write socket`) |
| Show X before editing | `clast_get_context` |
| Who calls X, N levels up? | `clast_call_graph` (`depth`, `within`) |
| What implements / extends / overrides X? | `clast_hierarchy` |
| What changes with X, which tests run? | `clast_impact` |
| How many X? Endpoints, database access, dependencies? | `clast_stats` |
| What is unused? | `clast_unused` |
| What did the diff touch? | `clast_changes` |
| Every use of an identifier / a string or config key | `clast_references` / `clast_grep` |

Rules:

- Batch: `clast_search` and `clast_get_context` take arrays. Use `depth` instead of repeated calls.
- Address symbols as `Class.method`, `path/file.ext:name` or `path/file.ext:123`. If candidates are listed, pick one.
- `?` on an edge = name-only match. Verify it before use.
- Callers of a method include calls through its interface or base type, not calls bound to a subclass override.
- Rename or signature change of a distinctive name: no clast. Grep the name, then edit.
- `clast_impact` before a change only if the name is common (`get`, `run`), overrides must change too, or tests must be chosen.
- `clast_unused` results are candidates. Common member names are never listed. Confirm with the compiler or tests before deletion.
- Narrow large repositories with `path` / `within`.
- Never reindex. The index follows edits.
- "Not defined in the project" = external or built at run time. `clast_references` and `clast_grep` still find uses.
