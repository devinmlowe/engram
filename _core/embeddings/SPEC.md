---
module: embeddings
level: L2
derives-from: ../SPEC.md
status: draft
verified-by: ../../tests/core/embeddings.test.ts
decision-log:
  - ../../decisions/003-core-shared-infrastructure.md
---

# Embeddings

Vector embedding pipeline for text encoding. Provides model initialization with automatic fallback, query/document embedding, and per-session caching.

## Requirements

- **REQ-1**: The module shall initialize an embedding model with fallback: nomic-embed-text-v1.5 → all-MiniLM-L6-v2. *(traces to L0 PRE-2)*
- **REQ-2**: The module shall generate 256-dimensional embeddings via Matryoshka truncation and L2 normalization. *(traces to L0 REQ-1)*
- **REQ-3**: The module shall cache query embeddings with TTL to avoid redundant computation. *(traces to L0 REQ-8)*
- **REQ-4**: The module shall support both query and document embedding with appropriate prefixes. *(traces to L0 REQ-1)*

## Interface Contract

### Postconditions

- **POST-1**: `embedQuery()` and `embedDocument()` shall return Float32 arrays of exactly 256 dimensions.
- **POST-2**: Identical queries within TTL shall return cached results without model invocation.

### Invariants

- **INV-1**: The module shall operate fully offline — no network calls.
- **INV-2**: Embedding dimensions shall be consistent regardless of which fallback model is active.
