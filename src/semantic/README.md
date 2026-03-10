# Semantic

Extracts, consolidates, and retrieves structured knowledge from conversations — transforming raw exchanges into typed memories with deduplication, conflict detection, and decay.

## In Scope

- LLM-powered fact extraction with prompt templates
- Memory deduplication and conflict detection (NLI-based)
- Confidence scoring and FSRS-inspired decay
- Adaptive chunking for content-aware boundaries
- Hybrid semantic search over memories
- Batch memory ingestion with entity linking

## Out of Scope

- Raw conversation storage (see [episodic/](../episodic/))
- Entity/relationship graph management (see [graph/](../graph/))
- Search orchestration across layers (see [_core/search/](../_core/search/))

## Contains

- `extractor` — LLM-powered fact extraction with prompt templates
- `consolidator` — Deduplication, merge, and conflict detection
- `memory` — Memory CRUD, similarity search, access tracking
- `search` — Hybrid vector + FTS5 search with RRF fusion
- `nli` — NLI contradiction detection via DeBERTa
- `decay` — FSRS-inspired retrievability decay and pruning
- `adaptive-chunker` — Content-aware chunk sizing (Phase 6A)
- `types` — Semantic-specific type definitions

## Key Interfaces

- `extractFacts(conversation) → ExtractionResult` — Extract structured knowledge from exchanges
- `searchSemantic(db, options) → LayerSearchResult[]` — Hybrid search over memories
- `Memory` — Core type: a typed knowledge item with confidence, importance, and decay tracking

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [src/](../) — Parent source directory
- [prompts/](../../prompts/) — LLM prompt templates used by extractor
- [tests/semantic/](../../tests/semantic/) — Test suite
