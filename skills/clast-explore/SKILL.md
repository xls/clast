---
name: clast-explore
description: >
  Use when exploring, navigating or reviewing code in a repository that has the clast MCP server:
  finding where something is defined, reading one function or class, tracing who calls what,
  finding implementations or overrides, checking the blast radius of a change, or getting oriented
  in an unfamiliar codebase. Prefer these tools over grep and whole-file reads.
version: 0.2.0
---

# Clast code index

This project is indexed by Clast (symbols, calls, references, imports, type hierarchy). The index is
always current: it follows file changes and re-checks files when you query them, so results are valid
right after you edit. Answers come back as compact text with `path:line` locations.

## Pick the tool by question

| Question | Tool |
|----------|------|
| What is in this repo / directory? | `clast_overview` (optionally with `path`) |
| What is in this file? | `clast_file_summary` (also accepts a directory or a partial path) |
| Where is X / what is it called? | `clast_search` (names, partial names, abbreviations, typos, or plain words) |
| Show me X / I am about to edit X | `clast_get_context` (source of that symbol + callers + callees + overrides) |
| Who calls X? What does X call? | `clast_call_graph` (`depth` 2-3 to follow a chain, `within` to scope) |
| Where is X used at all? | `clast_references` (types, imports, assignments, not only calls) |
| What implements / extends / overrides X? | `clast_hierarchy` |
| Where does this string / comment / config key appear? | `clast_grep` (hits are labelled with their function) |
| What did my change touch, and what may break? | `clast_changes` (vs HEAD or a base ref) |
| I am about to change or delete X: what else must change, which tests do I run? | `clast_impact` (overrides and declarations, callers by file and line, tests that reach it) |
| What is dead code here? What did the refactor leave behind? | `clast_unused` (whole project or a path; candidates, confirm with the compiler or tests) |
| How many X are there? How big is it, what is it made of? Endpoints, database access, dependencies? | `clast_stats` (exact totals grouped by directory, kind or name; do not tally search results by hand) |

## Habits that save round trips

- Batch: `clast_search` and `clast_get_context` accept arrays of names.
- Address symbols precisely: `Class.method`, `path/file.ext:name`, `path/file.ext:123`,
  `pkg.module.name`. If a bare name is ambiguous the tool lists the candidates.
- Read the symbol, not the file: `clast_get_context` returns exactly the lines of the definition.
  Use `clast_file_summary` first when you need the shape of a file.
- Before changing a signature: `clast_call_graph` with `direction: "callers"`; add
  `includeTests: false` to see production callers only. Edges marked `?` are name-only matches on an
  untyped receiver: verify those before relying on them.
- Callers of a method include calls made through its interface or base class (they may dispatch to
  it), but not calls bound to an override in a subclass. To see every implementation's callers, ask
  for the interface / base method, or use `clast_hierarchy` on the method first.
- `clast_search` with a short description ("parse forwarded headers") also looks at what function
  bodies mention, so it can find code whose name says something else.
- After editing: `clast_changes` lists the touched symbols, callers outside the change and the test
  files that exercise them.
- If a tool says a name is not defined in the project, it is external or built dynamically:
  `clast_references` and `clast_grep` still find its uses.
