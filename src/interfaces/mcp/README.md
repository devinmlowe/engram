# MCP Server

Model Context Protocol server exposing 15 tools for LLM agent memory operations. Runs as a stdio transport server, designed for integration with Claude Code and other MCP-compatible agents.

## In Scope

- MCP tool registration and schema definitions (Zod-validated)
- Request routing to shared operation handlers
- Response formatting for LLM consumption (structured text with token budgets)

## Out of Scope

- Core operation logic (delegated to [interfaces/shared/](../shared/) and domain modules)
- CLI-specific formatting (see [interfaces/cli/](../cli/))
- Web visualization (see [interfaces/web/](../web/))

## Contains

- `server.ts` — MCP server with 15 tools: `recall`, `remember`, `show`, `explore`, `reflect`, `recall_session`, `recall_drill`, `explore_selective`, `remember_batch`, `fetch_snippets`, `index_file_structure`, `scan_file`, `commitments`, `commitments_update`, `ingest_turn` (records one external user/assistant turn keyed by `session_id`/`turn_index` with `scope`, `user_text`, `assistant_text`; idempotent upsert)

## Annotations

Retrieval tools (`recall`, `recall_session`, `recall_drill`) stay `readOnlyHint: true` although they reinforce the memories they return (FSRS `access_count` / `last_accessed` / `stability`): that is bookkeeping, not a content change, and a write hint would make clients confirm every recall. `reinforce: false` opts out per call. See [interfaces/SPEC.md](../SPEC.md) INV-3.

## See Also

- [interfaces/shared/](../shared/) — Shared operation logic used by MCP and CLI
- [interfaces/](../) — Parent interfaces module
- [docs/api-reference.md](../../../docs/api-reference.md) — MCP tool documentation
- [decisions/008-parameter-naming.md](../../../decisions/008-parameter-naming.md) — snake_case MCP params
