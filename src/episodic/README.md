# Episodic

Ingests, indexes, and searches raw conversation exchanges — the foundational data layer for all downstream memory processing.

## In Scope

- Conversation archive discovery and incremental sync
- JSONL file parsing into typed exchanges
- Exchange persistence with vector embeddings and FTS5 indexing
- Hybrid episodic search (vector + text + RRF fusion)

## Out of Scope

- Knowledge extraction from exchanges (see [semantic/](../semantic/))
- Entity/relationship extraction (see [graph/](../graph/))
- Search orchestration across multiple layers (see [_core/search/](../_core/search/))

## Contains

- `sync` — Archive discovery and incremental conversation indexing
- `parser` — Conversation file parsing into typed exchanges
- `store` — Exchange persistence and retrieval
- `search` — Hybrid vector + FTS5 search with RRF fusion
- `types` — Episodic-specific type definitions

## Key Interfaces

- `syncConversations(db, config, options)` — Discover and index new conversations
- `searchEpisodic(db, options) → LayerSearchResult[]` — Hybrid search over exchanges
- `Exchange` — Core type: a single user/assistant exchange with metadata

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [src/](../) — Parent source directory
- [tests/episodic/](../../tests/episodic/) — Test suite
