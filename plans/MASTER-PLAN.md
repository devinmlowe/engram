# Master Plan: SRC Extraction Refactor

## Overview

Refactor engram's vibe-coded architecture to conform to the SRC specification hierarchy established in the L0/L1 specs and ADRs. All work occurs on the `refactor/src-extraction` branch; nothing merges to `main` until all phases complete and pass full regression.

## Branch Strategy

```
main (frozen during refactor)
 └── refactor/src-extraction (integration branch)
      ├── phase-1/core-extraction (worktree)
      ├── phase-2/thin-dal (worktree, after Phase 1 merges to integration)
      ├── phase-3/unify-interfaces (worktree, parallel with Phase 2)
      └── phase-4/decompose-graph-server (worktree, after Phases 2+3 merge)
```

Each phase worktree merges back to `refactor/src-extraction` upon exit criteria passing. Phases 2 and 3 run in parallel after Phase 1 completes.

## Test Baseline

- **671 tests** (583 original + 88 contract tests) — all must pass at every phase boundary
- Contract tests in `tests/contracts/` pin: embedding singleton lifecycle, score math (exact numerical), config defaults, search orchestration, LLM cascade, DB schema
- Each phase adds tests specific to its changes; these become part of the baseline for subsequent phases

## Phases

### [Phase 1: Extract _core/ Shared Services](./phase-1-plan.md)

**Status:** COMPLETE (merged to integration branch)
**Depends on:** Nothing (first phase)
**Resolves issues:** 1, 6, 7, 8, 9, 16, 19, 20 (9 of 21 structural issues)

Extract misplaced shared services from domain directories into `_core/`:
- `episodic/embeddings.ts` → `_core/embeddings/`
- `rrfFuse()`, `normalizeMinMaxFloored()`, `searchMultiSource()`, `formatRecallXml()` from `episodic/search.ts` → `_core/search/`
- `dream/intelligence.ts` + `core/openrouter.ts` → `_core/llm/`
- Split `core/types.ts` → domain types to domains, shared types to `_core/types/`
- `core/config.ts` → `_core/config/`
- `core/cache.ts` → `_core/cache/`

**Exit criteria:**
- All 671+ tests pass with updated import paths
- No circular dependencies remain
- `_core/` modules have zero imports from domain directories
- Every domain imports shared services from `_core/`, not from other domains

---

### [Phase 2: Thin Data Access Layer](./phase-2-plan.md)

**Status:** COMPLETE (merged to integration branch)
**Depends on:** Phase 1 complete and merged to integration branch
**Resolves issues:** 5, 18

Implement thin DAL in `_core/db/`:
- Typed query helpers (getById, search, upsert, transaction wrapping)
- Domains migrate raw SQL to use DAL helpers where applicable
- Complex queries remain as raw SQL but go through DAL connection

**Exit criteria:**
- All tests pass (baseline + new DAL tests)
- No domain directly calls `initDatabase()` — all access through `_core/db/`
- Schema ownership is solely in `_core/db/`
- At least 3 domains migrated to DAL helpers for common patterns

---

### [Phase 3: Unify Interfaces](./phase-3-plan.md)

**Status:** COMPLETE (merged to integration branch)
**Depends on:** Phase 1 complete and merged to integration branch
**Runs in parallel with:** Phase 2
**Resolves issues:** 12, 14, 21

Move `src/cli/`, `src/mcp/`, `src/web/` under `interfaces/`:
- CLI search uses `searchMultiSource()` (fixes episodic-only bug)
- Shared `remember` dedup logic (no duplication between CLI and MCP)
- Consistent parameter naming convention documented
- Web interface structured under `interfaces/web/`

**Exit criteria:**
- All tests pass (baseline + new interface tests)
- CLI `search` and MCP `recall` use same search path
- `remember` dedup logic exists in one place, used by both CLI and MCP
- `src/cli/`, `src/mcp/`, `src/web/` directories removed; code lives under `interfaces/`

---

### [Phase 4: Decompose graph-server.ts](./phase-4-plan.md)

**Status:** In progress
**Depends on:** Phases 2 and 3 complete and merged to integration branch
**Resolves issues:** 3, 5 (partially, web-specific SQL)

Break the 4,250-line monolith into focused modules:
- Route handlers separated by concern (graph API, word cloud API, SSE, dream trigger)
- Graph algorithms delegated to graph domain instead of inline computation
- DB access through `_core/db/` DAL instead of raw SQL
- Dream triggering through dream domain's public interface

**Exit criteria:**
- All tests pass (baseline + new web interface tests)
- `graph-server.ts` no longer exists as a single file
- No route handler exceeds 300 lines
- All DB access goes through `_core/db/` or domain APIs
- Dream triggering uses dream domain's public interface, not process spawning

---

## Phase Execution Protocol

For each phase:

1. **Plan** — Generate detailed `phase-N-plan.md` with entry criteria, tasks, test strategy, exit criteria
2. **Verify entry criteria** — Confirm all dependencies are met
3. **Create worktree** — Branch from `refactor/src-extraction`
4. **Execute** — Delegate to focused sub-agents via team; coordinator does not write code
5. **Test** — Run full test suite; all tests must pass
6. **Review** — Verify exit criteria against plan
7. **Merge** — Merge phase worktree back to `refactor/src-extraction`
8. **Update** — Mark phase complete in this master plan

## Dependency Graph

```
Phase 1 ─┬── Phase 2 ──┬── Phase 4
          └── Phase 3 ──┘
```

Phases 2 and 3 are independent and run in parallel. Phase 4 depends on both.

## Final Integration

After all phases complete:
- Full test suite passes on `refactor/src-extraction`
- Manual smoke test of MCP server, CLI commands, dream pipeline, web visualizer
- Merge `refactor/src-extraction` → `main`

## Related Documents

- [L0 SPEC.md](../SPEC.md) — System specification
- [decisions/](../decisions/) — Architecture Decision Records (001-007)
- [tests/contracts/](../tests/contracts/) — Regression contract tests
