# Interfaces

External access points to engram — CLI for humans, MCP for LLM agents, web for visualization. All share the same search and memory operations with consistent behavior.

## Contains

- `cli/` — Command-line interface (commander-based)
- `mcp/` — Model Context Protocol server for LLM agent integration
- `web/` — Web interface for graph visualization and management

## Key Interfaces

- **MCP Tools**: `recall`, `remember`, `reflect`, `explore`, `show` (snake_case params)
- **CLI Commands**: `search`, `remember`, `dream`, `sync`, `explore`, `reflect` (camelCase internal)
- **Web Routes**: `/graph`, `/words`, `/graph/api/*`, `/words/api/*`

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [Parent](../README.md) — System context
