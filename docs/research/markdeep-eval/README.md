# Markdeep Evaluation

Controlled evaluation of engram's RLM-enhanced recall vs baseline retrieval. Uses Markdeep for rich HTML rendering of evaluation results.

## In Scope

- Evaluation framework and scoring methodology
- Baseline questions and control prompts
- Treatment prompts (RLM-enhanced, multiple iterations v1–v4)
- Evaluation results and comparative analysis

## Out of Scope

- Engram implementation changes (see [src/](../../../src/))
- RLM integration plans (see [plans/](../../../plans/))

## Contains

- `evaluation-framework.md` — Scoring methodology and test design
- `control-prompt.md` — Control condition prompt
- `treatment-prompt*.md` — RLM-enhanced treatment prompts (v1–v4)
- `baseline-q*.md` — Baseline evaluation questions (8 questions)
- `result-control.md` — Control condition results
- `result-rlm*.md` — RLM treatment results (v1–v4)
- `evaluation-results*.md` — Comparative analysis (v1–v4)
- `markdeep.js` — Markdeep rendering library

## See Also

- [docs/research/](../) — Parent research directory
- [plans/phase-6-rlm-integration.md](../../../plans/phase-6-rlm-integration.md) — RLM integration plan
