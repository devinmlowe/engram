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
- **reflect** — Graph analysis — communities, bridges, temporal patterns (health reports `stale_nodes` — entities flagged by `forget`, pruned on the next dream run)
- **forget** — Remove a memory the user says is wrong or stale (#55). `memory_id` (the `id` attribute on every recalled `<semantic>`) acts in one call; `query` runs semantic search and returns candidates with ids, acting only with `confirm: true` and exactly one match (a single result, or one whose content equals the query). Soft delete (#56): `is_active = 0` + `deleted_at`/`deleted_by`, vector + FTS rows removed immediately, a `memory_changes` row (`before` = content, actor = the MCP client's `clientInfo.name`), and a `memory_suppressions` content hash so dream extract does not re-extract it; the dream prune phase hard-deletes after `ENGRAM_FORGET_RETENTION_DAYS`. `hard: true` deletes outright. Graph (#57): decrements `mention_count` on evidenced entities and stamps `stale_since` at zero; never deletes graph rows (`pruneOrphanEntities` does, next run). `readOnlyHint: false`, `destructiveHint: true`; honours `read_scopes` unless `scope: "global"`.

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

- **ingest_turn** — Record one user/assistant turn of an external agent session (`session_id`, `turn_index`, `scope`, `user_text`, `assistant_text`); idempotent upsert, extracted memories inherit the scope. 16 tools total; `src/interfaces/mcp/tool-names.ts` is canonical.

Recall tools (`recall`, `recall_session`, `recall_drill`) reinforce returned memories (FSRS bookkeeping only) and keep `readOnlyHint: true`; `reinforce: false` opts out. `recall`/`recall_session`/`remember`/`remember_batch`/`explore`/`explore_selective`/`commitments` accept per-call `scope` / `read_scopes` over the `ENGRAM_SCOPE` / `ENGRAM_READ_SCOPES` defaults. Since #25 `scope` lives on memories, conversations, exchanges, entities, relationships and commitments (`src/_core/db/scope.ts`): episodic recall, graph search, explore and the commitments ledger filter by `read_scopes`; dream extraction stamps entities/relationships/commitments with the conversation's scope, and a graph row seen from a second scope widens to `global`. `reflect` stays global.

### Recommended Workflow

For large file analysis, combine tools in this order:
1. `index_file_structure` → structural map (functions, classes, relationships)
2. `explore_selective` → find relevant code by criteria without reading the file
3. `scan_file` → exhaustive regex search for enumeration tasks (breadth)
4. `fetch_snippets` → read specific line ranges for detail extraction (depth)

## CLI Commands (27)

`init`, `sync`, `search`, `remember`, `memories`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `migrate`, `import-legacy`, `validate`, `backfill-event-ts`, `mcp`, `commitments`, `commitment-done`, `commitments-extract`, `doctor`, `setup`, `preflight`, `update`, `export`, `import`

`engram doctor` (`src/interfaces/cli/doctor.ts`) runs 14 checks in a fixed order (`DOCTOR_CHECK_NAMES`: node, platform/arch, better-sqlite3, sqlite-vec, transformers.js, model cache, ollama, llm providers, data dir, env file, install path, mcp daemon, hosts, extraction smoke). #61: a check may carry a `fix` (`{describe, needsConfirm, apply}`); `doctor --fix [--yes]` applies every non-ok check's fix, re-runs it and prints `[fixed|applied|skipped|failed] <name>` plus `manual: <command>`; idempotent (`nothing to fix`). Fixes: env file (create `~/.config/engram/env` mode 600 with a commented template — `ensureServiceEnvFile` in `data-migration.ts`; `chmod 600` when wider), model cache (durable dir via the migrate plan + env line + process env), ollama (`ollama pull`, confirm-gated), mcp daemon (start an installed-but-stopped service via `services.ts`), hosts (`mcp install <first present host>`). `extraction smoke` (`src/interfaces/cli/smoke.ts`): the latest ingested conversation (or `prompts/smoke-conversation.json`) through the real extractor, last 3 exchanges / 2 000 chars each, 60 s budget; `tier=<provider> memories=N` or every tier's `CascadeError` reason; real-conversation facts are consolidated into the real DB with `source='smoke'` (`MemorySource`, `ConsolidateOptions.source`; the extractor result carries `provider`), the fixture is never written and no DB is created. `--strict` (exit 1 on any non-ok), `--no-smoke` (update's verify uses it), injectable `DoctorContext`.

`engram setup` (`src/interfaces/cli/setup.ts`, decision #62): doctor → `runInit` → `runSync` (asked; `--sync`/`--no-sync`) → `runMcpInstall` for every present host (`--host`; Hermes deploy offered) → all three daemons via `installService` (`--no-daemons`, `--daemons=<ids>`; already-running left alone; visualizer port/bind line; Linux linger confirm-gated, never implied by `--yes`) → `applyDoctorFixes` → `checkSmoke` → summary + next steps + the `[warn] dream timer installed but no LLM tier is reachable …` line (exit 0). Exit 1 only on a required doctor failure or a failed init. `init`/`sync` bodies live in `first-run.ts`. The installers skip `npm run build` on a packaged install and ship in the npm tarball.

`engram memories` (`src/interfaces/cli/memories.ts`, #55) is the inspection/curation surface: `list [--type] [--scope] [--since] [--query] [--deleted] [--json]`, `show <id>` (source conversation title + archive path for the `show` tool, source exchanges, `source`/extractor tier, `extraction_basis`, scope, FSRS stats, graph evidence with `stale_since`, change log; accepts a unique 6+ char id prefix), `edit <id> --content` (re-embeds), `delete <id> [--hard]` (alias `forget`), `restore <id>`, `purge --conversation <id> [--hard]`, `log [--memory] [--op] [--limit]`. Actor is `cli`. `engram validate [--source <db>] [--fix]` no longer needs a legacy source: it fails on vector/FTS rows for forgotten or missing memories (`src/semantic/index-integrity.ts`) and `--fix` repairs them.

`engram mcp install <host> [--all] [--project] [--transport http|stdio] [--dry-run] [--force] [--inline-token] [--json]`, `engram mcp uninstall <host> [--project]` and `engram mcp status [--json]` (#50, `src/interfaces/cli/hosts.ts` + `hosts-command.ts`; subcommands of `mcp`, so bare `engram mcp` is still the server) register this install with `claude` (`~/.claude.json` / `$CLAUDE_CONFIG_DIR/.claude.json`, `--project` → `.mcp.json`), `codex` (`~/.codex/config.toml`, `[mcp_servers.engram]`), `cursor` (`~/.cursor/mcp.json`) or `hermes` (`pluginDeployTargets` + `interfaces/hermes-plugin/deploy.sh`). Decision #51: HTTP `http://127.0.0.1:<port>/mcp` when `probeMcpHealth` answers, else stdio `process.execPath <install>/dist/interfaces/cli/index.js mcp` (bridges itself later); the reason is printed. Decision #52: never a literal token — when `ENGRAM_MCP_TOKEN` is set or in `~/.config/engram/env`, Claude gets `Bearer ${ENGRAM_MCP_TOKEN}` in `headers`, Codex `bearer_token_env_var`, Cursor `Bearer ${env:ENGRAM_MCP_TOKEN}`; `--inline-token` writes the literal (warning, mode 600). JSON hosts share one writer (other keys/servers, indent and trailing-newline state preserved), Codex a line-wise TOML table writer; atomic temp+rename with `<file>.bak`; re-running is byte-identical with no `.bak` churn. Claude plugin installed (`installed_plugins.json` has `engram@<marketplace>`) → user-scope entry skipped unless `--force`; `status` reports the plugin as a registered host. `status` also says whether each entry points at this install (stdio script realpath / daemon port), whether its daemon answers and whether the token variable resolves here (with the `launchctl setenv` / `environment.d` / `setx` hint). `engram doctor` gained a `hosts` check (`[ok]` ≥1 host points here, `[--]` otherwise, never `[FAIL]`).

`engram preflight [--strict] [--json] [--expect <spec>]` runs `scripts/preflight.cjs` (also the npm `postinstall` hook) without a database or models: per native dependency (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`) it reports `prebuilt` / `compiled locally` / `will compile` / `unsupported` / `unknown` for the Node ABI + platform + arch + libc, with the fix per OS. The script's `NATIVE_DEPS` table is the single source of truth: `engram doctor` appends the same verdict to its native-module lines, and the README "Supported platform/arch set" table is generated from it (`node scripts/supported-platforms.cjs --write`, checked by `tests/deployment/supported-platforms.test.ts`). CI runs `preflight --strict --expect prebuilt` on every supported matrix entry (Node 22/24 × ubuntu, ubuntu-24.04-arm, macos, windows) and asserts the documented `unsupported` verdict on `windows-11-arm` and in a `node:22-alpine` container (#63).

`engram update` (`--check` / `--plan` / run) is the controlled self-update: backup, stop services via the per-platform supervisor adapter (`src/interfaces/cli/services.ts`), pull or `npm install -g`, `engram migrate`, restart (MCP before the plugin redeploy), verify doctor + `/health` + `stats --json` counts. `engram migrate [data-dir|model-cache|schema]` is the idempotent install/data migration (`src/interfaces/cli/data-migration.ts`); the legacy conversation-index importer is `engram import-legacy`. Post-swap steps run the *new* build in a child process. The version string comes from `package.json` via `src/_core/version/index.ts`.

Rollback (#65, decision #66; `src/interfaces/cli/rollback.ts`): before step 1 the run writes `<data dir>/updates/<stamp>.json` (prior version + sha, install kind/root, backup dir, services that were running with start commands, plugin targets, target, `schema: {version, applied}`, pre-update `CountSnapshot`, `progress` marker `planned|stopped|backup|snapshot|code|migrated|restarted|verified|done|failed:<step>`; newest 10 kept). `engram update --rollback [<stamp>] [--restore-data] [--yes]` / `--list-rollbacks`: code-only by default — stop → `git checkout <sha> && npm ci` / `npm install -g <pkg>@<prev>` → `migrate schema` with the *restored* build (child process) → restart → verify (`--version`, doctor, `/health`, counts ≥ snapshot); `engram.db` keeps everything written since the update (migrations are additive). `--restore-data` copies the backup back (refused with `--no-backup`); the auto-rollback offered when a post-swap step fails (`--yes` performs it, a TTY is asked via `UpdateDeps.confirm`, otherwise the command is printed) restores data only when verification showed counts dropped. `SCHEMA_MIGRATIONS` / `SCHEMA_VERSION` / `BREAKING_MIGRATIONS` (empty) / `schemaVersion(db)` live in `src/_core/db/schema.ts`; a code-only rollback across a breaking checkpoint is refused. `engram doctor` has an `install path` check (`src/interfaces/cli/install-path.ts`: every `engram` on PATH vs `PACKAGE_ROOT`, sees through shim scripts; `[--]` on two trees or a foreign first binary, never `[FAIL]`); `update --plan` prints it as a warning, never a blocker. `update --check` is cached 24 h at `<data dir>/cache/update-check.json` (`src/interfaces/cli/update-check.ts`); `doctor`/`health`/`stats`/`search`/`sync`/`reflect` print one stderr notice (`postAction` hook, never with `--json`) and `/health` carries `update: {current, available, checkedAt}`; `ENGRAM_NO_UPDATE_CHECK=1` disables both.

## Web Visualization

Port 3001 — Force graph (`/graph`), 3D depth view (`/graph/depth`), galaxy view (`/graph/galaxy`), word cloud (`/words`). Every page polls its `.../api/diff` route every 1.5 s; the WAL watcher only resets the word and threshold caches. Dream pipeline control with live phase tracking. `server.ts` (#122) is two maps — JSON routes `(db, url) => body` and pre-rendered pages — plus `/api/health` (supervisor probe, 503 on a DB error) and `POST /graph/api/dream/start`; each page's API lives under that page's prefix (`/graph/api/*`, `/graph/depth/api/*`, `/graph/galaxy/api/*`, `/graph/words/api/words`), the terminal pages use `/api/graph`, `/api/threshold`, `/api/communities`. Every graph route serves the same node shape (with `lastActive` / `bridgeScore`).

Terminal-optimized views at `/terminal/graph`, `/terminal/depth`, `/terminal/words`, `/terminal/communities` — SVG-based, pre-stabilized, high-contrast layouts for carbonyl or other terminal browsers.

**Theme:** Everforest Hard Dark, centralized in `src/interfaces/web/pages/theme.ts`. All page files import colors from this module — no hardcoded hex values in pages. See ADR-009 for theming architecture and carbonyl rendering lessons.

Start: `npx tsx src/interfaces/web/server.ts`

## MCP Server Transports

`dist/interfaces/mcp/server.js` speaks stdio by default. With `--http [--port N]`
(default port 9907) it serves Streamable HTTP at `/mcp` (one MCP session per
client, routed by `Mcp-Session-Id`) plus a `/health` JSON endpoint, bound to
127.0.0.1. A long-running deployment runs it this way via a launchd/systemd
service: `scripts/install-mcp-daemon.sh` renders `launchd/com.engram.mcp.plist`
(macOS) or `systemd/engram-mcp.service` (Linux), both running
`scripts/run-mcp-daemon.sh` (sources `~/.config/engram/env`, honours
`ENGRAM_MCP_PORT`). On Windows, `scripts/install-mcp-daemon.ps1`
registers the equivalent per-user Task Scheduler task (`\Engram\MCP`, at logon)
whose action is `scripts/run-mcp-daemon.ps1`.

In HTTP mode every tool call is dispatched to a `node:worker_threads` pool
(`src/interfaces/mcp/worker-pool.ts`, `dispatch.ts`, `worker.ts`) so a
multi-second recall never blocks `/health`, the handshake, or other clients.
Each worker owns its own better-sqlite3 connection (WAL + `busy_timeout`) and
embedding model. Recall sessions are pinned to the worker that created them.
Stdio mode never spawns workers. Startup logs
`Engram MCP HTTP server listening on http://127.0.0.1:9907/mcp (workers: N, ..., auth: ...)`.
`ENGRAM_MCP_TOKEN` makes `/mcp` require `Authorization: Bearer <token>` (`/health` stays open)
and is mandatory before `ENGRAM_MCP_HOST` may be anything but loopback; the visualizer uses
`ENGRAM_WEB_TOKEN` the same way (`src/interfaces/mcp/auth.ts`, `src/interfaces/web/auth-gate.ts`).

- `ENGRAM_HTTP_WORKERS` — worker count in HTTP mode (default 2; `0` = inline on the main thread)
- `ENGRAM_WORKER_TIMEOUT_MS` — per-call timeout (default 8000). `remember`,
  `remember_batch`, `index_file_structure` and `reflect --refresh` use higher
  floors. A worker still silent at 2× the timeout is killed and respawned.

**Stdio bridge (#58, decision #60).** A stdio start — `engram mcp` (the Claude Code
plugin's command, via `npx -y @devinmlowe/engram@<version> mcp`) or `server.js`
without `--http` — first probes `GET http://127.0.0.1:<port>/health` (`--port`, else
`ENGRAM_MCP_PORT`, else 9907; 1.5 s). If the engram daemon answers, the process is a thin
proxy (`src/interfaces/mcp/bridge.ts`): an MCP SDK client over Streamable HTTP to the
daemon's `/mcp` plus an MCP server on stdio forwarding `tools/list`, `tools/call`, `ping`.
It opens no database and loads no model — the CLI decides before `server.ts` is imported.
Otherwise it runs inline. `engram mcp --standalone` / `ENGRAM_MCP_STANDALONE=1` force
inline. One stderr line names the mode: `Engram MCP: bridging stdio to
http://127.0.0.1:9907/mcp (daemon healthy)` / `Engram MCP: running inline (no daemon on
:9907 (ECONNREFUSED))`. The bridge forwards `Authorization: Bearer $ENGRAM_MCP_TOKEN` from
its own env, re-opens its daemon session under the host's `clientInfo` after `initialize`
(so `forget`'s actor is the host, not `engram-bridge`), retries once after a transport
failure (daemon restarted by `engram update`) and sends `tools/list_changed`, forwards
daemon JSON-RPC errors verbatim, and exits 0 on stdin EOF / SIGTERM.

**Distribution (#58).** `.claude-plugin/plugin.json` (inline `mcpServers` → the npx command
above, version pinned), `.claude-plugin/marketplace.json` (this repo is the `engram`
marketplace: `/plugin marketplace add devinmlowe/engram` → `/plugin install engram@engram`),
`commands/` (the five portable slash commands, tools named `mcp__plugin_engram_engram__<tool>`,
decision #59) and `server.json` (registry.modelcontextprotocol.io, `io.github.devinmlowe/engram`,
npm artifact; `package.json` `mcpName` must equal it). `scripts/sync-manifests.cjs` writes the
`package.json` version into all of them (`--check` in CI and `.github/workflows/release.yml`;
the npm `version` hook runs it). A `v*` tag publishes npm (`--provenance`) then the registry
entry (`mcp-publisher login github-oidc`). The root `.mcp.json` remains for developing inside
the checkout only. `engram update` still redeploys the Hermes plugin; the Claude plugin updates
through the marketplace.

## Key Configuration

- `ENGRAM_DB_PATH` — Database path (default: `~/.local/share/engram/engram.db`)
- `ENGRAM_CHUNKING_STRATEGY` — `fixed` or `adaptive` (content-aware chunk boundaries)
- `ENGRAM_FORGET_RETENTION_DAYS` — Days a forgotten memory stays (out of recall, `engram memories restore`-able) before dream prune hard-deletes it (default 30; `0` = next run). `--hard` bypasses it (#56)
- `ENGRAM_NO_UPDATE_CHECK` — `1` disables the automatic daily version lookup and the "newer version available" notice; an explicit `engram update --check` still asks (#65)
- `ENGRAM_LOCAL_MODEL` / `ENGRAM_LOCAL_MODEL_FALLBACKS` / `ENGRAM_OPENROUTER_MODEL` — Ollama model (+ ordered fallbacks when it is not pulled) and OpenRouter model; `OLLAMA_HOST`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` enable those cascade tiers. `ENGRAM_OPENAI_BASE_URL` / `ENGRAM_OPENAI_MODEL` / `ENGRAM_OPENAI_API_KEY_ENV` (name of the env var holding the key) / `ENGRAM_OPENAI_TEMPERATURE` configure the generic OpenAI-compatible tier (OpenAI, LiteLLM, self-hosted; `src/_core/llm/providers/openai-compatible.ts`, which OpenRouter also runs on); `ENGRAM_LLM_PROVIDERS` sets the tier order (default `ollama,openai,openrouter,anthropic`); `ENGRAM_LLM_TIMEOUT_MS` (default 120000) is the per-request timeout for every tier — raise it for slow local models. All-tier failures name every tier's reason (`CascadeError`); dream checkpoints record it once per conversation per run

## Development

```bash
npm run build        # TypeScript compilation
npm run test:run     # Run tests (vitest, 137 test files)
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
