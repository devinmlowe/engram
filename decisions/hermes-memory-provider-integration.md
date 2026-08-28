# ADR-010: Engram as a Hermes Memory Provider

- **Status:** Proposed (autoresearch loop-260828-1251)
- **Date:** 2026-08-28
- **Inputs:** Hermes provider-system map (`~/.hermes/hermes-agent/`), engram API-surface map (`~/git/engram`), both produced by exploration agents 2026-08-28.

## Decision

**Conditional GO — integrate, read-first.** Build an out-of-tree Hermes memory-provider plugin (`~/.hermes/plugins/engram/`) that gives every Hermes profile automatic recall from the existing engram knowledge graph via a persistent MCP-stdio subprocess. **Defer writes** (Hermes→engram) to a second phase that requires a small upstream schema change in engram. Do **not** attempt a full read/write integration in one step — engram's single-tenant data model and lossy dedup make naive writes actively harmful.

The integration is worth doing at all because engram is the only provider option that starts *full*: it already contains months of consolidated knowledge about Devin's projects, infrastructure, and preferences, extracted nightly from Claude Code history. Every bundled Hermes provider — including the closest structural analog `holographic` (local SQLite + FTS5 + entities + trust scores, `plugins/memory/holographic/store.py:17-76`) — begins from an empty store, and `mem0`/`retaindb`/`supermemory` add cloud dependencies and cost. Hermes profiles today run built-in memory only (`~/.hermes/config.yaml:155-161` has no `provider:` key), capped at 2200 chars of `MEMORY.md` — the knowledge asymmetry between Claude Code sessions and Hermes agents is exactly what this closes.

## Context: the two systems

**Hermes** loads at most one external `MemoryProvider` (ABC at `agent/memory_provider.py:81`) discovered config-first (`memory.provider:` key, read at `agent/agent_init.py:1719`) from `$HERMES_HOME/plugins/<name>/` — a pure drop-in: `__init__.py` subclassing `MemoryProvider` with a `register(ctx)` entry point plus `plugin.yaml`, no core edits, proven by the out-of-tree `memori` provider. The manager drives BOTH automatic recall (`prefetch_all()` before each API call, `agent/turn_context.py:1178`, 8s timeout at `agent/memory_manager.py:47`) and explicit tools (`get_tool_schemas()` → `handle_tool_call()`, dispatch at `agent/tool_executor.py:1965`).

**Engram** is TypeScript/Node, single SQLite file (default `~/.local/share/engram/engram.db`), three layers (episodic exchanges, semantic memories, entity graph), hybrid vector+FTS5+graph recall with RRF fusion (`src/_core/search/orchestrator.ts:62-200`). **It has no HTTP memory API** — the :3001 server is a read-only visualizer (`src/interfaces/web/server.ts:74` opens the DB `{readonly: true}`). Memory operations are exposed only via MCP stdio (12 tools, `src/interfaces/mcp/server.ts:75-210`), the `engram` CLI (15 commands, `src/interfaces/cli/index.ts`), or in-process TS import (`src/interfaces/shared/`).

## Architecture options considered

| # | Transport | Verdict |
|---|---|---|
| A | **Subprocess CLI shim** — spawn `engram search`/`engram remember` per call | ❌ Rejected. Every invocation pays Node startup **plus** `@xenova/transformers` embedding-model load (nomic-embed-text-v1.5, `src/_core/config/index.ts:14-18`) — a multi-second cold start per recall that blows the 8-second prefetch budget (`_EXTERNAL_PREFETCH_TIMEOUT_S`, `agent/memory_manager.py:47`) on cache-cold runs and wastes CPU on every turn. |
| B | **Persistent MCP-stdio client** — `initialize()` spawns `node dist/interfaces/mcp/server.js` once per Hermes process; provider speaks JSON-RPC over stdio; `shutdown()` kills it | ✅ **Chosen.** Amortizes cold start to once per session; uses engram's *primary, intended* agent-facing API (all 12 tools); zero engram code changes; process lifetime maps 1:1 onto the provider lifecycle (`initialize()` → `shutdown()`, `agent/memory_provider.py:99-121`, `:190`). |
| C | **New HTTP shim / daemon service** — write a long-running HTTP memory service in front of the library | ❌ Rejected for now. The existing web server is read-only visualization and can't be trivially extended; a new always-on daemon adds launchd surface, auth requirements, and port management for no capability B doesn't already deliver. Revisit only if multiple concurrent Hermes processes make per-process MCP spawns too heavy. |

### Chosen architecture (Option B) — sketch

```
Hermes agent (Python)
  └─ EngramMemoryProvider (~/.hermes/plugins/engram/__init__.py)
       ├─ initialize(session_id, hermes_home=..., platform=..., agent_context=...)
       │    → lazily spawn `node …/dist/interfaces/mcp/server.js` (stdio JSON-RPC)
       │      env: ENGRAM_DB_PATH per scoping policy below
       ├─ prefetch(query) → MCP `recall` {query, budget≈1200, sources:["semantic","graph"]}
       ├─ get_tool_schemas() → engram_recall, engram_explore, engram_reflect,
       │                        engram_recall_session, engram_recall_drill  (namespaced)
       ├─ handle_tool_call() → proxy to matching MCP tool, return JSON string
       ├─ sync_turn(), on_memory_write() → Phase 1: NO-OP (read-only)
       └─ shutdown() → terminate MCP child, bounded wait
```

The stdlib-only JSON-RPC framing over a pipe is ~100 lines of Python; no `mcp` pip dependency is required (though `plugin.yaml` `pip_dependencies` supports one if preferred).

## MemoryProvider contract mapping

| Hermes hook (signature source: `agent/memory_provider.py`) | Engram mapping |
|---|---|
| `name` (`:84-87`) | `"engram"` |
| `is_available()` (`:91-97`) | Check Node ≥22 on PATH, `dist/interfaces/mcp/server.js` exists, DB file readable. **No network, no spawn** — the contract forbids it. |
| `initialize(session_id, **kwargs)` (`:99-121`) | Record `hermes_home`, `agent_identity`, `agent_context`; **lazy-spawn** MCP child on first real use, not here (cron/`flush` contexts must stay cheap). |
| `get_tool_schemas()` (`:172-180`) | Translate engram's Zod schemas (`server.ts:75-210`) to OpenAI function format, names prefixed `engram_` (collision with `toolsets._HERMES_CORE_TOOLS` silently drops tools, `agent/memory_manager.py:437-454`). |
| `prefetch(query)` (`:132`) | MCP `recall` with token `budget` ≈1200 (fits Hermes's context economy; engram enforces budget natively, `shared/search.ts`). Trivial prompts already gated upstream by `is_trivial_prompt` (`memory_provider.py:61`); the `memory_query_rewrite` aux model (`~/.hermes/config.yaml:111-114`) improves query quality for free. |
| `queue_prefetch(query)` (`:146`) | Warm the next turn: fire `recall` on a daemon thread, cache result. |
| `sync_turn(...)` (`:154-161`) | **Phase 1: no-op.** Phase 2: batch-extract facts → `remember_batch` on a background thread (non-blocking, per dev guide `memory-provider-plugin.md:152-168`). |
| `handle_tool_call(name, args)` (`:182`) | Strip `engram_` prefix, forward over MCP, return result as JSON string (contract requires JSON). |
| `on_memory_write(action, target, content)` (`:322-328`) | **Phase 1: no-op.** Phase 2: mirror built-in `MEMORY.md` writes into the graph as scoped memories. |
| `on_session_end(messages)` (`:204`) / `on_pre_compress(messages)` (`:258`) | **Phase 1: no-op.** Phase 2: session-boundary extraction feeding engram's consolidation — note engram's own dream pipeline (02:00 launchd, `launchd/com.engram.dreamstate.plist`) already consolidates nightly, so per-session extraction may be redundant; decide with data. |
| `on_session_switch(...)` (`:214-222`) | Reset the in-provider recall-session cache (engram MCP sessions are process-local, `MAX_SESSIONS=10`, 30-min TTL, `_core/search/session.ts:71-86` — they live in *our* child process, so this just clears IDs). |
| `on_delegation(task, result)` (`:270-271`) | Phase 2 candidate; no-op initially. Subagents never get a provider (`skip_memory=True`, `agent/agent_init.py:1713-1780`) so only the parent sees this. |
| `get_config_schema()` / `save_config()` (`:283`, `:305`) | Fields: `db_path` (default: shared main DB), `budget`, `sources`, `read_only` (default `true`), `node_path`. Non-secret → `$HERMES_HOME/engram.json` (mirror mem0's atomic 0o600 write, `plugins/memory/mem0/__init__.py:236-249`). |
| `backup_paths()` (`:341`) | **Return `[]` deliberately, with a doc comment.** The engram DB lives outside HERMES_HOME and `hermes backup` would otherwise silently omit it — but the DB is multi-hundred-MB shared infrastructure with its own lifecycle, not provider-owned state; swallowing it into every profile's backup is worse. The plugin's own config (inside HERMES_HOME) is captured automatically. This is an explicit, documented exception to the dev-guide default. |
| `shutdown()` (`:190`) | Terminate MCP child; bounded drain of any queued Phase-2 writes (mirrors the manager's own `shutdown_drain_state`, `agent/memory_manager.py:1164`). |

## The tenancy problem — and why read-first resolves it

Engram is **strictly single-tenant**: no namespace/user/agent column anywhere (`schema.ts:95-111`; verified zero matches for tenant/scope identifiers across `src/`). Hermes **requires** per-profile scoping keyed off the `hermes_home` kwarg (`agent/memory_manager.py:1224-1233`; hardcoding `~/.hermes` is called out as wrong in `memory-provider-plugin.md:180-191`). Three resolutions:

1. **DB-per-profile via `ENGRAM_DB_PATH`** — clean isolation, but each profile starts from an *empty* graph, destroying the entire value proposition (the shared knowledge). Wrong default.
2. **Shared DB, read-only** *(Phase 1 choice)* — every profile recalls from the main graph. SQLite WAL supports concurrent readers without contention; no writes means no cross-profile pollution, no dedup hazard, no writer-lock contention. Per-profile scoping still honored: config lives in each profile's `$HERMES_HOME`, and a profile can opt into a different `db_path` or `read_only: false` (Phase 2) independently.
3. **Shared DB, scoped writes** *(Phase 2)* — requires upstream engram changes: a `scope TEXT` column on `memories` (+ filter plumbing through `SearchOptions` → `episodic/semantic/graph` search modules → `orchestrator.ts`), because the existing `source` enum (`user|dream|rlm|import`, `_core/types/index.ts:19`) is a fixed provenance tag, not a tenant key.

## Why writes are deferred (Phase 2 blockers)

- **Lossy dedup:** at ≥0.95 cosine similarity `rememberFact` discards the incoming content entirely rather than merging (`shared/remember.ts:73-82`, `DEDUP_THRESHOLD` `:25`). Hermes agents re-stating a fact with new nuance would silently lose it.
- **Single-writer SQLite:** 4 profiles + cron jobs writing through separate processes contend on the WAL writer lock (engram report §g); the nightly dream pipeline also writes.
- **No scope column:** Hermes-originated memories would be indistinguishable from Claude-Code-derived ones and would leak across profiles (career agent's notes surfacing in finance recalls).
- **Cross-flow risk:** `sync_turn` receives full conversation turns (`memory_provider.py:154-161`); Hermes profiles handle finance and career PII that must not enter a graph consumed by other agents until scoping exists.

## Operational risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| MCP child RSS (~200-500MB embedding model) × 4 profiles × cron jobs | High | Lazy spawn on first non-trivial prefetch; **skip spawn entirely when `agent_context != "primary"`** (cron/subagent/flush), per the kwargs contract (`memory_provider.py:106-121`); idle-kill after N minutes. |
| Cold-start prefetch exceeds 8s timeout on first turn | Medium | Lazy spawn kicked off on `initialize()` in a daemon thread; `prefetch` returns `""` (graceful empty) until warm — manager treats it as no context, not an error. |
| Node/dist not built or moved (repo moved `~/Documents/git`→`~/git` already broke `.mcp.json` and `web/routes/dream.ts:146`) | Medium | `is_available()` checks the resolved `dist/` path; config `node_path`/`repo_path` keys; fix the three stale-path bugs found (also: `com.engram.visualizer.plist:13` points at nonexistent `src/web/graph-server.ts`). |
| Unauthenticated surface — visualizer binds `0.0.0.0:3001`, CORS `*`, reachable over Tailscale (`web/server.ts:56, 226-234`) | Medium (pre-existing) | Not widened by this integration (MCP is stdio child-process only, no network). Still: rebind visualizer to 127.0.0.1 behind Caddy like the other services. Track separately. |
| Orphaned MCP children on Hermes crash | Low | Spawn with process-group kill on `shutdown()`; `SIGTERM` handler; child exits on stdin EOF (stdio transport property). |
| Provider exclusivity — engram occupies the single external-provider slot (`agent/memory_manager.py:413-426`) | Low | No provider is active today; built-in `MEMORY.md`/`USER.md` continues working alongside regardless (`hermes_cli/web_server.py:830-833`). |
| Recall quality drift / prompt injection via recalled text | Low | Hermes already fences and scrubs provider output (`<memory-context>` fencing + `sanitize_context`, `agent/memory_manager.py:174-182`). |

## Rollback

Fully reversible at every step: `hermes memory off` (sets `memory.provider: ""`, `hermes_cli/main.py:10994-11005`) restores built-in-only behavior in one command; Phase 1 never writes to the engram DB, so there is no data migration in either direction; deleting `~/.hermes/plugins/engram/` completes removal.

## Phased plan & effort

- **Phase 0 (½ day):** Fix engram's three stale-path bugs; add `npm run build` freshness check; decide `dist/` deployment location (`/usr/local/lib/engram` per launchd vs repo).
- **Phase 1 (1–2 days):** Read-only provider — `__init__.py` (MemoryProvider subclass + stdio JSON-RPC client), `plugin.yaml`, `config_schema.py`; contract smoke-tests against a temp DB; enable on the **default profile only**; `memory.provider: engram`.
- **Phase 2 (2–3 days, separate decision):** Upstream `scope` column + search filtering in engram; merge-not-discard dedup option; then enable `sync_turn`/`on_memory_write`/`on_session_end` write path and per-profile write scoping.
- **Phase 3 (optional):** `cli.py` for `hermes engram …` subcommands (pattern: `plugins/memory/honcho/cli.py`); dashboard config panel via the declarative `ProviderConfigSchema` (`plugins/memory/config_schema.py:94-106`).

## Open questions

1. Should cron-context agents get read access eventually (e.g., morning-briefing job recalling project state), and if so with what RSS budget? (Current answer: no spawn for non-primary contexts.)
2. Phase 2 dedup semantics: merge vs supersede (`superseded_by` column exists, `schema.ts:95-126`) — which fits Hermes's fact-restating pattern?
3. Does engram's nightly dream consolidation make `on_session_end` extraction redundant, or complementary (Hermes conversations aren't in Claude Code JSONL archives, so the dream pipeline never sees them — likely the strongest Phase-2 argument)?
4. Should `hermes backup` ever include an engram snapshot (e.g., `VACUUM INTO` a bounded export) instead of the all-or-nothing `backup_paths()` choice?

## Alternatives considered

- **`holographic` (bundled):** closest architecture (local SQLite, FTS5, entities), zero integration work — but empty store; engram's existing graph is the point.
- **`mem0` / cloud providers:** mature, but cloud dependency, cost, and a second memory system to reconcile with engram rather than one source of truth.
- **Do nothing:** Hermes keeps 2200-char `MEMORY.md`; knowledge asymmetry persists and each Hermes profile keeps re-learning what engram already knows.
