# Cache

Generic LRU cache with TTL expiration. Used for query embeddings, search results, and graph analysis memoization.

## In Scope

- Key-value caching with configurable max size and TTL
- Cache invalidation and eviction

## Out of Scope

- Persistent caching or disk storage
- Domain-specific caching logic (callers manage their own cache instances)

## Contains

- `index.ts` — LRU cache implementation with TTL support

## See Also

- [SPEC.md](./SPEC.md) — Module specification
- [_core/](../) — Parent shared infrastructure
