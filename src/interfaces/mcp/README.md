# MCP Server

Model Context Protocol server exposing 16 tools for LLM agent memory operations. Runs as a stdio transport server, designed for integration with Claude Code and other MCP-compatible agents.

## In Scope

- MCP tool registration and schema definitions (Zod-validated)
- Request routing to shared operation handlers
- Response formatting for LLM consumption (structured text with token budgets)

## Out of Scope

- Core operation logic (delegated to [interfaces/shared/](../shared/) and domain modules)
- CLI-specific formatting (see [interfaces/cli/](../cli/))
- Web visualization (see [interfaces/web/](../web/))

## Contains

- `server.ts` — MCP server with 16 tools: `recall`, `remember`, `show`, `explore`, `reflect`, `recall_session`, `recall_drill`, `explore_selective`, `remember_batch`, `fetch_snippets`, `index_file_structure`, `scan_file`, `commitments`, `commitments_update`, `ingest_turn` (records one external user/assistant turn keyed by `session_id`/`turn_index` with `scope`, `user_text`, `assistant_text`; idempotent upsert), `forget` (#55: `memory_id` from a recalled `<semantic id>` acts at once; `query` returns `<forget_candidates>` with ids and only acts with `confirm: true` and a single unambiguous match; `hard`, `scope`, `read_scopes`)
- `tool-names.ts` — Canonical `MCP_TOOL_NAMES` (16 entries); tests and docs pin against it
- `dispatch.ts` / `worker-pool.ts` / `worker.ts` — HTTP-mode worker dispatch. A `ToolCallContext` (`{ clientName }` from the session's `clientInfo`) rides every call from `registerToolHandlers` through the pool to `handleToolCall`, so `forget` records the same actor in stdio and HTTP mode

## Annotations

Retrieval tools (`recall`, `recall_session`, `recall_drill`) stay `readOnlyHint: true` although they reinforce the memories they return (FSRS `access_count` / `last_accessed` / `stability`): that is bookkeeping, not a content change, and a write hint would make clients confirm every recall. `reinforce: false` opts out per call. `forget` is the only tool with `destructiveHint: true` (and `readOnlyHint: false`). See [interfaces/SPEC.md](../SPEC.md) INV-3 / INV-4.

## Forget (#55)

`forget` never deletes on a weak match: with `query`, the semantic search recall uses (no reinforcement) produces up to 10 candidates and the call acts only when `confirm` is true and either exactly one candidate came back or exactly one candidate's normalised content equals the normalised query; otherwise it returns the candidates with ids and a hint to call again with `memory_id`. The actor written to `memory_changes` is the MCP client's `clientInfo.name` (`mcp` when absent). Every recalled `<semantic>` carries an `id` attribute for this purpose. Tests: `tests/interfaces/mcp/forget-tool.test.ts` (stdio-equivalent in-memory transport), `tests/interfaces/mcp/forget-tool-http.test.ts` (HTTP + real worker thread).

## See Also

- [interfaces/shared/](../shared/) — Shared operation logic used by MCP and CLI
- [interfaces/](../) — Parent interfaces module
- [docs/api-reference.md](../../../docs/api-reference.md) — MCP tool documentation
- [decisions/008-parameter-naming.md](../../../decisions/008-parameter-naming.md) — snake_case MCP params
