# Hermes memory-provider plugin for engram

A user-lane Hermes memory provider (`$HERMES_HOME/plugins/engram/`) that plugs
engram into Hermes' memory pipeline (prefetch, tool schemas, lifecycle) and
makes `hermes memory status` report the provider as installed. It does not
touch any `mcp_servers.engram` MCP wiring you may also have.

This is the only Hermes plugin tree in the repo. Two transports live here and
share one config file; pick with `"transport"` in `$HERMES_HOME/engram.json`.

| Transport | Module | When to use |
|-----------|--------|-------------|
| `http` (default) | `__init__.py` | The engram HTTP MCP server is already running (LaunchAgent / `engram serve`). Thin and stateless: automatic recall plus one `engram_memory_save` tool. |
| `stdio` | `provider.py`, `mcp_client.py` | No long-running server; the plugin spawns engram's MCP server as a lazy stdio child per primary agent context, with per-profile scoped writes and `engram_*` recall/explore/reflect/remember tools. |

## What the http transport does

| Hook | Behaviour |
|------|-----------|
| `is_available()` | `GET {base_url}/health` → True iff HTTP 200 and `status == "ok"` |
| `prefetch(query)` | Calls the `recall` MCP tool with the user message and a small token budget; injects the XML result as turn context. Any failure returns `""`. |
| `get_tool_schemas()` | Exactly one model tool: `engram_memory_save(content, type?, importance?)` |
| `handle_tool_call()` | Proxies `engram_memory_save` to the `remember` MCP tool |
| `system_prompt_block()` | A static, byte-stable instruction block (no timestamps, no counts) |
| `sync_turn` / `on_session_end` / `on_memory_write` / `on_pre_compress` | No-ops — engram's dream pipeline owns ingestion |
| `backup_paths()` | `~/.local/share/engram/engram.db` |

A five-failure circuit breaker (120 s cooldown) mirrors the bundled mem0
provider so a down server never adds latency to every turn. The tool is named
`engram_memory_save` (not `engram_*`-prefixed like the MCP tools) so it cannot
collide when the MCP server is also configured.

## What the stdio transport does

Spawns `node dist/interfaces/mcp/server.js` from `repo_path` on first use in a
primary agent context (cron, subagent, and flush contexts never pay the Node
cost), scopes writes to `hermes:<profile>` via the child's environment, exposes
`engram_recall` / `engram_explore` / `engram_reflect` / `engram_remember`, mirrors
Hermes's built-in MEMORY.md writes into the graph on a background thread, and
reaps the idle child after `idle_kill_s`. It also ships a `hermes engram
{status|recall}` CLI (`cli.py`) and a dashboard config schema
(`config_schema.py`); see Deploy for why those two files are opt-in.

## Configuration — `$HERMES_HOME/engram.json`

Non-secret; written by `hermes memory setup engram` or by hand. All keys are
optional.

| Key | Transport | Default | Meaning |
|-----|-----------|---------|---------|
| `transport` | both | `http` | `http` or `stdio` |
| `base_url` | http | `http://127.0.0.1:9907` | MCP server base URL (`/mcp` and `/health` hang off it) |
| `timeout_secs` | http | `4` | HTTP timeout for health + per-turn recall (cold recall ≈ 2 s on a large store; timeouts are logged and shown as a miss) |
| `prefetch_token_budget` | http | `300` | recall token budget per turn |
| `repo_path` | stdio | this checkout | engram checkout containing `dist/` |
| `node_path` | stdio | PATH lookup | node >= 22 binary |
| `db_path` | stdio | engram default | override the SQLite DB |
| `budget` | stdio | `1200` | prefetch token budget |
| `read_scopes` | stdio | `global,hermes:<profile>` | recall visibility |
| `idle_kill_s` | stdio | `600` | reap the Node child after idle |

```json
{ "base_url": "http://127.0.0.1:9907", "timeout_secs": 4, "prefetch_token_budget": 300 }
```

## Layout

```
interfaces/hermes-plugin/
├── __init__.py              # entry point; http provider + minimal MCP client (stdlib only)
├── provider.py              # stdio provider (EngramMemoryProvider)
├── mcp_client.py            # stdio JSON-RPC client (McpStdioClient)
├── cli.py                   # `hermes engram` CLI (stdio transport)
├── config_schema.py         # Hermes dashboard schema (stdio transport)
├── plugin.yaml              # manifest (name/version/description)
├── deploy.sh                # copies runtime files into $HERMES_HOME (and optional profiles)
├── README.md, SPEC.md
└── tests/                   # http + stdio suites (see Tests)
```

## Deploy

```sh
# default profile only ($HERMES_HOME, default ~/.hermes)
interfaces/hermes-plugin/deploy.sh

# also deploy to named profiles (space-separated; missing profiles are skipped)
ENGRAM_PLUGIN_PROFILES="alpha beta" interfaces/hermes-plugin/deploy.sh
```

Copies (not symlinks) `__init__.py`, `provider.py`, `mcp_client.py`,
`plugin.yaml`, and `README.md` into `$HERMES_HOME/plugins/engram/` and into
`$HERMES_HOME/profiles/<name>/plugins/engram/` for each named profile. With the
variable unset the script deploys to the default profile only and prints a
hint. Restart the gateways afterwards so running agents pick up the new code.

`cli.py` and `config_schema.py` are not copied: Hermes loads both automatically
whenever they sit in the active provider's directory, and they describe the
stdio transport. If you run `"transport": "stdio"`, copy them in (or symlink
this directory instead of running `deploy.sh`) and set `repo_path`.

Then, per profile:

```yaml
# $HERMES_HOME/config.yaml
memory:
  provider: engram
```

Rollback: `hermes memory off` (or delete the plugin directory).

## Tests

```sh
cd /path/to/your/engram/checkout
PYTHONPATH=~/.hermes/hermes-agent python3 -m pytest interfaces/hermes-plugin/tests/ -q
```

The `agent` and `tools` packages only resolve inside the hermes-agent tree,
hence the `PYTHONPATH`. The http suite mocks `urllib`; the stdio suites drive
`tests/fake_mcp_server.py`; `test_stdio_e2e_real_server.py` runs the real built
server on a temp DB and skips when `dist/` is missing (`npm run build`).

## Validate

```sh
hermes plugins doctor engram
hermes memory status
```
