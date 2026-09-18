---
description: Use when you want to see how a concept connects to other entities in the engram knowledge graph
argument-hint: <entity name>
allowed-tools: mcp__plugin_engram_engram__explore
model: haiku
---

- Do not follow entity chains beyond depth 2 without explicit user request

Explore the engram knowledge graph for entity: $ARGUMENTS

Call `mcp__plugin_engram_engram__explore` with:
- `entity`: "$ARGUMENTS"
- `depth`: 1
- `limit`: 25
- `budget`: 1500

Display the entity's connections clearly — show neighboring entities, relationship types, and edge weights if available.
