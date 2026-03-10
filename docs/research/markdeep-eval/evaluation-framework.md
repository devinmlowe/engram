# RLM vs Traditional Analysis: Evaluation Framework

## Experiment Design

**File under test:** markdeep.js (8,784 lines, ~350KB)
**Date:** 2026-03-10

### Groups
- **Control:** Traditional approach — direct Read/Grep/Glob, no RLM pattern, no sub-agents
- **Treatment:** RLM context management — metadata-first, targeted extraction, no full-file reads, no sub-agents
- **Baseline:** 8-agent parallel deep-dive (one agent per question, full tool access) — ground truth

### Questionnaire (8 questions, 3 levels)

| # | Level | Question |
|---|-------|----------|
| Q1 | Architecture | Purpose, major subsystems, overall control flow |
| Q2 | Architecture | Code organization, namespaces, modules, logical sections |
| Q3 | Functional | Public/exported API functions with signatures |
| Q4 | Functional | Rendering pipeline trace, start-to-finish |
| Q5 | Functional | File formats and diagram types mapped to parsers |
| Q6 | Detail | Regex catalog with explanations |
| Q7 | Detail | Error handling patterns |
| Q8 | Detail | Performance optimizations |

## Metrics

### 1. Completeness (0-5 per question)
- 0: No answer or entirely wrong
- 1: Mentions the topic but misses most elements
- 2: Covers ~25-50% of baseline findings
- 3: Covers ~50-75% of baseline findings
- 4: Covers ~75-90% of baseline findings
- 5: Matches or exceeds baseline coverage

### 2. Accuracy (0-5 per question)
- 0: Mostly fabricated or incorrect
- 1: Major errors in core claims
- 2: Several factual errors
- 3: Minor errors, core claims correct
- 4: One or two minor inaccuracies
- 5: All claims verified correct

### 3. Depth (0-5 per question)
- 0: No meaningful analysis
- 1: Surface-level only
- 2: Some detail but shallow
- 3: Moderate depth, explains mechanisms
- 4: Deep analysis with nuanced observations
- 5: Expert-level insight, connections across subsystems

### 4. Performance Metrics
- **Total time:** start to finish
- **Per-question time:** individual question timestamps
- **Token consumption:** context window usage at completion
- **Context efficiency:** (quality score) / (tokens consumed) ratio
- **Segments read (RLM only):** total line ranges accessed
- **Coverage ratio (RLM only):** lines read / total lines in file

## Scoring Process

1. Baseline files provide ground truth for each question
2. Each answer in control and treatment is scored against baseline
3. Scores are independent — evaluator scores control and treatment without knowing which is which (blind where possible)
4. Final comparison table aggregates all metrics

## Output Files

| File | Purpose |
|------|---------|
| `markdeep.js` | Source file under analysis |
| `control-prompt.md` | Exact prompt given to control session |
| `treatment-prompt.md` | Exact prompt given to treatment session |
| `baseline-q[1-8].md` | Ground truth answers from specialist agents |
| `result-control.md` | Control session output |
| `result-rlm.md` | Treatment session output |
| `evaluation-framework.md` | This file |
| `evaluation-results.md` | Final scored comparison (generated after both complete) |
