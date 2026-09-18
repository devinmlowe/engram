# MCP Server

Model Context Protocol server exposing 16 tools for LLM agent memory operations. Runs as a stdio transport server (bridging to the HTTP daemon when one is healthy, #58/#60) or as a Streamable-HTTP daemon with a worker pool (`--http`), designed for integration with Claude Code and other MCP-compatible agents. Distributed as the Claude Code plugin in `.claude-plugin/` (npx-pinned `engram mcp`) and as `io.github.devinmlowe/engram` on registry.modelcontextprotocol.io (`server.json`).

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
- `bridge.ts` — Daemon-aware stdio entry (#58, decision #60): `decideStdioMode` probes `GET /health` on the daemon port (`--port` / `ENGRAM_MCP_PORT` / 9907) unless `--standalone` or `ENGRAM_MCP_STANDALONE=1`; `runBridge` is the stdio ↔ Streamable-HTTP proxy (MCP client to `/mcp` + MCP server on stdio forwarding `tools/list`, `tools/call`, `ping`; bearer token from `ENGRAM_MCP_TOKEN`; host `clientInfo` re-presented to the daemon; one reconnect on transport failure; exit on stdin EOF); `runStdioEntry` is what `engram mcp` and `server.ts` call. Imports neither `_core/db` nor `_core/embeddings` — `engram mcp` imports it before `server.ts`, so a bridged process never loads the embedding stack or the tool server and opens no database (the CLI's own top-level imports resolve `_core/db`, but nothing is opened)
- `port.ts` — `DEFAULT_MCP_PORT`, `parseMcpPort`, and the `/health` probe (`probeMcpHealth`, `isEngramDaemonHealth`) shared by the server, `engram doctor` and the bridge
- `auth.ts` / `http.ts` — bearer-token gate (#27) and the Streamable-HTTP front end (one `Server` + transport per session, `/health`)
- `dispatch.ts` / `worker-pool.ts` / `worker.ts` — HTTP-mode worker dispatch. A `ToolCallContext` (`{ clientName }` from the session's `clientInfo`) rides every call from `registerToolHandlers` through the pool to `handleToolCall`, so `forget` records the same actor in stdio and HTTP mode

## Annotations

Retrieval tools (`recall`, `recall_session`, `recall_drill`) stay `readOnlyHint: true` although they reinforce the memories they return (FSRS `access_count` / `last_accessed` / `stability`): that is bookkeeping, not a content change, and a write hint would make clients confirm every recall. `reinforce: false` opts out per call. `forget` is the only tool with `destructiveHint: true` (and `readOnlyHint: false`). See [interfaces/SPEC.md](../SPEC.md) INV-3 / INV-4.

## Forget (#55)

`forget` never deletes on a weak match: with `query`, the semantic search recall uses (no reinforcement) produces up to 10 candidates and the call acts only when `confirm` is true and either exactly one candidate came back or exactly one candidate's normalised content equals the normalised query; otherwise it returns the candidates with ids and a hint to call again with `memory_id`. The actor written to `memory_changes` is the MCP client's `clientInfo.name` (`mcp` when absent). Every recalled `<semantic>` carries an `id` attribute for this purpose. Tests: `tests/interfaces/mcp/forget-tool.test.ts` (stdio-equivalent in-memory transport), `tests/interfaces/mcp/forget-tool-http.test.ts` (HTTP + real worker thread).

## Stdio bridge (#58)

`engram mcp` never asks the host to choose a transport: a stdio start bridges to a running daemon (so every host shares one warm process and the plugin's `npx` process stays light) and falls back to the full in-process server otherwise. Tests: `tests/interfaces/mcp/bridge.test.ts` — decision matrix with an injected probe, static import check, and an end-to-end run against a real daemon on an ephemeral port driving a real `engram mcp` child over `StdioClientTransport` (16 tools, remember → recall → forget with `deleted_by` = host `clientInfo.name`, no embeddings/server module loaded, impossible `ENGRAM_DB_PATH` never created, inline fallback, `--standalone`, token forwarded / 401 at startup, exit 0 on stdin close).

## See Also

- [interfaces/shared/](../shared/) — Shared operation logic used by MCP and CLI
- [interfaces/](../) — Parent interfaces module
- [docs/api-reference.md](../../../docs/api-reference.md) — MCP tool documentation
- [decisions/008-parameter-naming.md](../../../decisions/008-parameter-naming.md) — snake_case MCP params
