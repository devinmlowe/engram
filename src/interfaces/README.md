# Interfaces

External access points to engram — CLI for humans, MCP for LLM agents, web for visualization. All share the same search and memory operations via [shared/](./shared/) with consistent behavior.

## In Scope

- CLI command definitions and human-readable output formatting
- MCP tool registration and LLM-optimized response formatting
- Web visualization server with real-time updates
- Shared operation handlers ensuring consistent behavior across interfaces

## Out of Scope

- Domain logic (delegated to episodic, semantic, graph, dream modules)
- Search orchestration (see [_core/search/](../_core/search/))
- Database operations (see [_core/db/](../_core/db/))

## Contains

- [cli/](./cli/) — Command-line interface (14 commands, commander-based)
- [mcp/](./mcp/) — Model Context Protocol server (12 tools, stdio transport)
- [web/](./web/) — Web visualization server (4 views, SSE real-time updates)
- [shared/](./shared/) — Shared operation handlers (search, remember, explore, reflect)

## Key Interfaces

- **MCP Tools**: `recall`, `remember`, `reflect`, `explore`, `show`, `recall_session`, `recall_drill`, `explore_selective`, `remember_batch`, `fetch_snippets`, `index_file_structure`, `scan_file`
- **CLI Commands**: `init`, `sync`, `search`, `remember`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `migrate`, `validate`
- **Web Routes**: `/graph`, `/graph/depth`, `/graph/galaxy`, `/words`, `/api/*`

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [src/](../) — Parent source directory
- [decisions/008-parameter-naming.md](../../decisions/008-parameter-naming.md) — snake_case MCP vs camelCase internal
- [tests/e2e/](../../tests/e2e/) — End-to-end interface tests
