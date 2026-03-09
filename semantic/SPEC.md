---
module: semantic
level: L1
derives-from: ../SPEC.md
status: draft
verified-by: ../tests/semantic/
decision-log:
  - ../decisions/005-unified-llm-factory.md
  - ../decisions/006-shared-search-contract.md
  - ../decisions/007-hybrid-type-ownership.md
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

### Invariants

- **INV-1**: The domain owns all memory content — graph domain shall not write to memory tables.
- **INV-2**: `ExtractedFact` is a transitional form that becomes a `Memory` upon persistence. They are the same concept at different lifecycle stages.

## Decomposes Into

- `extractor` — LLM-powered fact extraction from conversations (owns prompt templates and JSON schemas)
- `consolidator` — Deduplication, merge, and conflict detection pipeline
- `memory` — Memory CRUD, similarity search, access tracking
- `search` — Semantic-layer hybrid search (vector + FTS5 → RRF)
- `nli` — NLI contradiction detection (DeBERTa cross-encoder)
- `decay` — FSRS-inspired retrievability decay and pruning eligibility

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
| INV-2 | Architecture test | `../tests/semantic/types.test.ts` |
