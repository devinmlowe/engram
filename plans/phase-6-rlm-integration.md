# Phase 6: RLM Integration — Master Plan

**Created:** 2026-03-10
**Status:** PLANNING
**Research:** `~/markdown-notes/Claude-Research/topics/claude-code/recursive-language-models-assessment.md`
**Paper:** https://arxiv.org/abs/2512.24601

---

## Overview

Integrate Recursive Language Model (RLM) patterns into engram and the Claude Code ecosystem. This transforms engram from a passive retrieval system into an active exploration environment, adds adaptive extraction to the dream pipeline, and creates new Claude Code components to leverage RLM patterns system-wide.

## Guiding Principles

1. **Don't break what works** — All 671+ existing tests must pass at every checkpoint
2. **Worktree isolation** — All engram changes developed and validated in worktrees before merging
3. **TDD** — New features get tests before implementation
4. **Incremental value** — Each sub-phase delivers independently useful capability
5. **Validate as user** — Interactive tmux sessions to test the full loop before merging

---

## Phase 0: Research & Reference Study

**Goal:** Study existing RLM implementations to inform design decisions before writing code.

### 0.1 Clone & Analyze Official RLM Repo
- Clone `alexzhang13/rlm` (official, 2,941 stars)
- Document: REPL environment setup, `llm_query()` interface, prompt variable handling
- Extract: System prompts, chunking strategies, sub-call patterns
- Deliverable: Research note at `~/markdown-notes/Claude-Research/topics/claude-code/rlm-official-repo-analysis.md`

### 0.2 Analyze Claude Code RLM Scaffold
- Clone `brainqub3/claude_code_RLM` (363 stars)
- Document: How it adapts RLM for Claude Code's agent/skill model
- Extract: Prompt patterns, CLAUDE.md directives, agent definitions
- Deliverable: Research note at `~/markdown-notes/Claude-Research/topics/claude-code/rlm-claude-scaffold-analysis.md`

### 0.3 Analyze DSPy RLM Module
- Study `stanfordnlp/dspy` RLM module (via docs + source)
- Document: How DSPy structures the RLM loop, what abstractions it provides
- Assess: Whether DSPy.RLM could be used as a backend or if native implementation is better
- Deliverable: Research note at `~/markdown-notes/Claude-Research/topics/claude-code/dspy-rlm-module-analysis.md`

**Exit Criteria:** Three research notes complete, design decisions documented for Phase 1.

---

## Phase 1: Engram Core Enhancements

**Goal:** Add RLM-inspired capabilities to engram's core. All work in a git worktree branched from `main`.

**Worktree:** `phase-6-rlm` branch

### 1A: Adaptive Dream Extraction (HIGH VALUE)

**Problem:** Fixed 25-exchange chunking misses information-dense clusters and wastes LLM calls on sparse exchanges.

**Current code:** `src/_core/search/text.ts:19-48` (`chunkConversation()`) + `src/semantic/extractor.ts:472-539`

**Changes:**
1. Add `AdaptiveChunker` alongside existing `chunkConversation()`
   - Phase 1: Inspect conversation metadata (exchange count, avg length, tool call density)
   - Phase 2: Score exchanges by information density (heuristic: length + tool calls + code blocks)
   - Phase 3: Create variable-sized chunks — larger for sparse regions, smaller for dense ones
   - Phase 4: For very dense chunks, allow recursive sub-extraction (chunk a chunk)
2. Add `chunking_strategy` config option: `"fixed"` (default, backward compatible) | `"adaptive"`
3. Extractor uses adaptive chunker when configured, falls back to fixed

**Tests:**
- Unit: AdaptiveChunker produces valid chunks for edge cases (empty, single exchange, all dense, all sparse)
- Unit: Density scoring produces expected rankings for known conversation shapes
- Integration: Adaptive extraction produces >= as many facts as fixed chunking on test conversations
- Contract: Existing `chunkConversation()` behavior unchanged

**Validation:** Run full dream pipeline on a test database, compare fact counts fixed vs adaptive.

### 1B: Iterative Recall — New MCP Tool (HIGH VALUE)

**Problem:** Current `recall` is single-shot. RLM pattern requires iterative, code-driven exploration.

**Current code:** `src/interfaces/mcp/server.ts:362-380` → `src/interfaces/shared/search.ts:42-61`

**Changes:**
1. Add new MCP tool: `recall_session` — Creates a stateful search session
   - Returns a `session_id` + initial results
   - Subsequent calls with `session_id` can: refine query, follow entity links, expand a result, search within results
2. Add new MCP tool: `recall_drill` — Drill into a specific result from a session
   - Given `session_id` + `result_id`, returns the full context around that result
   - Can recursively drill (e.g., expand an exchange to see surrounding 10 exchanges)
3. Session state stored in-memory (LRU cache, 10 sessions, 30-min TTL)
4. Existing `recall` tool unchanged (backward compatible)

**Tests:**
- Unit: Session creation, refinement, drilling, expiry
- Integration: Multi-step recall session across episodic+semantic+graph
- Contract: Existing `recall` behavior unchanged

**Validation:** Interactive tmux test — invoke recall_session, refine, drill, verify coherent results.

### 1C: Recursive Graph Exploration (MEDIUM VALUE)

**Problem:** `explore` uses fixed-depth BFS. RLM pattern needs model-directed selective traversal.

**Current code:** `src/graph/search.ts:158-310` (`exploreEntity()` + `traverseNeighborhood()`)

**Changes:**
1. Add `explore_selective` MCP tool — model provides entity + relevance criteria
   - Depth 1: Get all neighbors
   - Model evaluates which neighbors are relevant (via criteria string matching)
   - Depth 2+: Only expand relevant neighbors
   - Returns: Pruned subgraph with relevance annotations
2. Enhance `traverseNeighborhood()` with optional filter callback
3. Existing `explore` tool unchanged

**Tests:**
- Unit: Selective traversal with various filter criteria
- Integration: Multi-depth selective exploration on test graph
- Contract: Existing `explore` behavior unchanged

**Validation:** Interactive test — explore a well-connected entity, verify selective pruning.

### 1D: RLM Result Ingestion (LOW EFFORT)

**Problem:** When RLM agents generate insights, those should feed back into engram.

**Changes:**
1. Add `remember_batch` MCP tool — accepts array of memories in one call
   - Same dedup logic as `remember`, applied per item
   - Returns: count of new vs deduplicated items
2. Add optional `source` field to memories table: `"user"` | `"dream"` | `"rlm"` | `"import"`
   - Schema migration (additive, non-breaking)
   - Default: `"user"` for backward compatibility

**Tests:**
- Unit: Batch remember with dedup
- Migration: Schema migration applies cleanly, existing data preserved
- Contract: Existing `remember` behavior unchanged

**Validation:** Batch insert test memories, verify dedup and source tracking.

### Phase 1 Exit Criteria
- [ ] All new tests pass
- [ ] All 671+ existing tests still pass
- [ ] `npm run build` succeeds
- [ ] Interactive validation in tmux (recall_session, explore_selective, remember_batch)
- [ ] Dream pipeline runs successfully with adaptive chunking
- [ ] Merge worktree to main
- [ ] Restart MCP server, verify tools available

---

## Phase 2: Claude Code RLM Components

**Goal:** Create new agents, skills, and commands that leverage RLM patterns + enhanced engram.

### 2A: RLM Processor Agent

**File:** `~/.claude/agents/rlm-processor.md`

**Purpose:** Process inputs that exceed comfortable context sizes using RLM decomposition pattern.

**Capabilities:**
- Receives: task description + path to large content (file, directory, URL)
- Inspects: Uses Bash/Python to assess size, structure, sections
- Decomposes: Writes code to split content into processable segments
- Sub-calls: Spawns sub-agents (haiku model) for leaf analysis
- Aggregates: Combines sub-results programmatically
- Stores: Optionally feeds findings into engram via `remember_batch`

**Model routing:**
- Root agent: opus (strategic decomposition + synthesis)
- Branch agents: sonnet (substantive analysis)
- Leaf agents: haiku (extraction + filtering)

### 2B: RLM Context Skill

**File:** `~/.claude/skills/rlm-context/SKILL.md`

**Purpose:** Teach Claude Code the REPL-variable pattern for large inputs.

**Trigger:** When processing content >50K tokens.

**Behavior:**
1. Don't read entire files — load paths + metadata only
2. Write targeted extraction code (grep, python) to pull relevant segments
3. Use sub-agents for segment analysis when segments are large
4. Aggregate results programmatically, not in natural language
5. Store findings in engram if the analysis produced durable knowledge

### 2C: Engram RLM Recall Skill

**File:** `~/.claude/skills/engram-rlm-recall/SKILL.md`

**Purpose:** Teach Claude Code to use iterative recall instead of single-shot.

**Trigger:** When a question requires cross-referencing multiple knowledge domains or past sessions.

**Behavior:**
1. Start a recall_session with initial query
2. Evaluate results — identify gaps or promising leads
3. Refine or drill based on initial results
4. Follow entity connections via explore_selective
5. Synthesize across all retrieved context

### 2D: Commands

- `/rlm-process <path>` — Invoke RLM processor agent on a file/directory
- `/rlm-recall <query>` — Invoke iterative recall with session management

### Phase 2 Exit Criteria
- [ ] All component files created and validated (claude-compliance skill)
- [ ] Interactive testing via tmux: invoke /rlm-process on a large file, verify decomposition
- [ ] Interactive testing: invoke /rlm-recall, verify multi-step exploration
- [ ] Components reference each other correctly (agent invokes skill, command invokes agent)

---

## Phase 3: Claude Code Directive Updates

**Goal:** Update CLAUDE.md and hub-spoke memory files to encode RLM awareness system-wide.

### 3A: Global CLAUDE.md

Add RLM principle to AI Guidance section:
- When facing content >50K tokens, prefer REPL-variable pattern over context stuffing
- Reference rlm-context skill for details

### 3B: Engram Repo CLAUDE.md

Create `~/Documents/git/engram/CLAUDE.md`:
- Document RLM-enhanced tools (recall_session, explore_selective, remember_batch)
- Document adaptive chunking configuration
- Reference Phase 6 plan and research assessment

### 3C: Memory Bank Updates

- Update `CLAUDE-patterns.md` — Add RLM patterns (context-as-variable, recursive decomposition, model routing)
- Update `CLAUDE-memory-system.md` — Register new engram MCP tools
- Update `CLAUDE-config-variables.md` — Add engram RLM configuration pointers

### 3D: Validate Consistency

- Run memory-consistency-checker skill
- Verify all cross-references resolve
- Ensure no circular or broken spoke references

### Phase 3 Exit Criteria
- [ ] CLAUDE.md updated with RLM principles (minimal, directive-level)
- [ ] Engram CLAUDE.md created
- [ ] Memory bank files updated and consistency-checked
- [ ] New skills/agents/commands registered in CLAUDE-memory-system.md

---

## Execution Model

### Agent Teams

Each phase uses a dedicated agent team:

| Phase | Team | Agents | Coordination |
|-------|------|--------|-------------|
| 0 (Research) | `rlm-research` | 3 parallel researchers | Independent, results aggregated |
| 1 (Engram) | `rlm-engram` | 1 lead + implementers per sub-phase | Sequential (1A→1B→1C→1D), TDD within each |
| 2 (Components) | `rlm-components` | 1 per component type | Parallel (2A/2B/2C can be concurrent) |
| 3 (Directives) | `rlm-directives` | 1 updater + 1 validator | Sequential (update then validate) |

### Worktree Strategy

```
Phase 0: No worktree needed (research output goes to markdown-notes)
Phase 1: Worktree on engram repo (branch: phase-6-rlm)
         ├── 1A: adaptive chunking
         ├── 1B: iterative recall
         ├── 1C: recursive explore
         └── 1D: batch remember
         Merge to main after all sub-phases pass
Phase 2: No worktree (skill/agent files, not repo code)
Phase 3: No worktree (directive files only)
```

### Validation Checkpoints

1. **After Phase 0:** Review research notes, confirm design decisions before coding
2. **After each Phase 1 sub-phase:** Run `npm run test:run`, verify no regressions
3. **After Phase 1 complete:** Full interactive test in tmux, then merge
4. **After Phase 2:** Interactive test of new commands/agents in tmux
5. **After Phase 3:** Memory consistency check, full system smoke test

### Interactive Testing Protocol

For validation checkpoints requiring "pretend to be user":
1. Open tmux window: `tmux new-window -n rlm-test`
2. Start Claude Code in interactive mode
3. Test each new capability with realistic prompts
4. Capture output for review
5. Close test window

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing tests | Run full suite after every sub-phase; worktree isolation |
| MCP server incompatibility | New tools only; existing tools unchanged; contract tests |
| Schema migration issues | Additive-only migrations; test on copy of production DB |
| Session state memory leak | LRU cache with TTL; max 10 concurrent sessions |
| Adaptive chunking worse than fixed | Keep fixed as default; adaptive opt-in via config |
| Over-engineering | Each sub-phase is independently useful; no dependencies between 1A-1D |

---

## Success Criteria

When complete, the system should be able to:

1. **Process 10M+ token inputs** via the rlm-processor agent with automatic decomposition
2. **Iteratively explore memory** via recall_session + drill, following leads across sessions
3. **Extract more facts** from information-dense conversations via adaptive chunking
4. **Selectively traverse the knowledge graph** based on relevance criteria
5. **Store RLM findings** back into engram for future retrieval
6. **System-wide RLM awareness** via updated CLAUDE.md directives and skills
