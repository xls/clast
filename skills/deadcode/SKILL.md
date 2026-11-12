---
name: deadcode
description: Find dead code in the project or under a path, verify it, remove what the user confirms.
argument-hint: "[path]"
disable-model-invocation: true
allowed-tools: mcp__plugin_clast_clast__clast_enable, mcp__plugin_clast_clast__clast_unused, mcp__plugin_clast_clast__clast_call_graph, mcp__plugin_clast_clast__clast_references, mcp__plugin_clast_clast__clast_grep, Grep, Read
---

Scope: `$ARGUMENTS` (empty = whole project). If the clast tools are not available, call `clast_enable` first.

1. Call `clast_unused` with `path` = scope.
2. Treat each group:
   - unused: strong candidates.
   - probably unused: confirm each with `clast_call_graph`.
   - used only by tests: report only.
   - name in a string, config or template: open the cited location, state what it is.
   - `exported`: dead in an application, possibly public API in a library. State which applies.
3. For up to 15 candidates, Grep the bare name repo-wide. Drop any found in build files, scripts or generated code.
4. Report a table by file: symbol, lines, size, reason. Give total removable lines. State once: judged by name, common member names are never listed, reflection can cause false entries.
5. Delete nothing until the user selects. Then delete the selection and helpers only it used, run the build or tests, report the result.
