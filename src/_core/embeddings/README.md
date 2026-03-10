# Embeddings

Vector embedding pipeline — generates semantic embeddings for text content using a local transformer model. Singleton initialization, encoding, and similarity computation.

## In Scope

- Model initialization (nomic-embed-text primary, MiniLM fallback)
- Text-to-vector encoding with task prefixes
- Cosine similarity computation
- Embedding memoization by content hash

## Out of Scope

- Vector storage and retrieval (see [_core/db/](../db/))
- Search orchestration (see [_core/search/](../search/))

## Contains

- `index.ts` — Singleton model loader, encode, similarity functions

## See Also

- [SPEC.md](./SPEC.md) — Module specification
- [decisions/003-core-shared-infrastructure.md](../../../decisions/003-core-shared-infrastructure.md) — Shared infra design
- [_core/](../) — Parent shared infrastructure
