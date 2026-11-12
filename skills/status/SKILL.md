---
name: status
description: Show the state of the clast index for this project.
disable-model-invocation: true
allowed-tools: mcp__plugin_clast_clast__clast_status, mcp__plugin_clast_clast__clast_reindex
---

Call `clast_status`. Report files, symbols, languages, up to date or building (with progress), database location. If it shows a problem, state it and offer `clast_reindex`. Do not reindex unasked.
