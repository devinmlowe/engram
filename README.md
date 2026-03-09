# Engram

Local-first cognitive memory system that consolidates LLM conversation history into searchable structured knowledge via autonomous dream-state processing.

## Contains

- `episodic/` — Conversation archive ingestion, indexing, and episodic search
- `semantic/` — Knowledge extraction, consolidation, and semantic search
- `graph/` — Entity/relationship graph, topic clusters, and graph search
- `dream/` — Autonomous consolidation pipeline (scheduling, orchestration, decay)
- `interfaces/` — CLI, MCP server, and web interface
- `_core/` — Shared infrastructure (config, db, types, embeddings, search, llm, cache)
- `decisions/` — Architecture Decision Records

## Key Interfaces

- **MCP Server** — `remember`, `recall`, `reflect`, `explore` tools for LLM agents
- **CLI** — `engram search`, `engram dream`, `engram remember` for direct use
- **Web** — Knowledge graph visualization and management at localhost:3000
- **Hybrid Search** — Vector + FTS5 + graph traversal with token budget enforcement

## See Also

- [SPEC.md](./SPEC.md) — Full system specification
- [SPEC-legacy.md](./SPEC-legacy.md) — Original vision document (pre-SRC)
