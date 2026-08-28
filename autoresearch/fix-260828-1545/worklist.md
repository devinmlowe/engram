# Fix-loop worklist — 2026-08-28

Source: three read-only audits (core, interfaces, hermes-plugin). Each item was
verified against the code path by the auditor; re-verified at fix time.
Constraint: no public API/contract changes; existing tests must stay green.
Metric = count of unchecked boxes (lower is better).

## Bug — high

- [x] B1 `src/graph/entity.ts:502` ftsSearchEntities: raw query into FTS5 MATCH (no sanitize/try-catch/ORDER BY) → punctuation fails whole recall
- [x] B2 `src/dream/daemon.ts:770` passes `[conversationId]` array as memoryId → nested source_memories grows unbounded
- [x] B3 `src/interfaces/web/routes/dream.ts:143` engramBin resolves to nonexistent `web/cli/index.ts` → web dream start silently no-ops
- [x] B4 `src/interfaces/web/server.ts:90` sync throw in listener (bad Host → Invalid URL) kills visualizer
- [x] B5 `hermes-plugin/mcp_client.py:132` MCP `isError` results treated as success → "Error: …" injected as memory
- [x] B6 `hermes-plugin/provider.py:227` failed `start()` leaks Node child (no stop())
- [x] B7 `hermes-plugin/provider.py:154` `_stopping` never read → drain thread respawns child after shutdown
- [x] B8 `hermes-plugin/mcp_client.py:165` lock acquire has no timeout + per-stale-message timeout reset → prefetch can exceed Hermes 8s join
- [x] B9 `hermes-plugin/provider.py:181` dashboard writes `engram/config.json`, provider reads only `engram.json`
- [x] B10 `src/graph/reflection.ts:761` mergeRedundantEntities repoints edges without dedup → UNIQUE abort, prune step no-ops
- [x] B11 `src/graph/reflection.ts:771,799` + `cleanup.ts:34` entity DELETE skips vec/FTS/bridge cleanup → ghost ids, FK failures
- [x] B12 `src/graph/file-indexer.ts:437` zero-vector symbol embeddings out-rank real entities at L2 distance 1.0
- [x] B12b one-time idempotent cleanup: remove existing all-zero rows from vec_entities in the live DB (schema migration, reversible via re-index)

## Bug — low

- [x] L1 `src/semantic/memory.ts:396` + `search.ts:167` scope/type/active filtered after global top-k → scoped results < limit, scoped dedup misses
- [x] L2 `src/semantic/consolidator.ts:169` dream dedup unscoped → global facts merge into hermes:* memories
- [x] L3 `applyContradiction` has zero callers (consolidator update/keep_both branches)
- [x] L4 `src/_core/search/orchestrator.ts:154` reranker degrade path drops results 6–20
- [x] L5 `src/graph/search.ts:432` exploreSelective uses cosine-distance formula on L2 table
- [x] L6 `src/semantic/memory.ts:302` recordAccess read-modify-write not transactional
- [x] L7 `src/interfaces/shared/remember.ts:129` merge path non-atomic (updateMemory then re-embed outside txn; redundant deleteVector)
- [x] L8 `src/interfaces/shared/remember.ts:324` batch entity-linking after commit, unguarded → isError after persisting
- [x] L9 `src/interfaces/web/routes/sse.ts:42` cooldown drops updates instead of deferring
- [x] L10 `src/interfaces/mcp/server.ts:923` `show` strips blank lines before slicing → wrong line numbers
- [x] L11 `src/interfaces/cli/index.ts:852` health hardcodes "MCP tools: 5" and wrong build-check path
- [x] L12 `src/interfaces/web/routes/graph.ts:27`, `words.ts:10` NaN query params → silent empty responses
- [x] L13 `hermes-plugin/provider.py:242` reap_if_idle never called in production
- [x] L14 `hermes-plugin/provider.py:311` lost-wakeup race between _kick_writer and _drain_writes
- [x] L15 `hermes-plugin/mcp_client.py:144` reader-thread death/EOF never signalled → full-timeout stalls, wedged provider
- [x] L16 `hermes-plugin/provider.py:330` flush_writes blocks 2×timeout and re-kicks spawn every 50ms on failure
- [x] L17 `hermes-plugin/cli.py:25` `--budget` parsed but ignored
- [x] L18 `hermes-plugin/provider.py:162` is_available ignores engram.json on fresh instance
- [x] L19 `hermes-plugin/mcp_client.py:61` non-str env values → Popen TypeError swallowed, retried every turn

## Perf — high

- [x] P1 `src/_core/embeddings/index.ts:104` query embedded 3× per recall (cache populated after await; no in-flight memo)
- [x] P2 `src/episodic/sync.ts:171` changed conversation re-embeds every exchange, not just new ones
- [x] P3 `src/graph/search.ts:258` traverseNeighborhood recursive CTE has no cycle guard (d³ blow-up)
- [x] P4 `src/graph/entity.ts:239` getEntityByName `lower(name)=lower(?)` defeats NOCASE index → full scan on dream hot path
- [x] P5 `src/interfaces/mcp/server.ts:841` merge pays full LLM cascade + 120s timeout; skip when incoming ⊂ existing, cap timeout
- [x] P6 `src/interfaces/mcp/server.ts:52` ensureEmbeddings has no in-flight guard → concurrent cold calls load model twice

## Perf — low

- [x] Q1 per-row `db.prepare` in loops: `semantic/search.ts:192`, `semantic/memory.ts:404`, `graph/search.ts:99,113,487`, `drill.ts:226,249`
- [x] Q2 `src/_core/search/drill.ts:110` loads whole conversation to pick ±5 exchanges
- [x] Q3 `src/_core/search/scan.ts:260` detectFunctionContext walks backward per match (O(matches×lines))
- [x] Q4 `src/_core/db/schema.ts:378` migrateExpandedTypes probe INSERT/DELETE on every initDatabase
- [x] Q5 `src/semantic/consolidator.ts:461` conflict prompt re-read from disk per conflict
- [x] Q6 `src/interfaces/cli/index.ts:119` `remember` loads embedding model before validating --type
- [ ] Q7 `src/interfaces/web/data/word-queries.ts:61` full exchanges scan every 60s per open tab; resetWordCache never called
