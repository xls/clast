---
name: audit
description: Produce a factual inventory of a code base for due diligence or onboarding - size, languages, structure, endpoints, database access, dependencies, largest hot spots and dead code.
argument-hint: "[path]"
disable-model-invocation: true
allowed-tools: mcp__plugin_clast_clast__clast_stats, mcp__plugin_clast_clast__clast_overview, mcp__plugin_clast_clast__clast_unused, mcp__plugin_clast_clast__clast_file_summary, mcp__plugin_clast_clast__clast_grep, Grep, Read, Glob
---

Produce an inventory of this code base. Scope: `$ARGUMENTS` (the whole project when empty; pass it as
`path` to every call below).

Gather the facts with these calls. They are independent, so issue them together:

- `clast_stats` what=inventory: files, lines, languages, production vs tests vs vendored, symbols by
  kind, longest functions.
- `clast_overview`: the main directories and what lives in them.
- `clast_stats` what=endpoints: HTTP / RPC routes by framework and by directory, and outbound client
  calls.
- `clast_stats` what=database: SQL, schema, ORM models, migrations, query call sites by receiver.
- `clast_stats` what=imports: external dependencies by how many files use them.
- `clast_unused` with the default limit: only the totals and the largest files matter here.

Then write the report:

1. **Size and shape**: lines and files per language, share of tests, vendored or generated code.
2. **Structure**: the top-level areas with one line each on what they contain.
3. **Interfaces**: number of endpoints by framework and area; outbound calls.
4. **Data**: tables or models, migrations, where queries are issued from, the most-used models.
5. **Dependencies**: the most-used external packages; anything unusual (several libraries for the same
   job, very old or abandoned-looking packages if the manifest shows versions).
6. **Maintainability signals**: the longest functions and largest files, the share of code used only
   by tests, the amount of unused code.
7. **Caveats**: endpoint and database figures come from pattern matching; dead code is judged by name.
   Spot-check one figure from each of sections 3 and 4 with a Grep and state whether it matched.

Use exact numbers from the tools; do not estimate or tally by hand. Keep it to what was measured: no
opinions on quality that the numbers do not support.
