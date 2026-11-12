---
name: use
description: Turn clast on for this project (creates the .clast folder and builds the index).
disable-model-invocation: true
allowed-tools: mcp__plugin_clast_clast__clast_enable
---

1. If `.clast` exists in the project root, clast is already on: report that and stop.
2. Call the `clast_enable` tool. If it is deferred, load it with tool search first.
3. If the tool is not available, create the folder `.clast` in the project root. The server finds it within seconds.
4. Report: clast is on, the index builds in the background. If the clast tools do not appear, run `/mcp` and reconnect `clast`, or restart the session.

To turn clast off for the project, delete the `.clast` folder.
