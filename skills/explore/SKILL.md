---
name: explore
description: >
  How to get the most out of the clast code index: which tool answers which question, and the habits
  that save round trips. Use when navigating, reviewing or about to change code in a repository that
  has the clast MCP tools, especially for multi-step questions (call chains, subclasses, impact, counts,
  dead code) or code described by behaviour instead of by name.
---

# Using the clast code index well

Clast answers structural questions in one call. It does not replace Grep for "where is this exact
name" or Read for code you are about to edit: measured against plain grep, clast wins on questions that
take several hops, on counting, on dead code and on finding code by what it does; simple lookups are a
tie. Use it where it wins.

## Pick the tool by question

| Question | Tool |
|----------|------|
| What is in this repo / directory / file? | `clast_overview`, then `clast_file_summary` |
| Where is the code that does X (no name known)? | `clast_search` with a short description of the behaviour |
| Show me X, I am about to edit X | `clast_get_context` (that symbol's source, callers, callees) |
| Who calls X, through how many levels? | `clast_call_graph` (`depth` 2-3, `within` to scope) |
| What implements / extends / overrides X? | `clast_hierarchy` |
| What else must change with X, and which tests do I run? | `clast_impact` |
| How many X? How big? Endpoints, database access, dependencies? | `clast_stats` (never tally search results by hand) |
| What is unused? What did a refactor leave behind? | `clast_unused` |
| What did my diff touch? | `clast_changes` |
| Every use of an identifier, or a string / config key | `clast_references`, `clast_grep` |

## Habits that save round trips

- One call, not a loop: `clast_search` and `clast_get_context` take arrays of names; `clast_call_graph`
  and `clast_hierarchy` take a `depth`.
- Address symbols precisely: `Class.method`, `path/file.ext:name`, `path/file.ext:123`. A bare name
  with several definitions returns the candidates; pick one, do not guess.
- Read the symbol, not the file: `clast_get_context` returns exactly the definition's lines.
- An edge marked `?` was matched by name only (the receiver's type is unknown). Verify it with a quick
  Grep or Read before you rely on it; unmarked edges are resolved through types and imports.
- Callers of a method include calls through its interface or base class, not calls bound to an override
  in a subclass. For every implementation's callers ask for the interface or base method.
- Before a signature change: `clast_impact` lists the overrides and declarations that change with it,
  the callers by file and line, and the tests that reach it even when none names it.
- `clast_unused` lists candidates judged by name. Members with common names (`get`, `run`) are never
  listed, and reflection or framework wiring can keep a listed symbol alive: confirm with the compiler
  or the tests before deleting.
- Narrow with `path` (and `within` for call graphs) on large repositories; results and run time shrink.
- The index follows file changes, including your own edits. There is no need to reindex.
- If a tool says a name is not defined in the project, it is external or built at run time:
  `clast_references` and `clast_grep` still find its uses.

Slash commands in this plugin: `/clast:deadcode [path]`, `/clast:impact <symbol>`, `/clast:audit [path]`,
`/clast:status`.
