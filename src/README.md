# Source

All engram application code. Organized into four domain modules, a shared core infrastructure layer, and interface adapters.

## In Scope

- Domain logic (episodic, semantic, graph, dream)
- Shared infrastructure (_core)
- Interface adapters (CLI, MCP server, web visualization)
- Data migration utilities

## Out of Scope

- Tests (see [tests/](../tests/))
- Prompt templates (see [prompts/](../prompts/))
- Documentation (see [docs/](../docs/))
- Build output (see `dist/`)

## Contains

### Domain Modules
- [episodic/](./episodic/) — Conversation archive ingestion, indexing, and search
- [semantic/](./semantic/) — Knowledge extraction, consolidation, and memory management
- [graph/](./graph/) — Entity/relationship graph, communities, and reflection
- [dream/](./dream/) — Autonomous consolidation pipeline

### Infrastructure
- [_core/](`./_core/`) — Shared services (config, db, types, embeddings, search, llm, cache)

### Interface Adapters
- [interfaces/](./interfaces/) — CLI, MCP server, web visualization

### Utilities
- [migration/](./migration/) — Data migration from legacy superpowers DB

## See Also

- [SPEC.md](../SPEC.md) — System specification with decomposition into these modules
- [tests/](../tests/) — Test suites mirroring this structure
