---
description: Use when you need to retrieve past knowledge, decisions, or context — searches episodic and semantic memories via engram
argument-hint: <query>
allowed-tools: mcp__plugin_engram_engram__recall
model: haiku
---

- Do not synthesize answers from recall results alone — clearly distinguish retrieved facts from inferences

Search engram memories for: $ARGUMENTS

Call `mcp__plugin_engram_engram__recall` with:
- `query`: "$ARGUMENTS"
- `budget`: 1500
- `depth`: "shallow"
- `sources`: ["episodic", "semantic"]

Display the results clearly, grouping by source type if both return hits. Keep output concise.
