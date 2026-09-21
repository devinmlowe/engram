---
module: semantic
level: L1
derives-from: ../../SPEC.md
status: draft
verified-by: ../../tests/semantic/
decision-log:
  - ../../decisions/005-unified-llm-factory.md
  - ../../decisions/006-shared-search-contract.md
  - ../../decisions/007-hybrid-type-ownership.md
---

# Semantic

The semantic domain extracts, consolidates, and retrieves structured knowledge from conversations. It transforms raw episodic data into typed memories (facts, decisions, patterns, preferences, solutions, conventions) through LLM-powered extraction, deduplication, conflict detection, and decay management.

## Requirements

- **REQ-1**: The domain shall extract structured facts from conversation exchanges via LLM, producing typed `ExtractedFact` records. *(traces to L0 REQ-2)*
- **REQ-2**: The domain shall deduplicate incoming facts against existing memories using embedding similarity and NLI. *(traces to L0 REQ-10)*
- **REQ-3**: The domain shall detect contradictions between new and existing memories via NLI classification. *(traces to L0 REQ-10)*
- **REQ-4**: The domain shall consolidate related memories, merging near-duplicates and recording conflicts. *(traces to L0 REQ-2)*
- **REQ-5**: The domain shall provide hybrid search over memories, returning `LayerSearchResult[]`. *(traces to L0 REQ-4)*
- **REQ-6**: The domain shall compute and apply FSRS-inspired decay to memory retrievability over time. *(traces to L0 REQ-9)*
- **REQ-7**: The domain shall mark low-confidence memories as prune-eligible. *(traces to L0 REQ-9)*
- **REQ-8**: The domain shall let a user forget a memory (#55, decision #56): in one transaction set `is_active = 0`, `deleted_at`, `deleted_by`; delete its `vec_memories` and `memories_fts` rows; append a `memory_changes` row (`before` = content, actor); record its content hash in `memory_suppressions`; and detach it from graph evidence (decision #57: decrement `mention_count` once per evidenced entity, stamp `stale_since` at zero, never delete a graph row). A forgotten memory shall not be returned by any recall path (vector, FTS, hybrid search, session drill, active-memory readers) nor reinforced. Hard deletion removes the row; the dream prune phase hard-deletes rows older than `ENGRAM_FORGET_RETENTION_DAYS`.
- **REQ-9**: The domain shall provide edit (re-embed + re-index, logged with before/after), restore (inside the retention window; lifts the suppression), purge-by-conversation, a change log, and provenance inspection (source exchanges and conversations, source/extraction basis, scope, FSRS health, graph evidence). Forget/edit/restore shall refuse a memory outside the caller's read scopes unless scope `global` is passed explicitly (#25).
- **REQ-10**: Extraction shall skip a fact whose content hash is in `memory_suppressions` for the conversation's scope or `global` (dream extract counts them as `suppressedFacts`); an explicit remember of the same content in a scope lifts only that scope's suppression (#106: one tenant's forget neither silences nor is lifted by another tenant).

## Interface Contract

### Preconditions

- **PRE-1**: Database shall be initialized with semantic schema (memories, conflicts, vec_memories tables).
- **PRE-2**: `_core/llm/` shall be available for extraction operations.
- **PRE-3**: `_core/embeddings/` shall be initialized for similarity comparison.

### Postconditions

- **POST-1**: Extraction shall produce `ExtractionResult` with model, tier, confidence, and duration metadata.
- **POST-2**: Deduplication shall return one of: insert, merge, conflict, or skip.
- **POST-3**: `searchSemantic()` shall return results conforming to `LayerSearchResult[]` contract.
- **POST-4**: Decay shall never increase retrievability without an access event.
- **POST-5**: After `forgetMemory`, `vec_memories` and `memories_fts` hold no row for the memory, and `memory_changes` holds exactly one `forget` row for it; a second soft forget is refused (`MemoryAlreadyForgottenError`).

### Invariants

- **INV-1**: The domain owns all memory content — graph domain shall not write to memory tables.
- **INV-2**: `ExtractedFact` is a transitional form that becomes a `Memory` upon persistence. They are the same concept at different lifecycle stages.
- **INV-3**: The FTS5 'delete' command runs at most once per indexed row (a second one corrupts the external-content index): only currently-indexed rows are unindexed — active rows and superseded/pruned rows, never an already-forgotten one — and `updateMemory` skips FTS sync for forgotten rows.

## Decomposes Into

- `extractor` — LLM-powered fact extraction from conversations (owns prompt templates and JSON schemas)
- `consolidator` — Deduplication, merge, and conflict detection pipeline
- `memory` — Memory CRUD, similarity search, access tracking
- `search` — Semantic-layer hybrid search (vector + FTS5 → RRF)
- `nli` — NLI contradiction detection (DeBERTa cross-encoder)
- `decay` — FSRS-inspired retrievability decay and pruning eligibility
- `forget` — Forget / edit / restore / purge, change log writes, suppression, graph evidence detachment (#55)
- `inspect` — Listing, provenance, change-log reads (#55)
- `index-integrity` — Orphaned vec/FTS row audit and repair for `engram validate` (#55)

## Dependencies

- [_core/db](../_core/db/SPEC.md) — Database connection and query helpers
- [_core/embeddings](../_core/embeddings/SPEC.md) — Vector embedding generation and similarity
- [_core/llm](../_core/llm/SPEC.md) — LLM client factory for extraction
- [_core/types](../_core/types/SPEC.md) — `SearchOptions`, `LayerSearchResult`

## Verification

| ID | Method | Location |
|----|--------|----------|
| REQ-1 | Integration test | `../tests/semantic/extractor.test.ts` |
| REQ-2 | Unit test | `../tests/semantic/consolidator.test.ts` |
| REQ-3 | Unit test | `../tests/semantic/nli.test.ts` |
| REQ-5 | Integration test | `../tests/semantic/search.test.ts` |
| REQ-6 | Unit test | `../tests/semantic/decay.test.ts` |
| REQ-8, REQ-9, REQ-10, POST-5, INV-3 | Unit test | `../tests/semantic/forget.test.ts` (one test per recall path, graph decrement/stale flag, scope gate, retention purge, suppression, index integrity); `../tests/dream/daemon.test.ts` (extract suppression, prune retention) |
| INV-2 | Type check (design) | Enforced by `tsc --noEmit` (`npm run lint`): the only `ExtractedFact` → `Memory` conversion is `memoryFromFact()` in `../src/semantic/consolidator.ts`, and `Memory` is what `../src/semantic/memory.ts` persists. No runtime test — there is no behaviour to observe |
