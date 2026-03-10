# Episodic

Ingests, indexes, and searches raw conversation exchanges — the foundational data layer for all downstream memory processing.

## Contains

- `sync` — Archive discovery and incremental conversation indexing
- `parser` — Conversation file parsing into typed exchanges
- `store` — Exchange persistence and retrieval
- `search` — Hybrid vector + FTS5 search with RRF fusion

## Key Interfaces

- `syncConversations(db, config, options)` — Discover and index new conversations
- `searchEpisodic(db, options) → LayerSearchResult[]` — Hybrid search over exchanges
- `Exchange` — Core type: a single user/assistant exchange with metadata

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [Parent](../README.md) — System context
