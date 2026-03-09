# Phase 3: Unify Interfaces

**Master plan:** [MASTER-PLAN.md](./MASTER-PLAN.md)
**Status:** Not started
**Branch:** `phase-3/unify-interfaces` (from `refactor/src-extraction`)

## Entry Criteria

- [x] Phase 1 complete and merged to integration branch
- [x] All 671 tests pass on `refactor/src-extraction`

## Objective

Move `src/cli/`, `src/mcp/`, `src/web/` under `src/interfaces/`, extract shared business logic into a common operations layer, fix the CLI episodic-only search bug, and eliminate duplicated remember/dedup logic. After this phase, all user-facing interfaces share one code path for each operation.

## Current State (Post-Phase 1)

Three interface directories exist at the top level of `src/`:
- `src/cli/index.ts` (1,024 lines) — Commander-based CLI with 8 commands
- `src/mcp/server.ts` (728 lines) — MCP server with 5 tools
- `src/web/graph-server.ts` (4,250 lines) — Express web server (Phase 4 decomposition)

**Known issues:**
1. CLI `search` uses `searchEpisodic()` (episodic-only); MCP `recall` uses `searchMultiSource()` (all sources)
2. Remember/dedup logic duplicated between CLI (lines 109-183) and MCP (lines 396-449) — nearly identical code
3. MCP uses snake_case params (`source_exchanges`); CLI uses camelCase (`sourceExchanges`)
4. CLI commands: sync, remember, extract, search, dream, explore, reflect, doctor
5. MCP tools: recall, remember, show, explore, reflect
6. CLI has commands not in MCP (sync, extract, dream, doctor) and MCP has tools not in CLI (show)

## Tasks

### Task 3.1: Create interfaces/ directory structure

```
src/interfaces/
  shared/           ← shared business logic (operations layer)
    remember.ts     ← dedup + insert logic
    search.ts       ← unified search (wraps searchMultiSource)
    explore.ts      ← entity exploration
    reflect.ts      ← graph reflection
  cli/              ← src/cli/ moves here
  mcp/              ← src/mcp/ moves here
  web/              ← src/web/ moves here (untouched until Phase 4)
```

**Test:** Directory structure exists. No functional changes yet.

### Task 3.2: Extract shared remember logic

Create `src/interfaces/shared/remember.ts`:
```typescript
export interface RememberParams {
  content: string;
  type: MemoryType;
  importance: number;
}

export interface RememberResult {
  action: "created" | "updated";
  memoryId: string;
  content: string;
}

export async function rememberFact(
  db: Database,
  params: RememberParams
): Promise<RememberResult>
```

This function contains:
- Embed content
- Find nearest memories (top 3)
- Convert L2 distance to cosine similarity: `1 - (distance² / 2)`
- If similarity >= 0.95: recordAccess on existing, return "updated"
- Otherwise: insert new memory, return "created"

Extract from both CLI and MCP. Both currently use the same threshold (0.95), same neighbor count (3), same confidence (0.9).

**Test:** Unit tests for `rememberFact()`. CLI and MCP remember behavior unchanged.

### Task 3.3: Extract shared search logic

Create `src/interfaces/shared/search.ts`:
```typescript
export interface UnifiedSearchParams {
  query: string;
  sources?: SearchSource[];
  limit?: number;
  budget?: number;
  project?: string;
  since?: string;
}

export async function unifiedSearch(
  db: Database,
  params: UnifiedSearchParams
): Promise<RecallResponse>
```

This wraps `searchMultiSource()` from `_core/search/` with the interface-layer defaults. Both CLI and MCP will use this, fixing the CLI episodic-only bug.

**Test:** Unit tests for `unifiedSearch()`. CLI `search` now returns multi-source results.

### Task 3.4: Extract shared explore and reflect logic

Create `src/interfaces/shared/explore.ts` — wraps `exploreEntity()` from graph/search
Create `src/interfaces/shared/reflect.ts` — wraps graph reflection logic

These are thin wrappers that provide consistent interfaces for CLI and MCP.

**Test:** CLI and MCP explore/reflect behavior unchanged.

### Task 3.5: Move CLI to interfaces/cli/

Move `src/cli/index.ts` → `src/interfaces/cli/index.ts`

Update the CLI to:
- Import remember from `../shared/remember.js` (replaces inline dedup logic)
- Import search from `../shared/search.js` (replaces episodic-only searchEpisodic call)
- Import explore/reflect from `../shared/` (replaces direct domain imports)
- Update all relative import paths

Leave a re-export stub at `src/cli/index.ts` temporarily.

**Test:** All CLI tests pass. CLI `search` now uses multi-source search.

### Task 3.6: Move MCP to interfaces/mcp/

Move `src/mcp/server.ts` → `src/interfaces/mcp/server.ts`

Update the MCP server to:
- Import remember from `../shared/remember.js` (replaces inline dedup logic)
- Import search from `../shared/search.js`
- Import explore/reflect from `../shared/`
- Update all relative import paths

Leave a re-export stub at `src/mcp/server.ts` temporarily.

**Test:** All MCP tests pass.

### Task 3.7: Move web to interfaces/web/

Move `src/web/graph-server.ts` → `src/interfaces/web/graph-server.ts`

This is a pure file move — no internal refactoring (that's Phase 4). Update import paths only.

Leave a re-export stub at `src/web/graph-server.ts` temporarily.

**Test:** Web server starts correctly (if testable).

### Task 3.8: Remove old directories and stubs

- Update all remaining imports pointing to old `src/cli/`, `src/mcp/`, `src/web/` paths
- Remove re-export stubs
- Remove empty `src/cli/`, `src/mcp/`, `src/web/` directories
- Update `package.json` bin entry if it references `src/cli/index.ts`
- Update any launch configs, scripts, or plist files that reference old paths

**Test:** Full suite green. `grep -r "from.*['\"].*\/(cli|mcp|web)\/" src/` returns zero hits (excluding interfaces/).

### Task 3.9: Document parameter naming convention

Add to `decisions/008-parameter-naming.md`:
- Internal code uses camelCase (TypeScript convention)
- MCP tool parameters use snake_case (MCP convention)
- Shared operations layer uses camelCase internally
- MCP adapter layer translates snake_case ↔ camelCase at the boundary

**Test:** N/A (documentation only).

### Task 3.10: Final verification

- Run full test suite
- Verify CLI `search` uses `searchMultiSource` (not `searchEpisodic`)
- Verify remember logic exists in one place only
- Verify no code remains in old `src/cli/`, `src/mcp/`, `src/web/` directories

## Agent Assignment

| Task | Notes |
|------|-------|
| 3.1 | Directory creation — trivial |
| 3.2 | Shared remember — extract + test |
| 3.3 | Shared search — extract + fix CLI bug |
| 3.4 | Shared explore/reflect — thin wrappers |
| 3.5 | CLI move — update imports + use shared ops |
| 3.6 | MCP move — update imports + use shared ops |
| 3.7 | Web move — pure file move |
| 3.8 | Cleanup — remove stubs and old dirs |
| 3.9 | ADR — documentation |
| 3.10 | Verification — static analysis + tests |

Tasks 3.1 first. Then 3.2-3.4 (shared logic extraction). Then 3.5-3.7 (moves). Then 3.8-3.10 (cleanup).

## Test Strategy

- After each task: run `npx vitest run --dir tests` — all tests must pass
- After all tasks: run full contract suite `npx vitest run tests/contracts/`
- New shared operation tests added in Tasks 3.2-3.4
- CLI search behavior test: verify multi-source results returned

## Exit Criteria

- [ ] All 671+ tests pass
- [ ] CLI `search` and MCP `recall` use same search path (`searchMultiSource`)
- [ ] `remember` dedup logic exists in one place (`interfaces/shared/remember.ts`)
- [ ] `src/cli/`, `src/mcp/`, `src/web/` directories removed
- [ ] All interface code lives under `src/interfaces/`
- [ ] Parameter naming convention documented in ADR-008
- [ ] No duplicated business logic between CLI and MCP

## Next Phase

Upon exit criteria met: merge `phase-3/unify-interfaces` → `refactor/src-extraction`. When Phase 2 also merges, begin [Phase 4](./phase-4-plan.md).
