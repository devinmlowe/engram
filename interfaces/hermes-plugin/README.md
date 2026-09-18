# Hermes memory-provider plugin for engram

A user-lane Hermes memory provider (`$HERMES_HOME/plugins/engram/`) that plugs
engram into Hermes' memory pipeline (prefetch, tool schemas, lifecycle) and
makes `hermes memory status` report the provider as installed. It does not
touch any `mcp_servers.engram` MCP wiring you may also have.

This is the only Hermes plugin tree in the repo. Two transports live here and
share one config file; pick with `"transport"` in `$HERMES_HOME/engram.json`.

| Transport | Module | When to use |
|-----------|--------|-------------|
| `http` (default) | `__init__.py` | The engram HTTP MCP server is already running (LaunchAgent / `engram serve`). Thin and stateless: automatic recall plus the `engram_memory_save` and `engram_memory_forget` tools. |
| `stdio` | `provider.py`, `mcp_client.py` | No long-running server; the plugin spawns engram's MCP server as a lazy stdio child per primary agent context, with per-profile scoped writes and `engram_*` recall/explore/reflect/remember/forget tools. |

## What the http transport does

| Hook | Behaviour |
|------|-----------|
| `is_available()` | Config/deps only, **no network** (MemoryProvider contract): `engram.json` parses (or is absent) and `base_url` is an http(s) URL. |
| `initialize(session_id, …)` | Loads config, derives the profile scope, applies context gating, probes `GET {base_url}/health` once (feeds `unavailable_reason()` only), then fires one background warm-up `recall` so the daemon's embedder/reranker are hot before the first turn (`limit: 1`, `reinforce: false`; errors ignored). |
| `prefetch(query)` | Calls the `recall` MCP tool with the user message and `prefetch_token_budget`; injects the XML result as turn context. Any failure returns `""` — a timeout additionally logs a warning (at most once per 10 min) and is shown in the recall indicator (see Troubleshooting). |
| `recall_status()` | `Engram — recalled N memories` after a hit; a ⚠️ `Engram (recall timed out after Ns; no memory this turn)` after a timeout; nothing otherwise. |
| `get_tool_schemas()` | Two model tools: `engram_memory_save(content, type?, importance?)` → the `remember` MCP tool with `source: "user"`, and `engram_memory_forget(memory_id \| query, confirm?)` → the `forget` MCP tool under `scope: hermes:<profile>` (#55: acts on global memories and this profile's own, never another profile's; query mode returns candidates and only acts with `confirm` and a single match). Both allowed in **every** agent context. |
| `sync_turn()` | Primary context only, `sync_turns: true`: enqueues the completed user/assistant turn for the `ingest_turn` MCP tool (see Turn ingestion). Never touches the network on the caller thread. |
| `on_memory_write()` | Primary context only, `mirror_memory_writes: true`: mirrors Hermes' built-in MEMORY.md / USER.md `add` / `replace` as `remember` (see Built-in memory mirror). `remove` is a no-op. |
| `system_prompt_block()` | A static, byte-stable instruction block (no timestamps, no counts) |
| `on_session_end` / `on_pre_compress` | No-ops — engram's dream pipeline owns consolidation |
| `backup_paths()` | `~/.local/share/engram/engram.db` |
| `shutdown()` | Drains queued turns/writes for up to 2 s, stops the drain thread, closes the MCP session |

A five-failure circuit breaker (120 s cooldown, then half-open: exactly one
probe call, which re-opens the breaker if it fails) mirrors the bundled mem0
provider so a down server never adds latency to every turn. The tools are named
`engram_memory_save` / `engram_memory_forget` (not `engram_*`-prefixed like the
MCP tools) so they cannot collide when the MCP server is also configured.

### Contexts and write gating

Hermes passes `agent_context` (`primary` | `subagent` | `cron` | `flush`) to
`initialize()`; an absent or empty value counts as `primary`.

| Path | Runs in |
|------|---------|
| `sync_turn`, `on_memory_write` (per-turn writes) | `primary` only |
| `prefetch` (automatic recall) | the contexts listed in `prefetch_contexts` (default `["primary"]`; e.g. add `cron` to give scheduled jobs recall) |
| `engram_memory_save`, `engram_memory_forget` (explicit model tools) | every context — a cron job deciding to store a fact is a deliberate one-off write; refusing it would silently lose the fact |
| warm-up recall in `initialize` | only when the context prefetches and `/health` was ok |

### Scoping

Writes are scoped to `hermes:<profile>`. The profile is the `agent_identity`
Hermes passes to `initialize()`; without it, it is derived from `hermes_home`
(`<root>/profiles/<name>` → `name`, the root `~/.hermes` itself → `default`),
else `default`. So the default profile writes under `hermes:default`, and the
profile at `~/.hermes/profiles/career` writes under `hermes:career`. Reads use
the daemon's `ENGRAM_READ_SCOPES` (the plugin sends no `read_scopes`).

### Turn ingestion (`sync_turns`)

Each completed turn becomes one `ingest_turn` call with `session_id`,
`turn_index`, `scope`, `user_text`, `assistant_text`, `timestamp`,
`source: "hermes"`, Hermes' `turn_author` as `author` (`{id, name, is_bot}`) and, when the assistant used tools, a compact
`tool_calls` list. `turn_index` is a per-session, in-process counter starting
at 0; the server upserts on `(session_id, turn_index)`, so a restarted gateway
re-ingesting a resumed session updates rows in place instead of duplicating
them. Turns ride a bounded in-memory queue (16 items, drop-oldest — a dropped
turn leaves a `turn_index` gap the server tolerates) drained by one background
thread; a turn that fails on transport is kept and retried (the first failures retry at the poll interval, the fifth trips the breaker), while the breaker is open the drain thread parks (queued items stay put; after the cooldown one probe post is tried and a failing probe re-opens the breaker with the turn still parked — only queue overflow drops turns, and `unavailable_reason()` reports how many), and only a turn the live server rejects (`isError`) is dropped. `shutdown()` flushes what it can for up to 2 s.
Ingested turns are what the nightly dream pipeline extracts memories from,
inheriting the profile scope.

### Built-in memory mirror (`mirror_memory_writes`)

`add` / `replace` of the Hermes MEMORY.md (`memory` → type `fact`) and USER.md
(`user` → type `preference`) memory tool are mirrored as `remember` under the
profile scope with `source: "hermes-mirror"`, `context: "mirrored from built-in memory: <add|replace>"` and importance 0.6 (servers older than #19 reject `hermes-mirror`; deploy the server first). `replace` sends only
the new text: engram's `remember` dedup merges/supersedes the old wording
there. Writes share the turn queue and drain thread.

## What the stdio transport does

Spawns `node dist/interfaces/mcp/server.js` from `repo_path` on first use in a
primary agent context (cron, subagent, and flush contexts never pay the Node
cost), scopes writes to `hermes:<profile>` via the child's environment, exposes
`engram_recall` / `engram_explore` / `engram_reflect` / `engram_remember` / `engram_forget`, mirrors
Hermes's built-in MEMORY.md writes into the graph on a background thread, and
reaps the idle child after `idle_kill_s`. It also ships a `hermes engram
{status|recall}` CLI (`cli.py`) and a dashboard config schema
(`config_schema.py`); see Deploy for why those two files are opt-in.

## Configuration — `$HERMES_HOME/engram.json`

Non-secret; written by `hermes memory setup engram` or by hand. All keys are
optional.

| Key | Transport | Default | Meaning |
|-----|-----------|---------|---------|
| `transport` | both | `http` | `http` or `stdio` (unknown values fall back to `http` with a warning) |
| `base_url` | http | `http://127.0.0.1:9907` | MCP server base URL (`/mcp` and `/health` hang off it); must be http(s) or `is_available()` is false |
| `timeout_secs` | http | `4.0` | HTTP timeout for the health probe, the warm-up and per-turn recall. Cold recall on a ~17K-memory store measured ≈ 2 s (warm 0.7–1.1 s); Hermes caps external prefetch at 8 s. Minimum 0.1. |
| `prefetch_token_budget` | http | `300` | `recall` token budget per turn (clamped to 100–5000) |
| `sync_turns` | http | `true` | enqueue every primary-context turn to `ingest_turn` |
| `mirror_memory_writes` | http | `true` | mirror built-in MEMORY.md / USER.md adds and replaces to `remember` |
| `prefetch_contexts` | http | `["primary"]` | agent contexts that get automatic recall; a JSON list or comma-separated string of `primary`, `subagent`, `cron`, `flush` (unknown names dropped; empty → default) |
| `token` | http | `""` | bearer token sent as `Authorization: Bearer …` on `/mcp` when the daemon runs with `ENGRAM_MCP_TOKEN` (never on `/health`, never logged). The one secret in the file; `engram.json` is written mode 0600 |
| `repo_path` | stdio | this checkout | engram checkout containing `dist/` |
| `node_path` | stdio | PATH lookup | node >= 22 binary |
| `db_path` | stdio | engram default | override the SQLite DB |
| `budget` | stdio | `1200` | prefetch token budget |
| `read_scopes` | stdio | `global,hermes:<profile>` | recall visibility |
| `idle_kill_s` | stdio | `600` | reap the Node child after idle |

```json
{ "base_url": "http://127.0.0.1:9907", "timeout_secs": 4, "prefetch_token_budget": 300,
  "sync_turns": true, "mirror_memory_writes": true, "prefetch_contexts": ["primary"] }
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

**fish users:** fish does not expand `~` inside `VAR=~/...`, so
`env HERMES_HOME=~/.hermes hermes …` hands Hermes the literal string `~/.hermes`
(which it resolves against cwd, creating a stray `./~/.hermes`). Write
`env HERMES_HOME=$HOME/.hermes hermes …` instead. The plugin itself expands a
literal `~` in `HERMES_HOME` / `HERMES_AGENT_DIR` defensively (#33).

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

## Troubleshooting (http transport)

| Symptom | Cause / what to check |
|---------|-----------------------|
| `hermes memory status` shows engram installed but `unavailable_reason()` says "unreachable at …/health" | The daemon is down. The plugin still activates (`is_available()` is config-only) and degrades: recall returns nothing, writes queue (and drop on overflow). Check the daemon (`scripts/install-mcp-daemon.sh status`, or `engram doctor`) / `curl {base_url}/health`. A later successful call clears the reason. |
| Recall indicator shows ⚠️ `Engram (recall timed out after 4s; no memory this turn)` and the log has `engram recall timed out after 4.0s` | The first recall of a session is cold, or the daemon is loaded. The warm-up on `initialize()` normally hides the cold start; if misses persist, raise `timeout_secs` (≤ 8) or check the daemon's load. The warning repeats at most every 10 minutes; the indicator shows every miss. |
| Log: `engram circuit breaker tripped after 5 consecutive failures; pausing calls for 120s` | Five failed calls in a row (any tool). Recall returns nothing and queued turns/writes wait in the bounded queue until the cooldown ends; then one probe call is allowed: on success everything posts, on failure the log says `engram circuit breaker probe failed; staying open for another 120s` and the queue keeps waiting. Only queue overflow (16 items) drops them, counted in `unavailable_reason()`. |
| Memories land under `hermes:default` instead of the profile | The gateway did not pass `agent_identity` and `hermes_home` was not `<root>/profiles/<name>`. Run the profile's own gateway (its `HERMES_HOME`) or check the `agent_identity` it reports. |
| Turns are not ingested | Non-primary context (`subagent`/`cron`/`flush` never ingest), `sync_turns: false`, an empty session id, or the breaker is open. Debug-level log lines say which. |
| Two engram tool sets appear to the model | The MCP server is also wired as `mcp_servers.engram`. That is fine: this plugin's tools are `engram_memory_save` / `engram_memory_forget`, named not to collide. |

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
