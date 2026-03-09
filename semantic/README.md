# Semantic

Extracts, consolidates, and retrieves structured knowledge from conversations — transforming raw exchanges into typed memories with deduplication, conflict detection, and decay.

## Contains

- `extractor` — LLM-powered fact extraction with prompt templates
- `consolidator` — Deduplication, merge, and conflict detection
- `memory` — Memory CRUD, similarity search, access tracking
- `search` — Hybrid vector + FTS5 search with RRF fusion
- `nli` — NLI contradiction detection via DeBERTa
- `decay` — FSRS-inspired retrievability decay and pruning

## Key Interfaces

- `extractFacts(conversation) → ExtractionResult` — Extract structured knowledge from exchanges
- `searchSemantic(db, options) → LayerSearchResult[]` — Hybrid search over memories
- `Memory` — Core type: a typed knowledge item with confidence, importance, and decay tracking

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [Parent](../README.md) — System context
