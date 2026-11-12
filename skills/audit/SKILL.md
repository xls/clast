---
name: audit
description: Factual inventory of a code base for due diligence or onboarding - size, structure, endpoints, database access, dependencies, dead code.
argument-hint: "[path]"
disable-model-invocation: true
allowed-tools: mcp__plugin_clast_clast__clast_stats, mcp__plugin_clast_clast__clast_overview, mcp__plugin_clast_clast__clast_unused, mcp__plugin_clast_clast__clast_file_summary, mcp__plugin_clast_clast__clast_grep, Grep, Read, Glob
---

Scope: `$ARGUMENTS` (empty = whole project). Pass it as `path` to every call.

Issue these calls together:

- `clast_stats` what=inventory
- `clast_overview`
- `clast_stats` what=endpoints
- `clast_stats` what=database
- `clast_stats` what=imports
- `clast_unused` (totals and largest files only)

Report:

1. Size and shape: lines and files per language, share of tests, vendored or generated code.
2. Structure: top-level areas, one line each.
3. Interfaces: endpoints by framework and area, outbound calls.
4. Data: tables or models, migrations, where queries are issued, most-used models.
5. Dependencies: most-used packages, duplicates for the same job.
6. Maintainability: longest functions, largest files, code used only by tests, unused code.
7. Caveats: endpoint and database figures are pattern-based, dead code is judged by name. Spot-check one figure from sections 3 and 4 with Grep and state the result.

Use exact tool numbers. No estimates. No quality opinions beyond the numbers.
