---
description: Use when you want to create an explicit relationship between two concepts in the engram knowledge graph
argument-hint: <relationship statement>
allowed-tools: mcp__plugin_engram_engram__remember
model: sonnet
---

- Do not call remember with empty or single-word content — require at least one complete sentence

Store an explicit relationship in the engram knowledge graph.

The user wants to connect concepts: $ARGUMENTS

Call `mcp__plugin_engram_engram__remember` with:
- `content`: "$ARGUMENTS"
- `type`: "pattern"
- `importance`: 0.9

This creates a high-importance pattern memory that strengthens graph edges between the referenced entities. Confirm the connection was stored and describe which entities were linked.
