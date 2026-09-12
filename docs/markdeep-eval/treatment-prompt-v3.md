# Treatment Test v3: RLM with Full Engram Tool Stack (Phase 7)

You are participating in a controlled experiment comparing file analysis approaches. You are the TREATMENT group using the full RLM stack including new engram MCP tools.

## Setup

1. First, record your start time by running: `date -u '+%Y-%m-%dT%H:%M:%SZ'`
2. Download the file:
   ```bash
   curl -sL "https://raw.githubusercontent.com/morgan3d/markdeep/master/latest/markdeep.js" -o /tmp/markdeep-v3.js
   ```
3. Record download complete time: `date -u '+%Y-%m-%dT%H:%M:%SZ'`

## Constraints

- **DO NOT use sub-agents (Agent tool).** You must do all analysis yourself.
- **YOU MUST use the RLM context management approach** combined with the engram MCP tools described below.
- Do NOT read the entire file at once into context. Treat the file as a variable.

## Available Engram MCP Tools (USE THESE)

You have access to these engram MCP tools. Use them as part of your RLM workflow:

### `index_file_structure`
Parses a source file and indexes its structure (functions, classes, modules) into the knowledge graph. **Use this FIRST** to get a structural map of the file before answering any questions.
- Input: `{ "path": "/tmp/markdeep-v3.js" }`
- Returns: count of entities and relationships created
- After indexing, you can use `explore_selective` to query the structure

### `fetch_snippets`
Fetches multiple line ranges from a file in a single call. **Use this instead of multiple Read calls.**
- Input: `{ "path": "/tmp/markdeep-v3.js", "ranges": [{"start": 1, "end": 50}, {"start": 200, "end": 280}], "context": 5 }`
- Returns: concatenated snippets with gap markers and line numbers

### `explore_selective`
Criteria-driven graph exploration. After indexing the file, use this to find functions/symbols relevant to each question.
- Input: `{ "center": "<entity_name>", "criteria": "<what you're looking for>", "maxDepth": 2, "maxNodes": 20 }`
- Returns: relevant graph nodes with relevance scores

### `recall_session`
Create a stateful search session with budget tracking and quality hints.
- Returns: results + `recommendAction` ("drill" or "refine") to guide your next step

### `recall_drill`
Drill into a specific result for expanded context.

### `remember_batch`
After analysis, store durable findings with entity links for future sessions.
- Supports `relates_to_entities` to link findings to graph entities

## RLM Approach (MANDATORY)

### Phase 1: INDEX (do this once, before any questions)
1. Inspect file metadata: `wc -l`, `wc -c`
2. Call `index_file_structure` on the file to populate the graph
3. Use `explore_selective` with the file as center to see the structural overview

### Phase 2: For EACH question, follow this workflow:

**Step 1: CLASSIFY** the question type:
- **Architecture** → use `explore_selective` with broad criteria, then `fetch_snippets` for key sections
- **Enumeration** → use `explore_selective` to find relevant functions, then multi-pass grep with variant keywords, then `fetch_snippets` for discovered ranges. Estimate coverage.
- **Detail** → use `explore_selective` with specific criteria, then `fetch_snippets` with boundary padding

**Step 2: QUERY THE GRAPH** — Use `explore_selective` with criteria matching the question. This tells you WHERE to look without reading the file.

**Step 3: TARGET & EXTRACT** — Use `fetch_snippets` to read the specific line ranges identified by graph exploration. Use grep for additional discovery. Apply boundary padding (read 10-20% past apparent function boundaries).

**Step 4: ASSESS COVERAGE** — For enumeration tasks: count what you found, estimate total, note gaps.

**Step 5: SYNTHESIZE** — Write your answer with specific line references.

**Step 6: VERIFY** — Spot-check at least one finding per answer.

## Questionnaire

Answer ALL 8 questions below. For EACH question:
1. Record the question start time: `date -u '+%Y-%m-%dT%H:%M:%SZ'`
2. Classify the task type (architecture / enumeration / detail)
3. Apply the RLM workflow above, using engram tools
4. Write your answer
5. Record the question end time: `date -u '+%Y-%m-%dT%H:%M:%SZ'`

### Q1: What is markdeep.js? Describe its purpose, major subsystems, and overall control flow.

### Q2: How is the code organized? Identify namespaces, modules, or major logical sections.

### Q3: List all public/exported API functions with signatures and one-line descriptions.

### Q4: Trace the rendering pipeline: what happens when a markdown document is processed start-to-finish?

### Q5: What file formats and diagram types does markdeep support? Map each to its parser.

### Q6: Catalog all regex patterns used for markdown parsing. For each, state what syntax it matches.

### Q7: Identify error handling patterns — how does the code handle malformed input, missing resources, edge cases?

### Q8: Find any performance optimizations (caching, lazy evaluation, early exits). Describe each.

## Output

Write ALL results to a single file: `/Users/USER/Documents/git/engram/docs/research/markdeep-eval/result-rlm-v3.md`

Use this format:

```markdown
---
test_type: treatment_v3
approach: RLM with engram MCP tools (index_file_structure, fetch_snippets, explore_selective)
start_time: <overall start timestamp>
download_complete: <download timestamp>
index_complete: <timestamp when file indexing finished>
end_time: <overall end timestamp>
---

## File Structure Index
**entities_created:** <N>
**relationships_created:** <N>
[Brief summary of what the index revealed]

## Q1: Purpose, Subsystems, and Control Flow
**start:** <timestamp>
**end:** <timestamp>
**task_type:** architecture | enumeration | detail
**tools_used:** [which engram tools you used and how]
**segments_read:** [list of line ranges]
**grep_queries:** [list of grep patterns]
**coverage_estimate:** [lines read / total lines]

[Your detailed answer with line references]

[...continue for all 8 questions...]
```

Be thorough. Include specific line numbers. Do not rush — depth and accuracy matter as much as speed. Begin now.
