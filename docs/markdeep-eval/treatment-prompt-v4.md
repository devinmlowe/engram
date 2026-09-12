# Treatment Test v4: RLM with Full Engram Tool Stack + scan_file (Phase 7D)

You are participating in a controlled experiment comparing file analysis approaches. You are the TREATMENT group using the full RLM stack including the new `scan_file` tool for server-side regex scanning.

## Setup

1. First, record your start time by running: `date -u '+%Y-%m-%dT%H:%M:%SZ'`
2. Download the file:
   ```bash
   curl -sL "https://raw.githubusercontent.com/morgan3d/markdeep/master/latest/markdeep.js" -o /tmp/markdeep-v4.js
   ```
3. Record download complete time: `date -u '+%Y-%m-%dT%H:%M:%SZ'`

## Constraints

- **DO NOT use sub-agents (Agent tool).** You must do all analysis yourself.
- **YOU MUST use the RLM context management approach** combined with the engram MCP tools described below.
- Do NOT read the entire file at once into context. Treat the file as a variable.

## Available Engram MCP Tools (USE ALL OF THESE)

### `index_file_structure`
Parses a source file and indexes its structure (functions, classes, modules) into the knowledge graph. **Use this FIRST** to get a structural map of the file before answering any questions.
- Input: `{ "path": "/tmp/markdeep-v4.js" }`
- Returns: count of entities and relationships created

### `fetch_snippets`
Fetches multiple line ranges from a file in a single call. **Use this instead of multiple Read calls.**
- Input: `{ "path": "/tmp/markdeep-v4.js", "ranges": [{"start": 1, "end": 50}, {"start": 200, "end": 280}], "context": 5 }`
- Returns: concatenated snippets with gap markers and line numbers

### `explore_selective`
Criteria-driven graph exploration. After indexing the file, use this to find functions/symbols relevant to each question.
- Input: `{ "center": "<entity_name>", "criteria": "<what you're looking for>", "maxDepth": 2, "maxNodes": 20 }`
- Returns: relevant graph nodes with relevance scores

### `scan_file` ⭐ NEW — USE THIS FOR ENUMERATION QUESTIONS
Reads a file server-side, applies up to 10 regex patterns, and returns structured matches with context — WITHOUT loading the full file into your context window. Each match includes the line number, matched text, surrounding context lines, and the enclosing function name.
- Input: `{ "path": "/tmp/markdeep-v4.js", "patterns": ["regex1", "regex2"], "context_lines": 3, "max_matches": 200, "group_by": "pattern" }`
- Returns: `{ totalLines, totalMatches, matchesByPattern, matches: [{ line, pattern, matchText, context, functionContext }] }`
- **Key capability:** Scans the ENTIRE file server-side and returns only matches. This gives you exhaustive coverage without loading the full file into context.
- **Use for Q6 (regex catalog):** scan for regex literal patterns like `new RegExp\\(`, `/[^/]+/[gimsuy]*`, `\\.replace\\(\/`, `\\.match\\(\/`, `\\.test\\(\/`, `\\.search\\(\/`
- **Use for Q8 (performance optimizations):** scan for caching patterns like `cache`, `memo`, `Object\\.freeze`, `Object\\.seal`, `indexOf`, `===\\s*undefined`, `\\|\\|\\s*\\(`, `lazy`, early returns

### `recall_session`
Create a stateful search session with budget tracking and quality hints.

### `recall_drill`
Drill into a specific result for expanded context.

### `remember_batch`
After analysis, store durable findings with entity links for future sessions.

## RLM Approach (MANDATORY)

### Phase 1: INDEX (do this once, before any questions)
1. Inspect file metadata: `wc -l`, `wc -c`
2. Call `index_file_structure` on the file to populate the graph
3. Use `explore_selective` with the file as center to see the structural overview

### Phase 2: For EACH question, follow this workflow:

**Step 1: CLASSIFY** the question type:
- **Architecture** → use `explore_selective` with broad criteria, then `fetch_snippets` for key sections
- **Enumeration** → use `scan_file` with targeted regex patterns FIRST to get exhaustive matches, THEN use `explore_selective` and `fetch_snippets` for deeper context on discovered items
- **Detail** → use `explore_selective` with specific criteria, then `fetch_snippets` with boundary padding

**Step 2: SCAN (for enumeration questions)** — For Q6 and Q8 especially, use `scan_file` with multiple regex patterns to exhaustively find all instances across the entire file WITHOUT reading it into context. This is the key differentiator for v4.

**Step 3: QUERY THE GRAPH** — Use `explore_selective` with criteria matching the question.

**Step 4: TARGET & EXTRACT** — Use `fetch_snippets` to read specific line ranges identified by scan_file and graph exploration.

**Step 5: ASSESS COVERAGE** — For enumeration tasks: count what you found via scan_file (total matches), estimate coverage.

**Step 6: SYNTHESIZE** — Write your answer with specific line references.

**Step 7: VERIFY** — Spot-check at least one finding per answer.

## CRITICAL INSTRUCTIONS FOR Q6 AND Q8

### Q6 (Regex Pattern Catalog) — USE scan_file EXTENSIVELY

Run MULTIPLE scan_file calls with different pattern sets to find ALL regex usage in the file:

**Scan 1:** Find regex literals and constructors
```
patterns: ["new RegExp\\(", "/[^/]+/[gimsuy]"]
```

**Scan 2:** Find regex method calls
```
patterns: ["\\.replace\\(/", "\\.match\\(/", "\\.test\\(/", "\\.search\\(/", "\\.split\\(/"]
```

**Scan 3:** Find regex variable assignments
```
patterns: ["=\\s*/[^/]", "var\\s+\\w+.*=.*RegExp", "const\\s+\\w+.*=.*RegExp"]
```

After scanning, organize ALL discovered patterns by category. The scan_file results include `functionContext` which tells you what function each regex belongs to — use this to group patterns by subsystem.

### Q8 (Performance Optimizations) — USE scan_file

Run scan_file to find optimization patterns:

**Scan 1:** Caching and memoization
```
patterns: ["cache", "memo", "\\bcached\\b"]
```

**Scan 2:** Object optimization
```
patterns: ["Object\\.freeze", "Object\\.seal", "Object\\.create"]
```

**Scan 3:** Early exits and short circuits
```
patterns: ["return early", "if \\(!", "\\|\\|\\s*$", "&&\\s*$"]
```

**Scan 4:** Performance-specific patterns
```
patterns: ["indexOf", "charAt", "charCodeAt", "pre.?compiled?", "hoisted?"]
```

## Questionnaire

Answer ALL 8 questions below. For EACH question:
1. Record the question start time: `date -u '+%Y-%m-%dT%H:%M:%SZ'`
2. Classify the task type (architecture / enumeration / detail)
3. Apply the RLM workflow above, using engram tools — especially scan_file for enumeration
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

Write ALL results to a single file: `/Users/USER/Documents/git/engram/docs/research/markdeep-eval/result-rlm-v4.md`

Use this format:

```markdown
---
test_type: treatment_v4
approach: RLM with engram MCP tools + scan_file (Phase 7D)
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
**scan_file_patterns:** [list of scan_file patterns used, if any]
**scan_file_matches:** [total matches from scan_file, if used]
**coverage_estimate:** [lines read / total lines]

[Your detailed answer with line references]

[...continue for all 8 questions...]
```

Be thorough. Include specific line numbers. Do not rush — depth and accuracy matter as much as speed. Begin now.
