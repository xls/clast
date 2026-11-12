---
name: status
description: Show the state of the clast index for this project - files, symbols, languages, whether it is up to date.
disable-model-invocation: true
allowed-tools: mcp__plugin_clast_clast__clast_status, mcp__plugin_clast_clast__clast_reindex
---

Call `clast_status` and report in a few lines: files and symbols indexed, languages, whether the index
is up to date or still building, and where the database is. If the index is still building, say how
far it is. If the status shows a problem (no files, a failed run), say so and offer to run
`clast_reindex`; do not reindex unasked.
