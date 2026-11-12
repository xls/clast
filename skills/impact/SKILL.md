---
name: impact
description: Show what a change to one function, method or type affects - what must change with it, every caller, and the tests to run.
argument-hint: "<symbol>"
disable-model-invocation: true
allowed-tools: mcp__plugin_clast_clast__clast_impact, mcp__plugin_clast_clast__clast_search, mcp__plugin_clast_clast__clast_get_context, mcp__plugin_clast_clast__clast_call_graph, mcp__plugin_clast_clast__clast_hierarchy, Grep, Read
---

Assess the impact of changing `$ARGUMENTS`.

1. If no symbol was given, ask which one. If the name is ambiguous, `clast_impact` lists the
   candidates: pick the one the user means (ask when it is not obvious) and address it as
   `Container.name` or `path/file.ext:name`.
2. Call `clast_impact` for the symbol (default depth 3).
3. Report, in this order and without padding:
   - **Changes together**: declarations, overrides, implementations and overloads of the same member.
   - **Direct callers**: by file with line numbers. Callers marked `?` are name-only matches: check
     each with a quick Read of the cited line and say whether it is a real caller.
   - **Reach**: how many functions in how many files depend on it indirectly, by area.
   - **Tests to run**: the test files, split into those that call it directly and those that reach it
     through callers. Give the project's command to run exactly those tests if you can tell what it is.
   - If no test reaches it, say so plainly: that is the main risk of the change.
4. End with a one-line verdict on the size of the change (local, moderate, wide) and what to edit
   first. Do not start editing unless the user asks.
