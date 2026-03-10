# Treatment Test: RLM-Enhanced File Analysis (No Sub-agents)

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

Follow this pattern for EVERY question:

### Step 1: INSPECT — Assess size and structure without reading full content
```bash
wc -l /tmp/markdeep-rlm.js
wc -c /tmp/markdeep-rlm.js
# Find section boundaries
grep -n 'function\|var \|\/\*\*\|\/\/---\|module\|exports' /tmp/markdeep-rlm.js | head -50
```

### Step 2: TARGET — For each question, use grep/rg to find ONLY the relevant sections
- Do NOT read the whole file. Use pattern matching to locate relevant code.
- Read only the specific line ranges that are relevant to the current question.
- Use `Read` with `offset` and `limit` to read targeted segments only.

### Step 3: EXTRACT — Pull targeted segments using grep, awk, or targeted Read calls
- Keep each extraction under ~200 lines.
- Use multiple targeted reads rather than one large read.

### Step 4: SYNTHESIZE — Combine findings from targeted extractions into your answer
- Your answer should reference specific line numbers from your extractions.

### Step 5: VERIFY — Spot-check your findings
- For each answer, do at least one verification grep to confirm a key finding.

## Questionnaire

Answer ALL 8 questions below. For EACH question:
1. Record the question start time: `date -u '+%Y-%m-%dT%H:%M:%SZ'`
2. Apply the RLM 5-step approach above
3. Write your answer
4. Record the question end time: `date -u '+%Y-%m-%dT%H:%M:%SZ'`

### Q1: What is markdeep.js? Describe its purpose, major subsystems, and overall control flow.

### Q2: How is the code organized? Identify namespaces, modules, or major logical sections.

### Q3: List all public/exported API functions with signatures and one-line descriptions.

### Q4: Trace the rendering pipeline: what happens when a markdown document is processed start-to-finish?

### Q5: What file formats and diagram types does markdeep support? Map each to its parser.

### Q6: Catalog all regex patterns used for markdown parsing. For each, state what syntax it matches.

### Q7: Identify error handling patterns — how does the code handle malformed input, missing resources, edge cases?

### Q8: Find any performance optimizations (caching, lazy evaluation, early exits). Describe each.

## Output

Write ALL results to a single file: `/Users/USER/Documents/git/engram/docs/research/markdeep-eval/result-rlm.md`

Use this format:

```markdown
---
test_type: treatment
approach: RLM context management (targeted extraction, no full-file reads)
start_time: <overall start timestamp>
download_complete: <download timestamp>
end_time: <overall end timestamp>
---

## Q1: Purpose, Subsystems, and Control Flow
**start:** <timestamp>
**end:** <timestamp>
**segments_read:** [list of line ranges you read, e.g., "1-50, 200-280, 8700-8784"]
**grep_queries:** [list of grep patterns you used]

[Your detailed answer with line references]

## Q2: Code Organization
**start:** <timestamp>
**end:** <timestamp>
**segments_read:** [list of line ranges you read]
**grep_queries:** [list of grep patterns you used]

[Your detailed answer with line references]

[...continue for all 8 questions...]
```

The `segments_read` and `grep_queries` fields are CRITICAL for measuring how much of the file you actually consumed. Do not omit them.

Be thorough. Include specific line numbers. Do not rush — depth and accuracy matter as much as speed. Begin now.
