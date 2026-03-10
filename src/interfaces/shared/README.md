# Shared

Shared operation handlers used by both CLI and MCP interfaces. These contain the core orchestration logic — interfaces only handle input parsing and output formatting.

## In Scope

- Recall/search orchestration (query → multi-source search → format)
- Remember operation (input → dedup check → store)
- Explore operation (entity lookup → graph traversal → format)
- Reflect operation (graph analysis → pattern summarization)

## Out of Scope

- Input parsing and validation (owned by CLI and MCP)
- Output formatting for specific consumers (CLI formats for humans, MCP for LLMs)
- Domain-specific logic (delegated to episodic, semantic, graph modules)

## Contains

- `search.ts` — Recall and drill operations
- `remember.ts` — Memory storage with deduplication
- `explore.ts` — Entity exploration and selective traversal
- `reflect.ts` — Graph reflection and pattern analysis

## See Also

- [interfaces/cli/](../cli/) — CLI consumer
- [interfaces/mcp/](../mcp/) — MCP consumer
- [interfaces/](../) — Parent interfaces module
