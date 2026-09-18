# Integrate engram into your agent

**Audience: an AI coding agent.** Hand this whole file to the agent running in
the harness you want to connect (Codex CLI, Claude Code, Cursor, Hermes, a
custom loop). It describes engram's public contract and the behaviors a good
integration has. It does *not* prescribe host-specific mechanics: the agent is
expected to discover its own harness's hook, MCP, and instruction-file
mechanisms and wire them to this contract. A worked Codex CLI example is at the
end as a reference, not a recipe.

Human operator: read the "What you get" and "Before you hand this over"
sections, then paste the file (or its URL) into your agent with a prompt like:

> Read this document and integrate engram into this harness. Discover how this
> harness supports MCP servers, per-turn hooks, and instruction files, then
> implement the three behaviors in the order given. Verify each step with the
> checks in the document before moving on. Report what you could and could not
> wire, and why.

---

## What you get

engram is a local-first memory system: a SQLite knowledge graph with hybrid
search (vector + full-text + graph), consolidated nightly by a "dream" pipeline.
It speaks the Model Context Protocol (MCP) over **stdio** or **Streamable
HTTP**. Any MCP-capable host can use it as a tool provider. Hosts with per-turn
hooks can go further and get memories injected automatically **before each
turn**, which is the behavior this document is really about.

The three integration behaviors, in priority order:

1. **Auto-recall.** Before each turn, query engram with the user's prompt and
   inject the result as context. The model never has to remember to search.
2. **Explicit tools.** Register engram as an MCP server so the model can call
   `recall`, `remember`, `explore`, and friends on demand.
3. **Capture.** When the user states a lasting preference, decision,
   convention, or fact, store it with `remember`. Either the model does this
   through the tool (guided by a static instruction block) or a post-turn hook
   does it. Prefer the model-driven path; it produces cleaner memories.

A reference implementation of all three exists for Hermes Agent at
`interfaces/hermes-plugin/__init__.py`. Its `EngramMcpClient` class is a
dependency-free Python Streamable-HTTP MCP client that is known to work against
engram; copy it rather than writing a new one.

---

## Before you hand this over (human checklist)

- Node.js 22 or newer is installed on the machine where engram will run.
- engram is cloned, built, and initialized (see "Install" below). The embedding
  model download on first `engram init` needs internet access and a few
  minutes.
- You have decided whether the agent host and engram run on the **same
  machine**. The HTTP server binds to `127.0.0.1` only and has no
  authentication. Remote hosts need an SSH tunnel or Tailscale-style overlay;
  do not expose the port.
- **Windows note.** engram is developed and exercised on macOS. The launchd
  supervision scripts in `launchd/` are macOS-only. On Windows the repo now
  ships `scripts/install-mcp-daemon.ps1`, which registers a per-user Task
  Scheduler task (`\Engram\MCP`, at logon) for the HTTP daemon. On Linux the
  agent must supervise the HTTP daemon with a systemd user unit or an
  equivalent. Native modules (`better-sqlite3`, `sqlite-vec`) must
  build for the platform; treat a successful `engram health` as the gate.

---

## Install

```bash
git clone https://github.com/devinmlowe/engram.git
cd engram
npm install          # also runs the TypeScript build via the "prepare" script
npm link             # puts `engram` on PATH (optional; the CLI is dist/interfaces/cli/index.js)
engram init          # creates the database and downloads the embedding model
engram health        # database, embedding model, MCP readiness
```

Defaults the agent needs to know:

| Item | Value |
|------|-------|
| Database | `~/.local/share/engram/engram.db` (override: `ENGRAM_DB_PATH`) |
| MCP server entry point | `dist/interfaces/mcp/server.js` |
| stdio transport | `npx -y @devinmlowe/engram mcp` (from npm), or `node dist/interfaces/mcp/server.js` from a checkout. Bridges to the HTTP daemon when one is healthy on the port below; `--standalone` forces in-process |
| Registry entry | `io.github.devinmlowe/engram` on registry.modelcontextprotocol.io (npm artifact `@devinmlowe/engram`, stdio) — hosts that install from the registry get the same `npx … mcp` command |
| HTTP transport | `node dist/interfaces/mcp/server.js --http` on `http://127.0.0.1:9907` (`--port N` to change) |
| Nightly consolidation | `engram dream` (macOS: `scripts/install-daemon.sh install` installs a 02:00 launchd job) |

**Choose HTTP when a hook script needs to talk to engram.** A hook script runs
as a separate short-lived process; spawning a fresh stdio server per turn
would reload the embedding model every time. Run one HTTP daemon and let hooks
and the host's MCP client both point at it.

---

## The contract

### HTTP endpoints

- `GET /health` returns HTTP 200 with a JSON body `{"status": "ok", ...}`.
  Use it as the availability check before every recall path. `GET /` is an
  alias.
- `POST /mcp` is the Streamable HTTP MCP endpoint. One MCP session per client,
  routed by the `Mcp-Session-Id` header.

### MCP handshake (Streamable HTTP)

1. `POST /mcp` with method `initialize`, `protocolVersion` `"2025-03-26"`,
   headers `Content-Type: application/json` and
   `Accept: application/json, text/event-stream`.
2. Read the `mcp-session-id` response header and send it on every later
   request.
3. `POST /mcp` with `notifications/initialized` (server answers 202, no body).
4. `POST /mcp` with `tools/call` (or `tools/list`).

Responses may arrive as plain JSON **or** as an SSE stream
(`Content-Type: text/event-stream`) whose `data:` lines carry JSON-RPC
messages; take the last one that has `result` or `error`.

**Caveat:** the server hangs (never answers) on an unknown or missing session
id. Bound every request with a timeout, and on any failure drop the cached
session id and re-initialize. This is exactly what `EngramMcpClient` does.

### Tools

Twelve tools, registered in `src/interfaces/mcp/tool-names.ts`:

| Tool | Use it for |
|------|-----------|
| `recall` | Hybrid search across memories, conversations, and graph. **This is the auto-recall call.** |
| `remember` | Store one durable fact verbatim. **This is the capture call.** |
| `remember_batch` | Store several facts in one call. |
| `show` | Read a full conversation to extract detailed context after `recall` surfaces it. |
| `explore` | Walk the knowledge graph from a concept. |
| `reflect` | Communities, bridges, temporal patterns, graph health. |
| `recall_session` | Create or continue an iterative, multi-step search session. |
| `recall_drill` | Expand one result from a recall session. |
| `explore_selective` | Graph walk that expands only the branches you name. |
| `fetch_snippets` | Fetch several line ranges from one file in a single call. |
| `scan_file` | Regex-scan a file server-side and return structured matches. |
| `commitments` | List the user's tracked commitments (pending by default; overdue first). Call it in proactive check-ins. |
| `commitments_update` | Mark a commitment done, dropped, or superseded once the user confirms. |
| `index_file_structure` | Parse a source file into its function, class, and module definitions. |
| `forget` | Remove a memory the user says is wrong. Pass the `id` from a recalled `<semantic id="…">`; or a `query` to get candidates (nothing is deleted unless `confirm` is true and exactly one matches). **This is the correction call.** |

The list above and `tools/list` on a running server are authoritative;
`docs/api-reference.md` documents the five core tools in detail.

**`recall` arguments**

| Argument | Type | Notes |
|----------|------|-------|
| `query` | string, min length 2 | Use the user's prompt verbatim for auto-recall. |
| `budget` | number, 100 to 5000 | Max tokens in the response. 300 is a good auto-recall default; 1200 if the host has room. |
| `dateHint` | string | Natural-language date scoping ("last week"). Optional. |
| `after` / `before` | `YYYY-MM-DD` | Hard date bounds. Optional. |
| `dateBasis` | `"filed"` or `"event"` | Which timestamp the date filters apply to. Optional. |

The response is text wrapped in an `<engram_memory query="..." tokens_used="..."
total_results="N">` element. When `total_results="0"`, inject nothing.

**`remember` arguments**

| Argument | Type | Notes |
|----------|------|-------|
| `content` | string, required | The fact, verbatim. One fact per call. |
| `type` | enum | `preference`, `decision`, `pattern`, `fact`, `solution`, `convention`. Default `fact`. |
| `importance` | number 0 to 1 | Optional. |
| `source` | enum | `user`, `dream`, `rlm`, `import`, `hermes-mirror`. Use `"source": "user"` for anything captured from a conversation. |
| `context` | string | Optional provenance note (≤ 500 chars) stored with the memory. |

`remember` deduplicates against near-identical existing memories, so
re-storing the same fact is safe.

### Scoping (multi-tenant)

Scoping has a per-process default and a per-call override.

| Variable | Effect |
|----------|--------|
| `ENGRAM_SCOPE` | Default write scope stamped on every `remember` / `remember_batch`. |
| `ENGRAM_READ_SCOPES` | Comma-separated scopes `recall` may return by default. When unset but `ENGRAM_SCOPE` is set, defaults to `global` plus the write scope. |

Per call, `recall` and `recall_session` accept `scope` (reads then default to
`global` + that scope) and `read_scopes` (explicit list); `remember` and
`remember_batch` accept `scope`; `ingest_turn` requires `scope`. A parameter
overrides the environment for that call only, so one HTTP daemon can serve
several tenants — the Hermes plugin sends `hermes:<profile>` on every write.
With nothing set the server is single-tenant: writes land in `global`, reads
see everything. Convention: name scopes `<host>:<profile>`, for example
`codex:work` or `hermes:career`.

Because the model can pass `scope` / `read_scopes` itself, the integration
layer (your hook or plugin), not the tool schema, is what pins a tenant: set
the params from your side and do not expose them to the model if it must not
choose its own scope.

**Caveat:** scope filtering applies to the **semantic** memory table only.
Episodic conversation exchanges and graph entities are not scope-filtered.
Do not rely on scopes as a security boundary between users.

### What engram will not do for you

The dream pipeline ingests conversations only from `~/.claude/projects`
(Claude Code's transcript directory). **On any other host, nothing reaches
engram unless it is stored through `remember` or `remember_batch`.** Your
capture behavior is the only ingestion path. Design it accordingly.

---

## Behaviors to implement

### 1. Auto-recall (before each turn)

Find the host's earliest per-turn hook that can add text to the model's
context. Wire a script that:

1. Reads the user's prompt from whatever the host provides (stdin JSON, env
   var, argument).
2. Checks `GET /health` with a short timeout. On anything but `status: ok`,
   exit silently with no output.
3. Calls `recall` with `{"query": <prompt>, "budget": 300}` with a 4 second
   timeout (cold recall on a large store measured ≈ 2 s; warm 0.7–1.1 s).
   Add `"scope": "<host>:<profile>"` for a multi-tenant daemon. Consider one
   cheap warm-up recall (`"limit": 1, "reinforce": false`) at session start
   so the first real turn is not the cold one.
4. If `total_results` is 0, or on any error, produce no output.
5. Otherwise emit the recall text in the host's "additional context" format.

Rules:

- **Memory must never block a turn or break the conversation.** Every failure path returns
  nothing to the model; log timeouts (rate-limited) so misses are not invisible to you.
  Timeouts are mandatory. Add a circuit breaker: after 5 consecutive failures,
  stop calling engram for 120 seconds.
- Keep the injected block small. The Hermes provider uses a 300-token budget.
  If the host caps hook output (Codex previews anything over roughly 2,500
  tokens), stay well under the cap.
- Do not put timestamps, counts, or URLs in any *static* prompt text the host
  caches across turns. Dynamic content goes in the per-turn injection only.

### 2. Explicit tools (MCP registration)

Register engram with the host's MCP client, HTTP transport preferred:

```json
{ "mcpServers": { "engram": { "type": "http", "url": "http://127.0.0.1:9907/mcp" } } }
```

or stdio if the host has no HTTP transport or no hook system at all:

```json
{ "mcpServers": { "engram": { "command": "npx", "args": ["-y", "@devinmlowe/engram", "mcp"] } } }
```

(`node /abs/path/to/engram/dist/interfaces/mcp/server.js` from a checkout does the same.) A
stdio start bridges to the HTTP daemon when it is running, so a host that has both a hook
script talking HTTP and a stdio MCP registration still shares one warm process. Claude Code
users can skip all of this with the plugin: `/plugin marketplace add devinmlowe/engram` then
`/plugin install engram@engram`.

Then add a short **static** instruction block to the host's instruction file
(AGENTS.md, CLAUDE.md, system prompt, or equivalent). Keep it byte-stable so
prompt caching works. The Hermes provider's block, adapted for a tool-based
host:

```
# Engram Memory
Active. Relevant memories from past conversations and consolidated knowledge
are recalled automatically and injected as context before each turn; you do
not need to search for them. For deeper questions call `recall` with a
specific query, or `explore` to walk related concepts.
When the user states a lasting preference, decision, convention, or fact
worth keeping, store it with `remember` (verbatim, one fact per call, source
"user"). Skip transient chit-chat and things already stored.
```

If auto-recall could not be wired, drop the first sentence and tell the model
to call `recall` at the start of any task that might have history.

### 3. Capture (after each turn or session)

Prefer the model-driven path above. If the host offers a post-turn or
session-end hook and you want a safety net, wire a script that extracts
candidate facts from the turn and calls `remember_batch` with
`"source": "user"`. Keep it asynchronous or enqueued: session-end hooks often
have a one to three second budget.

---

## Verify

Run these in order. Each must pass before the next.

```bash
# 1. Daemon is up
curl -s http://127.0.0.1:9907/health
#    -> {"status":"ok",...}

# 2. Handshake + tool listing (session id comes back in a response header)
SID=$(curl -s -D - -o /dev/null http://127.0.0.1:9907/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  | tr -d '\r' | awk 'tolower($1)=="mcp-session-id:"{print $2}')
curl -s http://127.0.0.1:9907/mcp -H "mcp-session-id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
curl -s http://127.0.0.1:9907/mcp -H "mcp-session-id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
#    -> fourteen tools (recall, remember, commitments, ... — tools/list is authoritative)

# 3. Round trip
#    remember {"content":"integration probe: the sky is green","type":"fact","source":"user"}
#    recall   {"query":"what color is the sky","budget":300}
#    -> total_results >= 1 and the probe text appears

# 4. Host-level: start a fresh session in the host, ask "what color is the sky?"
#    The answer should reflect the probe memory without the model calling a tool.
#    Then stop the daemon and ask again: the turn must still complete normally.
```

Report to the operator which of the three behaviors are wired, which hook or
config file each lives in, and what was not possible in this host.

---

## Worked example: Codex CLI

Verified against the Codex documentation in September 2026. Codex changes
quickly; confirm each mechanism against the live docs at
https://developers.openai.com/codex before relying on it.

**What Codex has.** A built-in `memories` feature (its own extraction into
`~/.codex/memories/`, injected at thread start, not pluggable), a **hooks**
system whose `UserPromptSubmit` event fires on every turn and accepts
`additionalContext`, MCP servers over stdio and Streamable HTTP, and
`AGENTS.md` instruction files (32 KiB budget). There is no memory-provider
API. Hooks are the only per-turn injection point.

**Auto-recall** — `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "python3 /abs/path/engram-codex-recall.py", "timeout": 10, "statusMessage": "Recalling memories" } ] }
    ]
  }
}
```

The script reads JSON from stdin (`prompt`, `cwd`, `session_id`, `turn_id`),
calls `recall` over HTTP using a copy of `EngramMcpClient`, and prints:

```json
{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "<engram_memory ...>...</engram_memory>"}}
```

Print nothing on zero results or any failure. Hooks cannot call MCP tools
through Codex, which is why the script speaks HTTP to engram directly.

**Explicit tools** — `~/.codex/config.toml` (or `codex mcp add engram --url http://127.0.0.1:9907/mcp`):

```toml
[mcp_servers.engram]
url = "http://127.0.0.1:9907/mcp"
startup_timeout_sec = 20
tool_timeout_sec = 45
```

**Instruction block** — append the static block from Behavior 2 to
`~/.codex/AGENTS.md`.

**Capture** — optional `Stop` or `SessionEnd` hook in the same `hooks.json`;
`SessionEnd` has a short budget, so enqueue rather than process inline.

**Avoid double memory.** Either disable Codex's native feature
(`[features] memories = false`) or accept that Codex will also summarize
threads into `~/.codex/memories/`. Running both is harmless but redundant.

---

## Other hosts, briefly

- **Claude Code:** the plugin (`/plugin marketplace add devinmlowe/engram`, `/plugin install engram@engram`) or `claude mcp add --transport stdio --scope user engram -- npx -y @devinmlowe/engram mcp` (or the HTTP form). Auto-recall via a `UserPromptSubmit` hook works the same way as Codex. Claude Code is also the host whose transcripts the dream pipeline ingests natively.
- **Hermes Agent:** already done; deploy with `interfaces/hermes-plugin/deploy.sh`. Hermes has a real memory-provider interface, so no hooks are needed.
- **Anything else with MCP but no hooks:** register the server, add the instruction block with the "call `recall` first" variant, and accept that recall is model-initiated.

## See also

- [README.md](../README.md) — transports, worker pool, configuration
- [user-guide.md](./user-guide.md) — install and daily usage
- [api-reference.md](./api-reference.md) — tool and CLI reference
- `interfaces/hermes-plugin/README.md` — the reference provider integration
