# Hermes memory-provider plugin for engram

A user-lane Hermes memory provider (`$HERMES_HOME/plugins/engram/`) that wraps
the engram streamable-HTTP MCP server. It makes `hermes memory status` report
the provider as installed and plugs engram into Hermes' memory pipeline
(prefetch, tool schemas, lifecycle) without touching the existing
`mcp_servers.engram` MCP wiring.

## What it does

| Hook | Behaviour |
|------|-----------|
| `is_available()` | `GET {base_url}/health` → True iff HTTP 200 and `status == "ok"` |
| `prefetch(query)` | Calls the `recall` MCP tool with the user message and a small token budget; injects the XML result as turn context. Any failure returns `""`. |
| `get_tool_schemas()` | Exactly one model tool: `engram_memory_save(content, type?, importance?)` |
| `handle_tool_call()` | Proxies `engram_memory_save` to the `remember` MCP tool |
| `system_prompt_block()` | A static, byte-stable instruction block (no timestamps, no counts) |
| `sync_turn` / `on_session_end` / `on_memory_write` / `on_pre_compress` | No-ops in v1 — engram's dream pipeline owns ingestion |
| `backup_paths()` | `~/.local/share/engram/engram.db` |

A five-failure circuit breaker (120 s cooldown) mirrors the bundled mem0
provider so a down server never adds latency to every turn.

The tool is named `engram_memory_save` (not `engram_*`-prefixed like the MCP
tools) so it cannot collide when the MCP server is also configured.

## Configuration

Non-secret, stored in `$HERMES_HOME/engram.json` (written by
`hermes memory setup engram`, or by hand):

```json
{
  "base_url": "http://127.0.0.1:9907",
  "timeout_secs": 2,
  "prefetch_token_budget": 300
}
```

All keys are optional; the values above are the defaults. There are no
secrets.

## Layout

```
interfaces/hermes-plugin/
├── __init__.py            # provider + minimal MCP client (stdlib only)
├── plugin.yaml            # manifest (name/version/description)
├── README.md
├── deploy.sh              # copies runtime files into each profile's plugins dir
└── tests/test_provider.py # contract tests, HTTP mocked
```

## Deploy

```sh
interfaces/hermes-plugin/deploy.sh
```

Copies (not symlinks) `__init__.py`, `plugin.yaml`, and `README.md` into
`~/.hermes/plugins/engram/` and
`~/.hermes/profiles/{career,pmp,network,finance}/plugins/engram/` (profiles
that do not exist are skipped). Restart the gateways afterwards so running
agents pick up the new code.

## Tests

```sh
cd ~/git/engram
PYTHONPATH=~/.hermes/hermes-agent python3 -m pytest interfaces/hermes-plugin/tests/ -q
```

The `agent` and `tools` packages only resolve inside the hermes-agent tree,
hence the `PYTHONPATH`. HTTP is mocked by monkeypatching `urllib`.

## Validate

```sh
hermes plugins doctor engram
hermes memory status
```
