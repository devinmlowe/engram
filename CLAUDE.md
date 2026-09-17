# CLAUDE.md — Engram

Cognitive memory system that ingests LLM conversation history and consolidates it into structured knowledge via autonomous "dream state" processing. See SPEC.md for full specification.

## Architecture

Four domains with shared core infrastructure:

- **episodic** — Conversation archive ingestion, indexing, episodic search
- **semantic** — Knowledge extraction, consolidation, adaptive chunking, decay
- **graph** — Entity/relationship graph, topic clusters, file structure indexing, reflection
- **dream** — Autonomous consolidation pipeline (ingest → extract → consolidate → reflect → prune)

Shared infrastructure in `_core/` (config, db, types, embeddings, search, llm, cache). Interfaces in `interfaces/` (CLI, MCP server, web visualization).

## Engram MCP Tools

### Core Tools

- **recall** — Hybrid search (vector + FTS5 + graph) with token budget enforcement
- **remember** — Store a single memory (fact, decision, pattern, solution, convention, preference)
- **show** — Retrieve full conversation or memory context
- **explore** — Fixed-depth graph traversal from an entity
- **reflect** — Graph analysis — communities, bridges, temporal patterns

### Memory & Knowledge (Phase 6 RLM)

- **recall_session** — Create/resume a stateful recall session with token budget tracking
- **recall_drill** — Drill into a specific memory for full content with budget deduction
- **explore_selective** — Criteria-driven graph traversal; returns relevant nodes without loading raw data
- **remember_batch** — Batch ingest memories with adaptive chunking and dedup

### File Analysis (Phase 7)

- **index_file_structure** — Parse a source file server-side; extract and index functions, classes, modules as graph entities. Use FIRST on unfamiliar files to get a structural map before reading.
- **fetch_snippets** — Read multiple line ranges from a file in one call (session budget aware). Replaces multiple Read calls with a single request.
- **scan_file** — Apply up to 10 regex patterns against a file server-side; returns structured matches with context lines and enclosing function name. The file is NEVER loaded into context.

### Commitments Ledger

- **commitments** — List tracked commitments extracted nightly from conversations (first-person promises, intentions, follow-ups owed by others). Pending by default; overdue first, then by due date. `include_due_within_days` narrows to what is due soon.
- **commitments_update** — Mark a commitment `done`, `dropped`, or `superseded` (with `superseded_by`) once the user confirms it is handled.

### External Ingestion

- **ingest_turn** — Record one user/assistant turn of an external agent session (`session_id`, `turn_index`, `scope`, `user_text`, `assistant_text`); idempotent upsert, extracted memories inherit the scope. 15 tools total; `src/interfaces/mcp/tool-names.ts` is canonical.

Recall tools (`recall`, `recall_session`, `recall_drill`) reinforce returned memories (FSRS bookkeeping only) and keep `readOnlyHint: true`; `reinforce: false` opts out. `recall`/`recall_session`/`remember`/`remember_batch` accept per-call `scope` / `read_scopes` over the `ENGRAM_SCOPE` / `ENGRAM_READ_SCOPES` defaults.

### Recommended Workflow

For large file analysis, combine tools in this order:
1. `index_file_structure` → structural map (functions, classes, relationships)
2. `explore_selective` → find relevant code by criteria without reading the file
3. `scan_file` → exhaustive regex search for enumeration tasks (breadth)
4. `fetch_snippets` → read specific line ranges for detail extraction (depth)

## CLI Commands (22)

`init`, `sync`, `search`, `remember`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `migrate`, `validate`, `backfill-event-ts`, `mcp`, `commitments`, `commitment-done`, `commitments-extract`, `doctor`, `export`, `import`

## Web Visualization

Port 3001 — Force graph (`/graph`), 3D depth view (`/graph/depth`), galaxy view (`/graph/galaxy`), word cloud (`/words`). Real-time SSE updates via WAL watching, dream pipeline control with live phase tracking.

Terminal-optimized views at `/terminal/graph`, `/terminal/depth`, `/terminal/words`, `/terminal/communities` — SVG-based, pre-stabilized, high-contrast layouts for carbonyl or other terminal browsers.

**Theme:** Everforest Hard Dark, centralized in `src/interfaces/web/pages/theme.ts`. All page files import colors from this module — no hardcoded hex values in pages. See ADR-009 for theming architecture and carbonyl rendering lessons.

Start: `npx tsx src/interfaces/web/server.ts`

## MCP Server Transports

`dist/interfaces/mcp/server.js` speaks stdio by default. With `--http [--port N]`
(default port 9907) it serves Streamable HTTP at `/mcp` (one MCP session per
client, routed by `Mcp-Session-Id`) plus a `/health` JSON endpoint, bound to
127.0.0.1. A long-running deployment runs it this way via a launchd/systemd
service (KeepAlive, `--http --port 9907`). On Windows, `scripts/install-mcp-daemon.ps1`
registers the equivalent per-user Task Scheduler task (`\Engram\MCP`, at logon)
whose action is `scripts/run-mcp-daemon.ps1`.

In HTTP mode every tool call is dispatched to a `node:worker_threads` pool
(`src/interfaces/mcp/worker-pool.ts`, `dispatch.ts`, `worker.ts`) so a
multi-second recall never blocks `/health`, the handshake, or other clients.
Each worker owns its own better-sqlite3 connection (WAL + `busy_timeout`) and
embedding model. Recall sessions are pinned to the worker that created them.
Stdio mode never spawns workers. Startup logs
`Engram MCP HTTP server listening on http://127.0.0.1:9907/mcp (workers: N, ...)`.

- `ENGRAM_HTTP_WORKERS` — worker count in HTTP mode (default 2; `0` = inline on the main thread)
- `ENGRAM_WORKER_TIMEOUT_MS` — per-call timeout (default 8000). `remember`,
  `remember_batch`, `index_file_structure` and `reflect --refresh` use higher
  floors. A worker still silent at 2× the timeout is killed and respawned.

## Key Configuration

- `ENGRAM_DB_PATH` — Database path (default: `~/.local/share/engram/engram.db`)
- `ENGRAM_CHUNKING_STRATEGY` — `fixed` or `adaptive` (content-aware chunk boundaries)
- `ENGRAM_LOCAL_MODEL` / `ENGRAM_LOCAL_MODEL_FALLBACKS` / `ENGRAM_OPENROUTER_MODEL` — Ollama model (+ ordered fallbacks when it is not pulled) and OpenRouter model; `OLLAMA_HOST`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` enable the three cascade tiers. All-tier failures name every tier's reason (`CascadeError`); dream checkpoints record it once per conversation per run

## Development

```bash
npm run build        # TypeScript compilation
npm run test:run     # Run tests (vitest, 111 test files)
npm run mcp          # Start MCP server
npm run dev          # Dev CLI via tsx
npm run dream        # Run dream consolidation
npm run lint         # Type-check without emit
```

tmux panes on this machine run fish, which does not expand `~` inside `VAR=~/...`; commands sent to panes must use `$HOME`, never `~`, inside `VAR=…` assignments (e.g. `env HERMES_HOME=$HOME/.hermes hermes …`). See #33.

## References

- `SPEC.md` — Full specification with requirements and interface contract
- `plans/` — Implementation plans (phases 1–4, phase 6 RLM, phase 7 extensions)
- `decisions/` — Architecture Decision Records (10 ADRs)
