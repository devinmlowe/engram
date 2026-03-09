# Phase 1: Extract _core/ Shared Services

**Master plan:** [MASTER-PLAN.md](./MASTER-PLAN.md)
**Status:** Not started
**Branch:** `phase-1/core-extraction` (from `refactor/src-extraction`)

## Entry Criteria

- [x] All 671 tests pass on `refactor/src-extraction`
- [x] SRC specs and ADRs committed (L0, L1, _core/ module specs)
- [x] Contract tests pinning current behavior committed
- [x] No uncommitted changes on integration branch

## Objective

Extract misplaced shared services from domain directories into `_core/` modules, breaking circular dependencies and establishing clean domain boundaries. After this phase, every domain imports shared infrastructure from `_core/`; `_core/` imports from no domain.

## Tasks

### Task 1.1: Create _core/ directory structure under src/

Create the physical directories that mirror the spec:

```
src/_core/
  config/     ← src/core/config.ts
  db/         ← src/core/db.ts
  types/      ← src/core/types.ts (shared types only)
  cache/      ← src/core/cache.ts
  embeddings/ ← src/episodic/embeddings.ts
  search/     ← episodic/search.ts (shared functions only)
  llm/        ← dream/intelligence.ts + core/openrouter.ts
```

**Test:** Directory structure exists. No functional changes yet.

### Task 1.2: Move config, cache, db to _core/

Move `src/core/config.ts` → `src/_core/config/index.ts`
Move `src/core/cache.ts` → `src/_core/cache/index.ts`
Move `src/core/db.ts` → `src/_core/db/index.ts`

Update all import paths across the codebase. Leave re-export stubs at old paths temporarily for safety, then remove once all imports are updated.

**Test:** `tests/contracts/config-defaults.test.ts` passes. `tests/contracts/db-schema.test.ts` passes. `tests/core/cache.test.ts` passes. Full suite green.

### Task 1.3: Split core/types.ts into shared + domain types

Extract from `src/core/types.ts`:

**Stays in `src/_core/types/index.ts` (cross-domain):**
- `SearchMode`, `SearchSource`, `SearchOptions`, `SearchResult`, `RecallResponse`
- `EngramConfig`, `RerankerConfig`

**Moves to `src/episodic/types.ts`:**
- `Exchange`, `ToolCall`, `Conversation`

**Moves to `src/semantic/types.ts` (already partially exists):**
- `MemoryType`, `Memory`, `Conflict`

**Moves to `src/dream/types.ts`:**
- `DreamPhase`, `DreamProgress`, `DreamReport`

**Already exists in `src/graph/types.ts`:**
- `EntityType`, `Entity`, `RelationshipType`, `Relationship`, `TopicCluster`

Update all import paths. The key constraint: no domain imports types from another domain — only from `_core/types/` or its own types.

**Test:** `tests/contracts/config-defaults.test.ts` passes (EngramConfig still works). Full suite green. Verify with grep that no domain imports types from another domain's types file.

### Task 1.4: Extract embeddings to _core/embeddings/

Move `src/episodic/embeddings.ts` → `src/_core/embeddings/index.ts`

Update imports in all consumers:
- `src/episodic/search.ts`
- `src/episodic/sync.ts`
- `src/episodic/store.ts`
- `src/mcp/server.ts`
- `src/graph/resolver.ts`
- `src/semantic/search.ts`
- `src/semantic/consolidator.ts`
- All test files that import embeddings

**Test:** `tests/contracts/embedding-singleton.test.ts` passes (all 17 tests). Singleton behavior preserved. Full suite green.

### Task 1.5: Extract search utilities to _core/search/

From `src/episodic/search.ts`, extract to `src/_core/search/`:

**`src/_core/search/rrf.ts`:**
- `rrfFuse()`
- `normalizeMinMaxFloored()`

**`src/_core/search/orchestrator.ts`:**
- `searchMultiSource()`
- `budgetResults()` (deprecated wrapper)

**`src/_core/search/format.ts`:**
- `formatRecallXml()`
- `formatSemanticXml()`
- `formatGraphXml()`
- `escapeXml()`

**`src/_core/search/index.ts`:**
- Re-exports all public functions

**Remains in `src/episodic/search.ts`:**
- `searchEpisodic()` (domain-specific)
- `vectorSearch()`, `ftsSearch()`, `fetchExchanges()` (episodic internals)
- `buildDateFilter()` (episodic internal)

Move `src/retrieval/context.ts` → `src/_core/search/budget.ts`
Move `src/retrieval/reranker.ts` → `src/_core/search/reranker.ts`

Update all import paths.

**Test:** `tests/contracts/score-math.test.ts` passes (exact numerical pinning). `tests/contracts/search-orchestration.test.ts` passes. Full suite green.

### Task 1.6: Extract LLM to _core/llm/

Merge `src/dream/intelligence.ts` + `src/core/openrouter.ts` → `src/_core/llm/`:

**`src/_core/llm/providers/ollama.ts`:**
- `isOllamaAvailable()`
- `ollamaGenerateStructured()`
- `ollamaGenerate()`

**`src/_core/llm/providers/openrouter.ts`:**
- All of current `core/openrouter.ts`
- `openrouterGenerateStructured()`
- `openrouterGenerate()`

**`src/_core/llm/providers/anthropic.ts`:**
- `apiGenerateStructured()`
- `apiGenerate()`
- Client management (`getClient`, `setClient`, `resetIntelligence`)

**`src/_core/llm/index.ts`:**
- `generate()`
- `generateStructured()`
- `buildIntelligenceConfig()`
- Types: `IntelligenceConfig`, `GenerationResult`
- Re-exports of `setClient`, `resetIntelligence` (for testing)

Update all import paths. Key consumers:
- `src/dream/daemon.ts` — uses generate/generateStructured
- `src/graph/reflection.ts` — imports buildIntelligenceConfig, generate
- `src/graph/naming.ts` — imports generate
- `src/semantic/extractor.ts` — uses Anthropic client directly (must migrate to _core/llm)
- `src/graph/extractor.ts` — uses Anthropic client directly (must migrate to _core/llm)

**Test:** `tests/contracts/llm-cascade.test.ts` passes (all 12 tests). Full suite green.

### Task 1.7: Remove old src/core/ and src/retrieval/ directories

After all extractions complete:
- Remove `src/core/` (now empty or only re-export stubs)
- Remove `src/retrieval/` (now empty)
- Remove any temporary re-export stubs
- Verify no imports reference old paths

**Test:** Full suite green. `grep -r "from.*['\"]\.\.\/core\/" src/` returns zero hits. `grep -r "from.*['\"]\.\.\/retrieval\/" src/` returns zero hits.

### Task 1.8: Remove chunkConversation re-export from graph

`src/graph/extractor.ts` re-exports `chunkConversation` from `src/semantic/extractor.ts`. This cross-domain re-export violates boundaries.

Move `chunkConversation()` to `src/_core/search/text.ts` (or `src/_core/text/index.ts` if we create a text utilities module). Update both `semantic/extractor.ts` and `graph/extractor.ts` to import from the shared location.

**Test:** Full suite green. No cross-domain re-exports remain.

### Task 1.9: Verify no circular dependencies

Run a dependency check to confirm:
- `_core/` has zero imports from `episodic/`, `semantic/`, `graph/`, `dream/`, `interfaces/`
- No domain imports from another domain (except through `_core/`)
- The circular dependency chain (episodic/search → semantic/search → episodic/embeddings) is broken

**Test:** Static analysis. Write a simple script or test that parses imports and flags violations.

## Agent Assignment

| Task | Agent | Notes |
|------|-------|-------|
| 1.1 | setup-agent | Directory creation, no code changes |
| 1.2 | config-mover | Move + update imports for config, cache, db |
| 1.3 | type-splitter | Split types, update all imports |
| 1.4 | embeddings-mover | Move embeddings, update all consumers |
| 1.5 | search-extractor | Most complex task — splitting a file |
| 1.6 | llm-extractor | Merge two files into provider structure |
| 1.7 | cleanup-agent | Remove old directories and stubs |
| 1.8 | boundary-fixer | Fix chunkConversation re-export |
| 1.9 | validator | Dependency check and final verification |

Tasks 1.1 must run first. Tasks 1.2, 1.3, 1.4, 1.5, 1.6 can partially overlap but must coordinate on shared files (especially types). Tasks 1.7, 1.8, 1.9 run after all moves complete.

## Test Strategy

- After each task: run `npx vitest run --dir tests` — all tests must pass
- After all tasks: run full contract suite `npx vitest run tests/contracts/`
- Final check: dependency analysis (no circular deps, no domain→domain imports)

## Exit Criteria

- [ ] All 671+ tests pass
- [ ] `src/_core/` contains: config/, db/, types/, cache/, embeddings/, search/, llm/
- [ ] `src/core/` directory removed
- [ ] `src/retrieval/` directory removed
- [ ] No circular dependencies
- [ ] No domain imports shared services from another domain
- [ ] `_core/` has zero imports from domain directories
- [ ] `chunkConversation` no longer re-exported across domain boundaries
- [ ] All contract tests pass with updated import paths

## Next Phase

Upon exit criteria met: merge `phase-1/core-extraction` → `refactor/src-extraction`, then begin [Phase 2](./phase-2-plan.md) and [Phase 3](./phase-3-plan.md) in parallel.
