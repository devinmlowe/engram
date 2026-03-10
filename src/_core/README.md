# _core

Shared infrastructure modules — cross-cutting services with no domain logic. All domains depend on `_core/`; `_core/` never depends on domains.

## In Scope

- Database connection, schema, and data access helpers
- System-wide configuration with environment variable overrides
- Cross-domain type definitions
- Vector embedding pipeline
- Multi-source search orchestration, fusion, and budget enforcement
- LLM client factory with tiered provider cascade
- Generic caching utilities

## Out of Scope

- Domain-specific business logic (owned by episodic, semantic, graph, dream)
- Interface-specific formatting (owned by CLI, MCP, web)
- Prompt template content (see [prompts/](../../prompts/))

## Contains

- [config/](./config/) — System-wide configuration with env var overrides
- [db/](./db/) — Database connection, schema, thin data access layer
- [types/](./types/) — Cross-domain interface types (SearchResult, EngramConfig, etc.)
- [embeddings/](./embeddings/) — Vector embedding pipeline (nomic-embed + MiniLM fallback)
- [search/](./search/) — Multi-source search orchestration, RRF fusion, sessions, file tools
- [llm/](./llm/) — Unified LLM client factory (Ollama → OpenRouter → Anthropic cascade)
- [cache/](./cache/) — Generic LRU cache utility

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [src/](../) — Parent source directory
- [decisions/003-core-shared-infrastructure.md](../../decisions/003-core-shared-infrastructure.md) — Design rationale
- [tests/core/](../../tests/core/) — Test suite
