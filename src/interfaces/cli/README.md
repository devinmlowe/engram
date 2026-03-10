# CLI

Command-line interface for direct human interaction with engram. Built on Commander.js with 14 commands covering search, memory management, graph exploration, dream pipeline, and system administration.

## In Scope

- Command definitions, argument parsing, and output formatting
- Human-readable output (tables, colored text, progress indicators)
- Orchestration of shared operations for CLI context

## Out of Scope

- Core operation logic (delegated to [interfaces/shared/](../shared/) and domain modules)
- MCP protocol handling (see [interfaces/mcp/](../mcp/))

## Contains

- `index.ts` — All 14 CLI commands: `init`, `sync`, `search`, `remember`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `migrate`, `validate`

## See Also

- [interfaces/shared/](../shared/) — Shared operation logic used by CLI and MCP
- [interfaces/](../) — Parent interfaces module
- [docs/user-guide.md](../../../docs/user-guide.md) — User-facing CLI documentation
