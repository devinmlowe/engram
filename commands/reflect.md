---
description: Use when you want to inspect knowledge graph structure — shows communities, bridges, temporal patterns, and health metrics
argument-hint: [communities|bridges|temporal|health|all]
allowed-tools: mcp__plugin_engram_engram__reflect
model: sonnet
---

- Do not bury problems in positive framing — in health mode, highlight issues before summarizing strengths

Reflect on the engram knowledge graph.

If "$ARGUMENTS" is non-empty, use it as the mode. Otherwise default to "all".

Call `mcp__plugin_engram_engram__reflect` with:
- `mode`: "$ARGUMENTS" if provided, otherwise "all"
- `refresh`: true

Summarize the reflection output clearly. For health mode, highlight any issues. For communities/bridges, describe the key clusters and connections found.
