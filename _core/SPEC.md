---
module: _core
level: L1
derives-from: ../SPEC.md
status: draft
verified-by: ../tests/core/
decision-log:
  - ../decisions/003-core-shared-infrastructure.md
---

# _core

Shared infrastructure modules that all domains depend on. Contains cross-cutting services with no domain-specific logic. Dependency direction is strictly one-way: domains depend on `_core/`; `_core/` never depends on domains.

## Decomposes Into

- [config](./config/SPEC.md) — System-wide configuration with env var overrides
- [db](./db/SPEC.md) — Database connection, schema, thin data access layer
- [types](./types/SPEC.md) — Cross-domain interface types
- [embeddings](./embeddings/SPEC.md) — Vector embedding pipeline
- [search](./search/SPEC.md) — Multi-source search orchestration, RRF fusion
- [llm](./llm/SPEC.md) — Unified LLM client factory with tiered provider cascade
- [cache](./cache/SPEC.md) — Generic LRU cache utility
