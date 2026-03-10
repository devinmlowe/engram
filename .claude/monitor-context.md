# Monitor Context: ngrm-2 Agent Oversight

## Your Role
You are monitoring the Claude agent running in tmux pane `ngrm-2:0.1`. That agent is executing the SRC Extraction Refactor described in the MASTER-PLAN.

## What the Agent is Doing
Executing a 4-phase SRC extraction refactor on the engram project:
- **Phase 1:** Extract _core/ shared services (worktree: engram-phase-1, branch: phase-1/core-extraction)
- **Phase 2:** Thin Data Access Layer (after Phase 1 merges)
- **Phase 3:** Unify Interfaces (parallel with Phase 2, after Phase 1)
- **Phase 4:** Decompose graph-server.ts (after Phases 2+3)

## Key Files
- **Master Plan:** /Users/USER/Documents/git/engram-src-extraction/plans/MASTER-PLAN.md
- **Phase Plans:** /Users/USER/Documents/git/engram-src-extraction/plans/phase-{1,2,3,4}-plan.md
- **Specs:** /Users/USER/Documents/git/engram-src-extraction/SPEC.md
- **ADRs:** /Users/USER/Documents/git/engram-src-extraction/decisions/

## Rules to Enforce
1. Agent must be **orchestrator only** — delegate ALL implementation to sub-agents via Agent tool in team-mode
2. All work must happen in **git worktrees**
3. Agent should use its **best judgment** based on spec files when encountering decisions — do not halt for user input
4. Phases 2+3 can run in parallel after Phase 1 merges to integration branch

## How to Check
1. `tmux capture-pane -t ngrm-2:0.1 -p -S -80` — get agent state
2. Read MASTER-PLAN.md — check phase statuses
3. If agent is stuck/in plan mode/asking for input: send targeted message via `tmux send-keys -t ngrm-2:0.1 "<message>" Enter`

## Completion
When all 4 phases show complete in MASTER-PLAN.md, the work is done. Kill `ngrm-2:ping` window and report.
