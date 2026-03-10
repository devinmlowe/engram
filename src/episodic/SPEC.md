---
module: episodic
level: L1
derives-from: ../../SPEC.md
status: draft
verified-by: ../../tests/episodic/
decision-log:
  - ../../decisions/003-core-shared-infrastructure.md
  - ../../decisions/006-shared-search-contract.md
  - ../../decisions/007-hybrid-type-ownership.md
---

# Episodic

The episodic domain manages ingestion, indexing, and retrieval of raw conversation exchanges. It is the system's foundational data layer — all downstream processing (semantic extraction, graph construction) begins with episodic data.

## Requirements

- **REQ-1**: The domain shall discover and archive conversation files from configured source directories. *(traces to L0 REQ-1)*
- **REQ-2**: The domain shall parse conversation archives into individual exchanges with metadata (project, timestamp, session, git branch). *(traces to L0 REQ-1)*
- **REQ-3**: The domain shall generate and store vector embeddings for each exchange. *(traces to L0 REQ-1)*
- **REQ-4**: The domain shall provide hybrid search (vector + FTS5 → RRF fusion) over exchanges, returning `LayerSearchResult[]`. *(traces to L0 REQ-4)*
- **REQ-5**: The domain shall support incremental sync — only index new or modified conversations. *(traces to L0 REQ-1)*
- **REQ-6**: The domain shall track tool calls per exchange for context enrichment. *(traces to L0 REQ-1)*

## Interface Contract

### Preconditions

- **PRE-1**: Database shall be initialized with episodic schema (exchanges, exchanges_fts, vec_exchanges tables).
- **PRE-2**: Embedding pipeline shall be initialized via `_core/embeddings/`.

### Postconditions

- **POST-1**: `searchEpisodic()` shall return results conforming to `LayerSearchResult[]` contract.
- **POST-2**: `syncConversations()` shall report discovered, copied, indexed, skipped, and error counts.
- **POST-3**: Sync shall not re-index conversations whose archive file has not changed.

### Invariants

- **INV-1**: The domain shall not modify source conversation archive files.
- **INV-2**: Exchange IDs shall be deterministic (hash of archive_path:line_range).

## Decomposes Into

- `sync` — Archive discovery, copy, and incremental indexing
- `parser` — Conversation file parsing into typed exchanges
- `store` — Exchange persistence and retrieval queries
- `search` — Episodic-layer hybrid search (vector + FTS5 → RRF)

## Dependencies

- [_core/db](../_core/db/SPEC.md) — Database connection and query helpers
- [_core/embeddings](../_core/embeddings/SPEC.md) — Vector embedding generation
- [_core/types](../_core/types/SPEC.md) — `SearchOptions`, `LayerSearchResult`

## Verification

| ID | Method | Location |
|----|--------|----------|
| REQ-1 | Integration test | `../tests/episodic/sync.test.ts` |
| REQ-3 | Integration test | `../tests/episodic/embeddings.test.ts` |
| REQ-4 | Integration test | `../tests/episodic/search.test.ts` |
| REQ-5 | Unit test | `../tests/episodic/sync.test.ts` |
| POST-1 | Unit test | `../tests/episodic/search.test.ts` |
