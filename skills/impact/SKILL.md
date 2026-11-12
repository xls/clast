---
name: impact
description: Show what a change to one symbol affects - what changes with it, every caller, the tests to run.
argument-hint: "<symbol>"
disable-model-invocation: true
allowed-tools: mcp__plugin_clast_clast__clast_enable, mcp__plugin_clast_clast__clast_impact, mcp__plugin_clast_clast__clast_search, mcp__plugin_clast_clast__clast_get_context, mcp__plugin_clast_clast__clast_call_graph, mcp__plugin_clast_clast__clast_hierarchy, Grep, Read
---

Symbol: `$ARGUMENTS`. If empty, ask. If ambiguous, pick the candidate the user means and address it as `Container.name` or `path/file.ext:name`.

1. If the clast tools are not available, call `clast_enable`. Call `clast_impact`.
2. Report in this order:
   - Changes together: declarations, overrides, implementations, overloads.
   - Direct callers by file and line. Read each `?` caller and state if it is real.
   - Reach: indirect callers, count by area.
   - Tests to run: direct, then through callers. Give the command to run them if known.
   - If no test reaches it, state that as the main risk.
3. End with one line: size of the change (local, moderate, wide) and what to edit first. Do not edit unless asked.
