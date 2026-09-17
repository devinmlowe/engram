# SPEC — Hermes Memory Provider Plugin

## Purpose

Expose engram's knowledge graph to [Hermes Agent](https://github.com/NousResearch/hermes-agent)
as an external `MemoryProvider`: automatic recall injected before every turn,
plus curated writes. This is the single canonical plugin tree (GitHub issue #9
consolidated the former `integrations/hermes-plugin/` stdio provider into it).

## Requirements

- **R1** Subclass Hermes's real `MemoryProvider` ABC (`agent/memory_provider.py`);
  implement `name`, `is_available`, `initialize`, `get_tool_schemas`,
  `handle_tool_call`, `prefetch`, `system_prompt_block`.
- **R2** One entry point, `register(ctx)` in `__init__.py`, which registers the
  provider for the transport named by `transport` in `$HERMES_HOME/engram.json`.
  Unknown or missing values select `http`.
- **R3** `http` transport (default; `__init__.py`): talk to the running engram
  streamable-HTTP MCP server (`base_url`, default `http://127.0.0.1:9907`).
  `is_available()` is `GET /health`; `prefetch()` calls `recall` with
  `prefetch_token_budget`; exactly one model tool, `engram_memory_save`,
  proxies to `remember`. A five-failure circuit breaker (120 s cooldown, then a
  single half-open probe whose failure re-opens it without resetting the
  count) keeps a down server from taxing every turn; queued turns survive
  transport failures and are dropped only when the live server rejects them. Ingestion hooks are no-ops (engram's
  dream pipeline owns ingestion).
- **R4** `stdio` transport (`provider.py`, `mcp_client.py`): spawn engram's MCP
  server as a persistent stdio child, lazily and only when
  `agent_context == "primary"`; stdlib-only JSON-RPC client. Child env carries
  `ENGRAM_SCOPE=hermes:<profile>` and `ENGRAM_READ_SCOPES=global,hermes:<profile>`
  so no tool argument can widen the write scope. Tools are namespaced
  `engram_*`; `on_memory_write` mirrors are drained on a background thread;
  the idle child is reaped after `idle_kill_s`.
- **R5** `prefetch()` never raises; failures return `""` within Hermes's 8 s
  external-prefetch ceiling.
- **R6** `system_prompt_block()` is byte-stable for the life of a conversation.
- **R7** Config lives in `$HERMES_HOME/engram.json` (non-secret, written
  atomically 0600). Both transports read the same file; their key sets do not
  overlap.
- **R8** `deploy.sh` copies (never symlinks) the runtime files into
  `$HERMES_HOME/plugins/engram` and, when `ENGRAM_PLUGIN_PROFILES` names
  profiles, into `$HERMES_HOME/profiles/<name>/plugins/engram`. Profile names
  are never hardcoded. `cli.py` and `config_schema.py` (stdio-only `hermes
  engram` CLI and dashboard schema) are not copied, because Hermes auto-loads
  them when present and they describe the stdio transport.
- **R9** Personal or fleet-specific names must not appear in examples, docs,
  or tests.

## Interface

- `__init__.py` — `register(ctx)`, `make_provider(transport=None)`,
  `selected_transport()`, `EngramMemoryProvider` (http), `EngramMcpClient`.
- `provider.py` — `EngramMemoryProvider` (stdio); `mcp_client.py` —
  `McpStdioClient`.
- `cli.py` — `register_cli(subparser)` / `engram_command(args)` for the stdio
  transport; `config_schema.py` — `CONFIG_SCHEMA` for the Hermes dashboard.

## Verification

```sh
PYTHONPATH=~/.hermes/hermes-agent python3 -m pytest interfaces/hermes-plugin/tests -q
```

- `test_plugin_packaging.py` — discovery heuristic, `plugin.yaml` identity,
  `register()` entry point and transport selection, SRC docs present.
- `test_http_provider.py` — http transport contract with `urllib` mocked.
- `test_stdio_provider.py`, `test_stdio_mcp_client.py`,
  `test_stdio_cli_and_config.py` — stdio transport against
  `tests/fake_mcp_server.py` and the live Hermes ABC.
- `test_stdio_e2e_real_server.py` — stdio provider against the real built MCP
  server on a temp DB (skips when `dist/` is absent).
