# Embeddings

Vector embedding pipeline — generates semantic embeddings for text content using a local transformer model. Singleton initialization, encoding, and similarity computation.

## In Scope

- Model initialization (nomic-embed-text primary, MiniLM fallback)
- Text-to-vector encoding with task prefixes
- Cosine similarity computation
- Embedding memoization by content hash
- Pointing transformers.js at the configured (durable) model cache and adopting a legacy `node_modules` cache once per process

## Out of Scope

- Vector storage and retrieval (see [_core/db/](../db/))
- Search orchestration (see [_core/search/](../search/))

## Contains

- `index.ts` — Singleton model loader, encode, similarity functions
- `model-cache.ts` — `applyModelCacheDir` (every loader's entry point: sets `env.cacheDir` from config), `migrateLegacyModelCache` (moves a pre-0.4.0 `node_modules/@xenova/transformers/.cache` into the resolved dir: rename, or copy + size-verify + swap across filesystems; race-tolerant), `isInsideNodeModules`, `libraryModelCacheDir` (#53)

## See Also

- [SPEC.md](./SPEC.md) — Module specification
- [decisions/003-core-shared-infrastructure.md](../../../decisions/003-core-shared-infrastructure.md) — Shared infra design
- [_core/](../) — Parent shared infrastructure
