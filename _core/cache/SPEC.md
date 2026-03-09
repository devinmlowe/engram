---
module: cache
level: L2
derives-from: ../SPEC.md
status: draft
verified-by: ../../tests/core/cache.test.ts
---

# Cache

Generic LRU cache with TTL support. Used by embeddings for query caching and available for any domain needing in-memory caching.

## Requirements

- **REQ-1**: The module shall provide an LRU cache with configurable max size and TTL. *(traces to _core)*
- **REQ-2**: The module shall evict least-recently-used entries when capacity is exceeded. *(traces to _core)*
- **REQ-3**: The module shall expire entries after their TTL. *(traces to _core)*

## Interface Contract

### Postconditions

- **POST-1**: `get()` shall return undefined for expired or evicted entries.
- **POST-2**: Cache size shall never exceed configured maxSize.

### Invariants

- **INV-1**: The cache shall be generic (`LRUCache<K, V>`) — no domain-specific logic.
