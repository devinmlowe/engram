# Engram Phase 2: Implementation Plan

## Context

Phase 1 built Engram's episodic memory foundation: JSONL parser, nomic-embed-text-v1.5 embeddings (256d), hybrid vector+FTS5 search with RRF fusion, MCP server, CLI, and 67 passing tests. Phase 2 addresses three issues discovered during Phase 1 and adds the data migration pipeline:

1. **Critical bug**: `embeddings.ts` skips required `layer_norm` before Matryoshka truncation
2. **UX problem**: RRF fusion scores display as 2-3% instead of intuitive percentages
3. **Data gap**: 3,605 exchanges in the legacy superpowers DB need migrating to Engram
4. **Quality assurance**: No validation framework exists for migration integrity

All Phase 2 research is complete (4 detailed docs in `docs/research/`). This plan executes the implementation.

---

## Team Execution Strategy: 3 Parallel Streams

```
Stream A: Embedding Fix + Batch Support   (embeddings.ts, embeddings.test.ts)
    |
    v
Stream C: Migration + Validation + CLI    (new files, cli/index.ts)

Stream B: Score Normalization + Tests     (search.ts, search.test.ts) -- fully independent
```

**Zero merge conflicts**: Each stream modifies different files. No shared writes.

| File | Stream A | Stream B | Stream C |
|------|----------|----------|----------|
| `src/episodic/embeddings.ts` | MODIFIES | - | imports only |
| `src/episodic/search.ts` | - | MODIFIES | imports only |
| `src/migration/*.ts` | - | - | CREATES |
| `tests/episodic/embeddings.test.ts` | MODIFIES | - | - |
| `tests/episodic/search.test.ts` | - | MODIFIES | - |
| `tests/migration/*.test.ts` | - | - | CREATES |
| `src/cli/index.ts` | - | - | APPENDS |

---

## Stream A: Fix Embeddings + Batch Support

### A1: Fix `layer_norm` in `embeddings.ts`

**File**: `src/episodic/embeddings.ts`

1. Add `layer_norm` to import from `@xenova/transformers`
2. Replace `truncateAndNormalize()` with Tensor-based Matryoshka truncation for nomic:
   - `normalize: false` in pipeline call (for nomic path)
   - `layer_norm(output, [output.dims[1]])` -> `slice(null, [0, 256])` -> `normalize(2, -1)`
   - Keep `truncateAndNormalize()` as MiniLM fallback
3. Add `embedDocumentBatch(texts: string[]): Promise<number[][]>` export for migration:
   - Accepts array of texts, returns array of 256d vectors
   - Same layer_norm -> slice -> normalize pipeline, batched
4. If `layer_norm` is not exported from @xenova/transformers@2.17.2, implement manually

**Commit**: `fix(embeddings): add layer_norm before Matryoshka truncation + batch embed support`

### A2: Update embedding tests

**File**: `tests/episodic/embeddings.test.ts`

- Add test: `embedDocumentBatch` returns correct shapes (2 texts -> 2 x 256d vectors)
- Add test: batch embedding matches individual embedding (cosine sim > 0.99)
- Add test: batch embeddings are L2-normalized (norm ~1.0)
- Existing tests (dimension check, normalization, similarity ordering) should pass unchanged

**Commit**: `test(embeddings): add batch embedding tests and verify layer_norm fix`

### A3: Run full test suite, verify green

```bash
npm run test:run
```

**Commit** (if fixes needed): `fix(tests): update embedding test expectations for layer_norm change`

---

## Stream B: Score Normalization

### B1: Add `normalizeMinMaxFloored()` to `search.ts`

**File**: `src/episodic/search.ts`

Add after `rrfFuse()`, before `budgetResults()`:

```typescript
export function normalizeMinMaxFloored(
  results: { id: string; score: number }[],
  floor: number = 0.1,
): void {
  // Empty: return
  // Single result: score = 0.85
  // All same scores: score = 0.5
  // Otherwise: floor + (1 - floor) * ((score - min) / (max - min))
}
```

**Commit**: `feat(search): add normalizeMinMaxFloored score normalization function`

### B2: Integrate into `searchEpisodic()`

**File**: `src/episodic/search.ts`

Apply normalization in `searchEpisodic()` for all three modes:
- **Hybrid** (after RRF fusion): `normalizeMinMaxFloored(fused)`
- **Vector-only / Text-only**: Convert ranks to 1/(60+rank) scores, then normalize

This ensures all modes produce consistent 10-100% scores.

**Commit**: `feat(search): apply min-max normalization to all search modes`

### B3: Add normalization unit tests

**File**: `tests/episodic/search.test.ts`

New `describe("normalizeMinMaxFloored")` block:
- Normalizes to [floor, 1.0] range
- Single result -> 0.85
- All-same scores -> 0.5
- Empty results -> no-op
- Custom floor value respected

**Commit**: `test(search): add normalizeMinMaxFloored unit tests`

### B4: Run full test suite, verify green

**Commit** (if needed): `fix(search): correct normalization edge case in integration tests`

---

## Stream C: Migration + Validation + CLI

### C1: Create migration types (can start immediately)

**File**: `src/migration/types.ts` (NEW)

Types: `MigrationBatchConfig`, `MigrationProgress`, `MigrationCheckpoint`, `MigrationReport`, `ValidationResult`, `SourceExchange`

Constants: `DEFAULT_BATCH_CONFIG` (32 embed batch, 500 DB batch, 500 checkpoint interval), `EXCLUDED_PROJECT = "double-shot-latte"`

**Commit**: `feat(migration): add migration type definitions and configuration`

### C2: Implement core migration logic (depends on Stream A for end-to-end testing)

**File**: `src/migration/migrate.ts` (NEW)

Key functions:
- **Schema mapping**: `deriveConversationId(archivePath)`, `deriveProject(archivePath)`, `computeExchangeIndexes(sourceDb)`, `estimateTokens(user, assistant)`, `mapSourceToTarget(source, index)`, `mapToolCall(source)`
- **Conversation aggregation**: `buildConversations(sourceDb)` - GROUP BY archive_path
- **Checkpoint management**: `ensureCheckpointTable()`, `getCheckpoint()`, `saveCheckpoint()`
- **Batch operations**: `migrateExchanges()` - batch embed + bulk insert, `migrateToolCalls()` - bulk insert with truncation
- **Finalization**: `finalizeMigration()` - FTS5 rebuild, WAL checkpoint, ANALYZE
- **Orchestrator**: `runMigration(options)` - full pipeline
- **UX**: `formatProgress(p)` - terminal progress display

Source DB: `~/.config/superpowers/conversation-index/db.sqlite` (opened readonly)
Target DB: `~/.local/share/engram/engram.db`

Exclusion: filter out `double-shot-latte` project (~4,055 exchanges = 53% of source)
Expected: ~3,605 exchanges, ~145K tool calls, ~1,502 conversations
Timeline: ~3-5 minutes total (embedding dominates)

Uses `embedDocumentBatch()` from Stream A's embedding fix.

**Commit**: `feat(migration): implement core migration pipeline with batch embedding and checkpoint support`

### C3: Add CLI commands (can start immediately)

**File**: `src/cli/index.ts` (APPEND)

- `engram migrate` - options: --source, --dry-run, --batch-size, --force
- `engram validate` - options: --source

**Commit**: `feat(cli): add migrate and validate commands`

### C4: Create validation framework

**File**: `src/migration/validate.ts` (NEW)

5 validation checks:
1. **Row counts**: exchanges, tool calls, conversations, vectors (with exclusion filter on source)
2. **Embedding dimensions**: sample 100, check 256 floats + L2 norm ~1.0
3. **Content integrity**: sample 200, compare source vs target text
4. **FTS5 integrity**: integrity-check command + 20 known-content queries (>80% hit rate)
5. **Search quality**: 8 reference queries, check >0 results and normalized score range

**Commit**: `feat(validation): implement migration validation framework`

### C5: Migration unit tests

**File**: `tests/migration/migrate.test.ts` (NEW)

- Schema mapping: `deriveConversationId`, `deriveProject`, `estimateTokens`, `mapSourceToTarget`, `mapToolCall` (truncation)
- Conversation building: aggregation, exclusion filter, sequential indexes
- Checkpoint: save/retrieve/null-when-empty

**Commit**: `test(migration): add unit tests for schema mapping, conversation building, and checkpoint`

### C6: Validation unit tests

**File**: `tests/migration/validate.test.ts` (NEW)

- Row count mismatch detection + pass case
- Embedding dimension + norm errors
- Content mismatch detection
- FTS corruption detection

Uses synthetic source/target DBs with known content.

**Commit**: `test(validation): add unit tests for all validation checks`

### C7: Full test suite verification

```bash
npm run test:run && npm run build
```

**Commit** (if needed): `fix: resolve test failures from migration integration`

---

## Execution Timeline

### Phase 1: Parallel Start (Streams A + B + C scaffolding)

| Agent | Steps | Files | Independent? |
|-------|-------|-------|-------------|
| Stream A | A1, A2, A3 | embeddings.ts, embeddings.test.ts | Yes |
| Stream B | B1, B2, B3, B4 | search.ts, search.test.ts | Yes |
| Stream C | C1, C3 | migration/types.ts, cli/index.ts | Yes |

All three start simultaneously. No dependencies between them.

### Phase 2: Stream C continues (after A completes)

| Agent | Steps | Files | Depends On |
|-------|-------|-------|-----------|
| Stream C | C2, C4, C5, C6, C7 | migration/*.ts, tests/migration/*.ts | Stream A (for embedDocumentBatch) |

Stream C can write C2 in parallel with A (new file, no conflict), but cannot test end-to-end until A's embedding fix is committed.

### Phase 3: Final Integration

One agent runs full verification:
```bash
npm run test:run  # all tests green
npm run build     # TypeScript compiles cleanly
```

**Final commit**: `chore: Phase 2 integration verified (all tests green, build passes)`

---

## Verification

After implementation, verify:

1. **Tests pass**: `npm run test:run` (all existing 67 + new tests)
2. **Build compiles**: `npm run build` (strict TypeScript)
3. **Embedding fix works**: Embedding tests show 256d, L2-normalized, batch matches single
4. **Scores are intuitive**: Search results show 10-100% instead of 2-3%
5. **Migration works**: `npm run dev -- migrate --dry-run` shows correct counts
6. **Validation passes**: `npm run dev -- validate` after migration shows all checks green

For live migration test (optional, requires source DB):
```bash
npm run dev -- migrate --source ~/.config/superpowers/conversation-index/db.sqlite
npm run dev -- validate --source ~/.config/superpowers/conversation-index/db.sqlite
npm run dev -- search "SQLite WAL mode"  # verify intuitive scores
npm run dev -- stats  # verify exchange counts
```

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| `layer_norm` not exported from @xenova/transformers@2.17.2 | Implement manually: mean-center, divide by sqrt(variance+eps) |
| Tensor `.slice()` API differs | Fallback to `.data` extraction + manual array slicing |
| Source DB schema differs from research assumptions | Agent runs `PRAGMA table_info(exchanges)` before writing queries |
| Memory pressure during batch embedding | Adaptive batch size (reduce if RSS > 4GB) |
| Existing tests break from embedding value changes | Tests check behavioral properties (ordering, dimension, norm), not exact values |
