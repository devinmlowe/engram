# _core

Shared infrastructure modules — cross-cutting services with no domain logic. All domains depend on `_core/`; `_core/` never depends on domains.

## Contains

- `config/` — System-wide configuration with env var overrides
- `db/` — Database connection, schema, thin data access layer
- `types/` — Cross-domain interface types (SearchResult, EngramConfig, etc.)
- `embeddings/` — Vector embedding pipeline (nomic-embed + MiniLM fallback)
- `search/` — Multi-source search orchestration, RRF fusion, score normalization
- `llm/` — Unified LLM client factory (Ollama → OpenRouter → Anthropic cascade)
- `cache/` — Generic LRU cache utility

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [Parent](../README.md) — System context
