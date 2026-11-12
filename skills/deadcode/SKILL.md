---
name: deadcode
description: Find dead code (unused functions, methods and types) in the project or under a path, verify the candidates, and offer to remove them.
argument-hint: "[path]"
disable-model-invocation: true
allowed-tools: mcp__plugin_clast_clast__clast_unused, mcp__plugin_clast_clast__clast_call_graph, mcp__plugin_clast_clast__clast_references, mcp__plugin_clast_clast__clast_grep, Grep, Read
---

Find dead code. Scope: `$ARGUMENTS` (the whole project when empty).

1. Call `clast_unused` with `path` set to the scope (omit it for the whole project). On a large
   project start with the default limit; raise it only if the user wants the full list.
2. The result has groups. Treat them differently:
   - **unused**: the name is never referenced, or only by other unused code. Strong candidates.
   - **probably unused**: the name is called, but every call binds to another definition. Check each
     with `clast_call_graph` before reporting it.
   - **used only by tests**: dead in production; removing it means removing the tests too. Report, do
     not propose deleting without asking.
   - **name appears in a string, config or template**: may be reached by reflection, routing or a
     template. Open the cited location and say what it is.
   - symbols marked `exported`: unused inside this project. In an application that is dead code; in a
     library it may be public API. Say which case applies here (look for a published package, a
     public header directory, or an API surface file).
3. Verify before you present: for the candidates you intend to recommend (at most about 15), run one
   Grep for the bare name across the repository and drop any that turn up in build files, scripts,
   generated code or documentation that shows it is an entry point.
4. Report as a short table grouped by file: symbol, lines, size, and why it is considered unused. Give
   the total number of removable lines. State the limits in one sentence: the check is by name, so
   members with common names (`get`, `run`) are never listed, and code reached only through reflection
   can be listed wrongly.
5. Do not delete anything yet. Ask which of the candidates to remove. When the user confirms, delete
   them (and helpers that only they used), then build or run the tests the project has to confirm
   nothing broke, and report the result.
