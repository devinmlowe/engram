# Treatment Test v2: RLM-Enhanced File Analysis (Updated Skill Guidance)

You are participating in a controlled experiment comparing file analysis approaches. You are the TREATMENT group — use the RLM (Recursive Large Model) context management approach.

## Setup

1. First, record your start time by running: `date -u '+%Y-%m-%dT%H:%M:%SZ'`
2. Download the file:
   ```bash
   curl -sL "https://raw.githubusercontent.com/morgan3d/markdeep/master/latest/markdeep.js" -o /tmp/markdeep-rlm.js
   ```
3. Record download complete time: `date -u '+%Y-%m-%dT%H:%M:%SZ'`

## Constraints

- **DO NOT use sub-agents (Agent tool).** You must do all analysis yourself.
- **YOU MUST use the RLM context management approach** as described below.
- Do NOT read the entire file at once into context. Treat the file as a variable.

## RLM Approach (MANDATORY)

### Step 1: INSPECT — Assess size and structure without reading full content
```bash
wc -l /tmp/markdeep-rlm.js
wc -c /tmp/markdeep-rlm.js
# Find section boundaries
grep -n 'function\|var \|\/\*\*\|\/\/---\|module\|exports' /tmp/markdeep-rlm.js | head -50
```

### Step 2: CLASSIFY — Before each question, classify the task type

| Task Type | Strategy |
|-----------|----------|
| **Architecture** ("What is this? How organized?") | Targeted extraction at entry points, key functions, exports. 2-3 well-chosen greps. |
| **Enumeration** ("List all X. Catalog every Y.") | Multi-pass grep with VARIANT keywords. Use 3+ different query patterns. Estimate coverage. If you've read <20% of the file for an enumeration question, you likely have gaps. |
| **Detail** ("How does X work?") | Targeted extraction around the specific item with boundary padding. |

### Step 3: TARGET — Use grep/rg to find relevant sections

For **enumeration questions**, use MULTIPLE variant queries:
```bash
# Example: "catalog all regex patterns" needs ALL of these:
rg "new RegExp\(" file.js -n          # constructor form
rg "/[^/]+/[gims]" file.js -n         # literal form
rg "\.(match|replace|search|split)\(" file.js -n  # usage sites
```

For **architecture questions**, 2-3 targeted greps suffice.

### Step 4: EXTRACT — Read only targeted line ranges
- Use `Read` with `offset` and `limit` for targeted segments only.
- **Boundary padding:** When grep finds a function at line N that appears ~60 lines long, read to N+70 (pad 10-20% past the apparent boundary). Adjacent code often contains related logic that grep alone won't catch.
- Keep each extraction under ~200 lines.

### Step 5: ASSESS COVERAGE — Before writing your answer
For enumeration tasks:
1. Count what you found
2. Estimate total: `(matches_found / lines_read) * total_lines`
3. If estimated total >> found count, run additional queries
4. If you've read <20% of the file for an enumeration question, note the gap explicitly

### Step 6: SYNTHESIZE — Combine findings into your answer
- Reference specific line numbers from your extractions.

### Step 7: VERIFY — Spot-check your findings
- For each answer, do at least one verification grep to confirm a key finding.

## Questionnaire

Answer ALL 8 questions below. For EACH question:
1. Record the question start time: `date -u '+%Y-%m-%dT%H:%M:%SZ'`
2. Classify the task type (architecture / enumeration / detail)
3. Apply the appropriate RLM strategy above
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

Write ALL results to a single file: `/Users/USER/Documents/git/engram/docs/research/markdeep-eval/result-rlm-v2.md`

Use this format:

```markdown
---
test_type: treatment_v2
approach: RLM context management with task classification, multi-pass grep, coverage estimation, boundary padding
start_time: <overall start timestamp>
download_complete: <download timestamp>
end_time: <overall end timestamp>
---

## Q1: Purpose, Subsystems, and Control Flow
**start:** <timestamp>
**end:** <timestamp>
**task_type:** architecture | enumeration | detail
**segments_read:** [list of line ranges you read, e.g., "1-50, 200-280, 8700-8784"]
**grep_queries:** [list of grep patterns you used]
**coverage_estimate:** [lines read / total lines, and any gap notes]

[Your detailed answer with line references]

## Q2: Code Organization
**start:** <timestamp>
**end:** <timestamp>
**task_type:** architecture | enumeration | detail
**segments_read:** [list of line ranges you read]
**grep_queries:** [list of grep patterns you used]
**coverage_estimate:** [lines read / total lines, and any gap notes]

[Your detailed answer with line references]

[...continue for all 8 questions...]
```

The `segments_read`, `grep_queries`, `task_type`, and `coverage_estimate` fields are CRITICAL for measuring how the updated approach performs. Do not omit them.

Be thorough. Include specific line numbers. Do not rush — depth and accuracy matter as much as speed. Begin now.
