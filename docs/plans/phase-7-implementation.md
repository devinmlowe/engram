# Phase 7: Optimization & Polish — Implementation Plan

**Date:** 2026-02-26
**Goal:** Feature-complete per SPEC.md, production-ready Claude Code plugin
**Exit Criteria:**
1. All SPEC.md features implemented across all phases
2. TypeScript compiles cleanly (`tsc --noEmit` passes)
3. All tests pass (`vitest run` — 0 failures)
4. No dead code (unused exports, orphan files)
5. MCP server installable as Claude Code plugin
6. Dream state daemon installable and runnable via launchd
7. End-to-end test coverage validates full pipeline
8. Interface documentation in `/docs/`

**Research References:**
- [Phase 7 Optimization Patterns](../research/phase-7-optimization-patterns.md)
- [Claude Code Plugin Packaging](../research/claude-code-plugin-packaging.md)
- [Phase 7 Readiness Assessment](../phase-7-readiness.md)

---

## Task Breakdown

### Task 1: Fix TypeScript Compilation (PREREQUISITE — blocks everything)

**Files:** `src/dream/intelligence.ts`, `src/graph/analyzer.ts`, `src/graph/extractor.ts`, `src/semantic/extractor.ts`, `src/semantic/consolidator.ts`

**Work:**
1. Install missing type declarations: `npm i -D @types/better-sqlite3` (already present — check `@anthropic-ai/sdk` types)
2. Fix 4 module resolution errors for `@anthropic-ai/sdk`:
   - The SDK should ship its own types. If not, add a `declarations.d.ts` shim.
3. Fix 3 module resolution errors for `graphology` ecosystem:
   - Add `src/types/graphology.d.ts` with ambient module declarations for `graphology`, `graphology-communities-louvain`, `graphology-metrics/centrality/betweenness.js`
4. Fix 18 implicit `any` parameters:
   - `analyzer.ts` lines 91, 154, 190, 222, 230 — add explicit types
   - `intelligence.ts` lines 299, 346 — type the `block` parameter from Anthropic API response
   - `extractor.ts` (graph) lines 436, 473 — type the `block` parameter
   - `extractor.ts` (semantic) lines 356, 406 — type the `block` parameter
   - `consolidator.ts` line 387 — type the `block` parameter
5. Verify: `npx tsc --noEmit` exits 0

**Dependencies:** None
**Estimated time:** 1 hour

---

### Task 2: Implement Cross-Encoder Reranking

**New files:** `src/retrieval/reranker.ts`
**Modified files:** `src/episodic/search.ts`, `src/core/config.ts`, `src/core/types.ts`

**Work:**
1. Create `src/retrieval/reranker.ts`:
   - Singleton model loader for `Xenova/bge-reranker-base` via `@xenova/transformers`
   - `initReranker()` — lazy model loading
   - `rerankResults(query: string, candidates: SearchResult[], topK?: number): Promise<SearchResult[]>`
   - Batch inference: pass all query-candidate pairs in one forward pass
   - Score normalization: min-max normalize cross-encoder scores to 0-1
   - Optional score blending: `final = 0.7 * reranker + 0.3 * rrf` (configurable)
   - Ref: [phase-7-optimization-patterns.md §1.5](../research/phase-7-optimization-patterns.md)

2. Update `src/core/types.ts`:
   - Add `RerankerConfig` interface: `{ enabled: boolean; model: string; topK: number; blendWeight: number }`
   - Extend `EngramConfig.search` with `reranker: RerankerConfig`

3. Update `src/core/config.ts`:
   - Add reranker defaults: `{ enabled: true, model: 'Xenova/bge-reranker-base', topK: 5, blendWeight: 0.7 }`
   - Support `ENGRAM_RERANK_ENABLED` env var

4. Integrate into `src/episodic/search.ts`:
   - After RRF fusion in `searchMultiSource()`, if `config.search.reranker.enabled`:
     - Take top 20 RRF results
     - Call `rerankResults(query, top20, topK)`
     - Replace results with reranked order
   - Graceful degradation: if reranker model fails to load, continue without reranking

5. Tests: `tests/retrieval/reranker.test.ts`
   - Mock model for unit tests
   - Verify score normalization
   - Verify blending formula
   - Integration test with search pipeline

**Dependencies:** Task 1
**Estimated time:** 4 hours

---

### Task 3: Context Budget Optimization

**New files:** `src/retrieval/context.ts`
**Modified files:** `src/episodic/search.ts`, `src/mcp/server.ts`

**Work:**
1. Create `src/retrieval/context.ts`:
   - `allocateBudget(results: SearchResult[], budget: number, config: BudgetConfig): SearchResult[]`
   - Priority ordering: semantic memories > graph entities > conversation summaries > raw exchanges
   - Token estimation improvement: use char/4 heuristic with a 1.1x safety factor
   - Greedy fill with priority classes
   - Ref: [phase-7-optimization-patterns.md §2](../research/phase-7-optimization-patterns.md)

2. Update `formatRecallXml()` in `src/episodic/search.ts`:
   - Move budget enforcement to `context.ts` module
   - Keep XML formatting in search.ts

3. Update MCP server recall handler:
   - Use `allocateBudget()` for budget enforcement
   - Add `tokensUsed` and `totalResults` to XML output metadata

4. Tests: `tests/retrieval/context.test.ts`

**Dependencies:** Task 1
**Estimated time:** 2 hours

---

### Task 4: Performance Optimization

**New files:** `src/core/cache.ts`
**Modified files:** `src/episodic/search.ts`, `src/episodic/embeddings.ts`, `src/graph/analyzer.ts`

**Work:**
1. Create `src/core/cache.ts`:
   - Simple LRU cache with TTL: `LRUCache<K, V>` class
   - Configurable maxSize and TTL (default: 100 entries, 5 min TTL)
   - Used for: query embedding cache, search result cache, graph analysis cache

2. Add embedding cache in `src/episodic/embeddings.ts`:
   - Cache embeddings by content hash (SHA-256 of first 200 chars)
   - Avoids re-embedding identical queries within a session

3. Add search result cache in `src/episodic/search.ts`:
   - Cache by `JSON.stringify(searchOptions)` → `RecallResponse`
   - Short TTL (60s) since results can change during dream processing

4. Cache graph analysis results in `src/graph/analyzer.ts`:
   - Community detection is expensive — cache for 5 minutes
   - Invalidate on graph mutation (entity/relationship insert)

5. Add SQLite PRAGMA tuning in `src/core/db.ts` (verify existing):
   - `PRAGMA journal_mode = WAL` ✓ (already set)
   - `PRAGMA synchronous = NORMAL` ✓ (already set)
   - Add: `PRAGMA mmap_size = 268435456` (256MB memory-mapped I/O)
   - Add: `PRAGMA cache_size = -64000` (64MB page cache)
   - Ref: [phase-7-optimization-patterns.md §4](../research/phase-7-optimization-patterns.md)

6. Tests: `tests/core/cache.test.ts`

**Dependencies:** Task 1
**Estimated time:** 3 hours

---

### Task 5: Plugin Packaging & `mcp` CLI Subcommand

**New files:** `.claude-plugin/plugin.json`, `.mcp.json`
**Modified files:** `src/cli/index.ts`, `package.json`

**Work:**
1. Add `mcp` subcommand to CLI (`src/cli/index.ts`):
   ```typescript
   program
     .command("mcp")
     .description("Start MCP server (stdio transport)")
     .action(async () => {
       await import("../mcp/server.js");
     });
   ```

2. Update `package.json`:
   - Add `"files": ["dist", "prompts", "launchd", ".claude-plugin", ".mcp.json"]`
   - Add `"prepare": "npm run build"`
   - Update build: `"build": "tsc"`
   - Verify `"bin": { "engram": "dist/cli/index.js" }`

3. Create `.mcp.json` at project root:
   ```json
   {
     "mcpServers": {
       "engram": {
         "command": "node",
         "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"],
         "env": {}
       }
     }
   }
   ```

4. Create `.claude-plugin/plugin.json`:
   ```json
   {
     "name": "engram",
     "version": "0.1.0",
     "description": "Cognitive memory system — episodic storage, semantic extraction, knowledge graph, and dream-state consolidation",
     "author": { "name": "Devin Lowe" },
     "license": "MIT",
     "mcpServers": ".mcp.json"
   }
   ```

5. Verify shebang lines exist on both entry points:
   - `src/cli/index.ts` line 1: `#!/usr/bin/env node` ✓
   - `src/mcp/server.ts` line 1: `#!/usr/bin/env node` ✓

6. Test: build and verify `node dist/cli/index.js mcp` starts the MCP server

**Dependencies:** Task 1
**Estimated time:** 2 hours
**Ref:** [claude-code-plugin-packaging.md](../research/claude-code-plugin-packaging.md)

---

### Task 6: Documentation

**New files:**
- `docs/user-guide.md` — Getting started, installation, basic workflows
- `docs/api-reference.md` — MCP tools (recall, remember, show, explore, reflect), CLI commands
- `docs/architecture.md` — Layer diagram, data flow, module responsibilities
- `prompts/summarize.md` — Conversation summarization prompt template
- `prompts/reflect.md` — Reflection observation prompt template

**Work:**
1. `docs/user-guide.md`:
   - Prerequisites (Node.js 22+, Ollama optional)
   - Installation methods (npm global, npx, from source)
   - First-time setup (`engram init`, `engram migrate`)
   - Daily usage (recall, remember, dream)
   - Claude Code integration (MCP server setup)
   - Dream state configuration (launchd)
   - Environment variables reference

2. `docs/api-reference.md`:
   - MCP tool schemas (input/output for each tool)
   - CLI command reference (all 12 commands with options)
   - Configuration reference (EngramConfig fields)
   - Environment variables

3. `docs/architecture.md`:
   - System diagram (ASCII from SPEC.md)
   - Layer interactions
   - Data flow: conversation → episodic → semantic → graph
   - Dream pipeline phases
   - Search pipeline: query → embed → vector+BM25 → RRF → rerank → budget → format

4. `prompts/summarize.md` — Template for conversation summarization
5. `prompts/reflect.md` — Template for generating reflection observations

**Dependencies:** Tasks 2, 3 (need final API surface)
**Estimated time:** 4 hours

---

### Task 7: Dead Code Audit & Cleanup

**Work:**
1. Scan for unused exports across all `src/` files
2. Check for orphan type definitions in `types.ts` files
3. Remove any TODO/FIXME stubs that should have been resolved
4. Verify no duplicate functionality between modules
5. Clean up any worktree artifacts in `.claude/worktrees/`
6. Verify `.gitignore` covers: `dist/`, `node_modules/`, `*.db`, `.env`

**Dependencies:** Tasks 1-6
**Estimated time:** 1 hour

---

### Task 8: End-to-End Test Coverage

**New files:** `tests/e2e/full-pipeline.test.ts`, `tests/e2e/mcp-server.test.ts`

**Work:**
1. `tests/e2e/full-pipeline.test.ts`:
   - Create temp DB → sync test conversation → embed → search → verify results
   - Extract facts → consolidate → verify semantic memories created
   - Extract entities → resolve → verify graph built
   - Run dream pipeline → verify all phases complete
   - Test decay model → verify confidence changes over time

2. `tests/e2e/mcp-server.test.ts`:
   - Start MCP server programmatically
   - Send `tools/list` → verify 5 tools
   - Send `recall` call → verify XML response format
   - Send `remember` call → verify memory stored
   - Send `explore` call → verify graph response
   - Send `reflect` call → verify reflection output

3. Fix existing test timeouts:
   - `tests/dream/intelligence.test.ts` — increase timeout or mock model loading
   - Verify all 52 test suites pass

**Dependencies:** Tasks 1-7
**Estimated time:** 4 hours

---

### Task 9: Install Plugin to Global Claude Instance

**Work:**
1. Build the project: `npm run build`
2. Verify build output: `ls dist/`
3. Register MCP server with Claude Code:
   ```bash
   claude mcp add --transport stdio --scope user engram -- \
     node /Users/USER/Documents/git/engram/dist/mcp/server.js
   ```
4. Verify tools appear: start Claude Code, check `/mcp`
5. Test recall tool with a real query
6. Test remember tool

**Dependencies:** Tasks 1-8
**Estimated time:** 30 minutes

---

### Task 10: Install and Start Dream State Daemon

**Work:**
1. Run the install script: `./scripts/install-daemon.sh install`
2. Verify launchd plist: `launchctl list | grep engram`
3. Run initial dream cycle: `engram dream --verbose`
4. Verify daemon logs: `tail -f ~/.local/share/engram/logs/dream.log`
5. Verify scheduled execution time (2 AM default)

**Dependencies:** Task 9
**Estimated time:** 30 minutes

---

## Execution Strategy

### Parallelization Plan

Tasks can be grouped for parallel execution:

**Wave 1 (prerequisite):**
- Task 1: Fix TypeScript compilation

**Wave 2 (parallel — independent work):**
- Task 2: Cross-encoder reranking
- Task 3: Context budget optimization
- Task 4: Performance optimization
- Task 5: Plugin packaging
- Task 6: Documentation (partial — prompts and architecture)

**Wave 3 (integration):**
- Task 6: Documentation (finalize after API surface is stable)
- Task 7: Dead code audit

**Wave 4 (validation):**
- Task 8: End-to-end tests

**Wave 5 (deployment):**
- Task 9: Install plugin
- Task 10: Start daemon

### Commit Cadence

Each task should produce 1-3 commits:
- Start: "feat(phase-7): begin [task name]" or "fix: [description]"
- Mid: intermediate progress commits for large tasks
- End: "feat(phase-7): complete [task name]"

### Success Validation

After all tasks complete, run this validation sequence:
```bash
# 1. TypeScript compiles
npx tsc --noEmit

# 2. All tests pass
npx vitest run

# 3. Build succeeds
npm run build

# 4. MCP server starts
node dist/cli/index.js mcp &
# (verify it doesn't crash)

# 5. CLI works
node dist/cli/index.js stats

# 6. Plugin is registered
claude mcp list | grep engram
```
