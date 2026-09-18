---
description: Use when you want to persist a fact, decision, or insight for future recall — stores in engram knowledge graph
argument-hint: <fact or decision to remember>
allowed-tools: mcp__plugin_engram_engram__remember
model: haiku
---

- Do not call remember with empty or one-word content — require at least one complete sentence describing the fact or decision

Store the following in engram: $ARGUMENTS

Call `mcp__plugin_engram_engram__remember` with:
- `content`: "$ARGUMENTS"
- `type`: "fact"
- `importance`: 0.7

Confirm what was stored and any entities/relationships extracted.
