# Phase 2: Thin Data Access Layer

**Master plan:** [MASTER-PLAN.md](./MASTER-PLAN.md)
**Status:** Not started
**Branch:** `phase-2/thin-dal` (from `refactor/src-extraction`)

## Entry Criteria

- [x] Phase 1 complete and merged to integration branch
- [x] All 671 tests pass on `refactor/src-extraction`
- [x] ADR-004 (thin DAL) committed and accepted

## Objective

Implement a thin data access layer in `_core/db/` that provides typed query helpers, transaction management, and connection abstraction. Migrate domains from raw SQL to DAL helpers for common patterns while preserving raw SQL escape hatch for complex queries.

After this phase, no domain directly calls `initDatabase()` — all DB access flows through `_core/db/` helpers or explicit connection access.

## Current State (Post-Phase 1)

`src/_core/db/index.ts` currently exports only:
- `initDatabase(config)` → creates DB, runs schema, returns raw `Database` instance
- `rebuildFts(db, table)` → FTS rebuild helper

16 files across 7 domains execute raw SQL via `db.prepare()`:
- `episodic/store.ts` — INSERT exchanges, tool_calls, conversations; SELECT; vec_exchanges
- `episodic/search.ts` — SELECT exchanges, vec_exchanges, exchanges_fts
- `semantic/memory.ts` — INSERT/SELECT/UPDATE memories, vec_memories, memories_fts
- `semantic/search.ts` — SELECT memories, vec_memories, memories_fts
- `graph/entity.ts` — INSERT/SELECT/UPDATE entities, vec_entities
- `graph/relationship.ts` — INSERT/SELECT/UPDATE relationships
- `graph/search.ts` — SELECT entities, relationships, vec_entities, entities_fts
- `graph/naming.ts` — SELECT entities (name queries)
- `graph/reflection.ts` — INSERT/SELECT bridge_scores, temporal_patterns, reflection_observations, topic_clusters
- `graph/temporal.ts` — SELECT entities, relationships (temporal analysis)
- `graph/analyzer.ts` — SELECT entities, relationships, topic_clusters (community detection)
- `dream/daemon.ts` — INSERT/SELECT/UPDATE dream_runs, dream_checkpoints
- `dream/scheduler.ts` — SELECT dream_runs
- `cli/index.ts` — SELECT exchanges (stats), direct initDatabase call
- `mcp/server.ts` — direct initDatabase call
- `web/graph-server.ts` — extensive raw SQL (deferred to Phase 4)

## Tasks

### Task 2.1: Create DAL helpers in _core/db/

Create typed helper modules:

**`src/_core/db/connection.ts`:**
- `getDatabase(config?)` — singleton connection manager (replaces direct `initDatabase` calls)
- `closeDatabase()` — graceful shutdown
- `withTransaction<T>(db, fn)` — transaction wrapper with automatic commit/rollback

**`src/_core/db/helpers.ts`:**
- `getById<T>(db, table, id)` — typed single-row fetch
- `getAll<T>(db, table, where?, orderBy?)` — typed multi-row fetch
- `insertRow(db, table, data)` — typed insert
- `updateRow(db, table, id, data)` — typed partial update
- `upsertRow(db, table, data, conflictColumns)` — typed upsert
- `deleteRow(db, table, id)` — typed delete
- `count(db, table, where?)` — count helper

**`src/_core/db/vector.ts`:**
- `insertVector(db, table, id, embedding)` — typed vector insert
- `searchVector(db, table, queryEmbedding, limit)` — typed vector search
- `deleteVector(db, table, id)` — typed vector delete

**`src/_core/db/fts.ts`:**
- `searchFts(db, table, query, limit)` — typed FTS5 search
- `syncFts(db, table, id, content)` — manual FTS sync for content tables
- `rebuildFts(db, table)` — (already exists, move here)

**`src/_core/db/index.ts`:**
- Re-export all helpers plus `initDatabase` and schema

**Test:** New DAL tests pass. Existing tests still pass. No functional changes to domains yet.

### Task 2.2: Migrate episodic domain to DAL helpers

Update `src/episodic/store.ts` and `src/episodic/search.ts`:
- Replace `db.prepare("INSERT INTO exchanges...")` with `insertRow(db, "exchanges", data)`
- Replace vector operations with `insertVector`/`searchVector`
- Replace FTS operations with `searchFts`
- Keep complex hybrid search queries (vector + FTS + RRF) as raw SQL — they're too domain-specific

**Test:** `tests/episodic/` all pass. `tests/contracts/search-orchestration.test.ts` passes. `tests/contracts/embedding-singleton.test.ts` passes.

### Task 2.3: Migrate semantic domain to DAL helpers

Update `src/semantic/memory.ts` and `src/semantic/search.ts`:
- Replace memory CRUD with DAL helpers
- Replace vector operations with `insertVector`/`searchVector`
- Keep consolidation-specific queries as raw SQL

**Test:** `tests/semantic/` all pass.

### Task 2.4: Migrate graph domain to DAL helpers

Update `src/graph/entity.ts`, `src/graph/relationship.ts`, `src/graph/search.ts`:
- Replace entity/relationship CRUD with DAL helpers
- Replace vector operations with `insertVector`/`searchVector`
- Keep graph traversal queries and community detection as raw SQL (too complex for helpers)

**Test:** `tests/graph/` all pass.

### Task 2.5: Migrate dream domain to DAL helpers

Update `src/dream/daemon.ts` and `src/dream/scheduler.ts`:
- Replace dream_runs/dream_checkpoints CRUD with DAL helpers
- Replace checkpoint queries with DAL

**Test:** `tests/dream/` all pass.

### Task 2.6: Create singleton connection manager

Replace direct `initDatabase()` calls in consumers:
- `src/cli/index.ts` — use `getDatabase()` instead of `initDatabase(config)`
- `src/mcp/server.ts` — use `getDatabase()` instead of lazy `initDatabase(config)`
- Leave `src/web/graph-server.ts` untouched (Phase 4 scope)

**Test:** Full suite green. `grep -r "initDatabase" src/` shows only `_core/db/` and `web/graph-server.ts`.

### Task 2.7: Final verification

- Run full test suite
- Verify no domain imports `initDatabase` directly (except web/graph-server.ts which is Phase 4)
- Verify schema ownership is solely in `_core/db/`
- Count domains using DAL helpers (target: at least 3)

## Agent Assignment

| Task | Notes |
|------|-------|
| 2.1 | Create DAL module — most complex, foundation for all others |
| 2.2 | Episodic migration — moderate, has vector + FTS |
| 2.3 | Semantic migration — straightforward CRUD |
| 2.4 | Graph migration — largest domain, many files |
| 2.5 | Dream migration — smallest, simple CRUD |
| 2.6 | Connection manager — small but touches CLI and MCP |
| 2.7 | Verification — static analysis + tests |

Tasks must run sequentially: 2.1 first (creates the helpers), then 2.2-2.5 (migrations), then 2.6-2.7 (cleanup).

## Test Strategy

- After each task: run `npx vitest run --dir tests` — all tests must pass
- After all tasks: run full contract suite `npx vitest run tests/contracts/`
- New DAL-specific tests added in Task 2.1

## Exit Criteria

- [ ] All 671+ tests pass
- [ ] `_core/db/` exports typed helpers: getById, insertRow, updateRow, upsertRow, withTransaction
- [ ] `_core/db/` exports vector helpers: insertVector, searchVector
- [ ] `_core/db/` exports FTS helpers: searchFts, rebuildFts
- [ ] No domain directly calls `initDatabase()` (except web/graph-server.ts — Phase 4)
- [ ] Schema ownership is solely in `_core/db/`
- [ ] At least 3 domains migrated to DAL helpers for common patterns
- [ ] Complex queries remain as raw SQL (no over-abstraction)

## Next Phase

Upon exit criteria met: merge `phase-2/thin-dal` → `refactor/src-extraction`. When Phase 3 also merges, begin [Phase 4](./phase-4-plan.md).
