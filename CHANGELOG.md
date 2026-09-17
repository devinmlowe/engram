# Changelog

All notable changes to engram are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) while the project is pre-1.0
(minor bumps may change behaviour, as noted below).

## [Unreleased]

### Added
- Optional bearer-token authentication (#27): `ENGRAM_MCP_TOKEN` makes the HTTP MCP daemon's `/mcp` require `Authorization: Bearer <token>` (`/health` stays open for supervisors) and is required before `ENGRAM_MCP_HOST` may be non-loopback; the visualizer honours `ENGRAM_WEB_TOKEN` (falling back to `ENGRAM_MCP_TOKEN`) on every route but `/api/health`, accepting a bearer header, `?token=` once (which sets an HttpOnly cookie for the page's API calls and SSE), and refuses a non-loopback `ENGRAM_BIND` without a token. The Hermes plugin sends `token` from `engram.json`. Tokens are compared in constant time and never logged.
- `engram update`: controlled self-update modelled on `hermes update` — `--check` (current vs available for git checkouts and npm installs), `--plan`/`--dry-run` (read-only: install kind, every directory holding an `engram.db`, model cache, every service with its supervisor and restart command, Hermes plugin deploy targets, backup path, blockers), and the run: backup `engram.db` + WAL + `archive/` → stop services through their supervisor (launchd / systemd user units / Task Scheduler, `src/interfaces/cli/services.ts`) → snapshot counts → durable model cache → `git pull --ff-only` + `npm ci` or `npm install -g` → data-dir move + schema migrations with the new build → restart MCP then visualizer, redeploy the Hermes plugin → verify doctor, `/health`, and that no count dropped, printing rollback steps otherwise (#44).
- `engram migrate` now means install/data migration: `data-dir` (detects a pre-0.2.0 `~/.local/share/engram` next to an empty new default and moves the data; refuses when two dirs both hold a database), `model-cache` (durable `ENGRAM_MODEL_CACHE_DIR`, copies downloaded models out of `node_modules`), `schema` (opens the db once and lists `schema_migrations`); every topic supports `--dry-run`. The legacy conversation-index importer is `engram import-legacy --source <path>`; `engram migrate --source` forwards with a deprecation notice for one release (#44).
- `engram stats --json` prints the row counts `engram update` compares before/after.
- README: one-command update per platform, and a Windows "safe update and data-directory migration" section (preflight, install vs restart, stale process on the port, verification incl. the MCP handshake). `install-mcp-daemon.ps1 status` reports `dataDir`, `dbPath`, `legacyDbPath` (#13).
- macOS/Linux supervision for the MCP HTTP daemon: `scripts/install-mcp-daemon.sh` (`install|uninstall|start|stop|restart|status`, every verb waits on `/health`) renders `launchd/com.engram.mcp.plist` or `systemd/engram-mcp.service`, both running the new `scripts/run-mcp-daemon.sh` launcher, which sources `~/.config/engram/env`. The resolved data directory is rendered into the service so daemon and CLI share one database; `status` warns about a second legacy database. `install` retires a hand-written `ai.hermes.engram-mcp` agent on the same port. The server honours `ENGRAM_MCP_PORT` when `--port` is absent, and `engram doctor` gains an `mcp daemon` check that probes `/health` (#28).

### Changed
- Writer coordination (#26): recall reinforcement retries `SQLITE_BUSY` three times with jittered backoff and then skips the round instead of logging an error (the recall itself never fails); `recordCheckpoint` opens its read-then-write as `BEGIN IMMEDIATE`; the consolidate phase yields between conversations; `runDream` takes an advisory `<data dir>/tmp/dream.lock` so a concurrent `engram dream` fails fast (`DreamLockedError`) instead of contending for hours. The concurrency model is documented in `src/_core/db/SPEC.md` and exercised by `tests/core/writer-contention.test.ts`.
- The CLI `--version`, MCP `serverInfo` and `engram update` all read the version from `package.json` (`src/_core/version/index.ts`) instead of three hardcoded literals.
- The Windows installers/runners and the bash installers default the data directory the way the CLI does (`%LOCALAPPDATA%\engram` / `$XDG_DATA_HOME/engram`, legacy `~/.local/share/engram` fallback) instead of always the legacy path (#13, #44).
- Hermes plugin log messages point at `scripts/install-mcp-daemon.sh status` instead of the hand-written `ai.hermes.engram-mcp` LaunchAgent.

### Fixed
- `remember_batch` items are closed (`additionalProperties: false`, zod `.strict()`) like `remember`; an unknown key on an item is rejected instead of ignored (#43).
- `memories_fts` ranks the `context` column at 0.25 of `content` (`bm25(memories_fts, 1.0, 0.25)`), so the constant Hermes mirror context note can no longer outrank a real content match (#42).
- `reflect` is routed through `interfaces/shared/reflect.ts` on both the CLI and MCP surfaces; the interface-parity test asserts it (#38).
- `scripts/install-daemon.sh` no longer requires `launchctl` on Linux, so its systemd branch is reachable (#28).
- Hermes plugin circuit breaker is truly half-open: after the cooldown exactly one probe call is allowed, and a failing probe re-opens the breaker with the failure count intact, so parked turns are no longer posted one by one and dropped while the daemon is still down. A queued turn that fails on transport is now kept and retried; only a turn the live server rejects (`isError` / JSON-RPC error, new `EngramMcpRejected`) is dropped (#41).

## [0.3.0] - 2026-09-17

### Added

- MCP `ingest_turn` accepts an optional `author {id, name, is_bot}` object, stored as JSON in the new nullable `exchanges.author_json` column; the Hermes plugin forwards `turn_author` and parks queued turns while its circuit breaker is open instead of dropping them (#18).
- MCP `remember` / `remember_batch` accept `source: "hermes-mirror"` and an optional `context` provenance note (stored in `memories.context`); the Hermes plugin's built-in memory mirror tags its writes with both instead of `source: "import"`. Older servers reject `hermes-mirror`, so deploy the server before the plugin (#19).

### Changed

- Package renamed to `@devinmlowe/engram` (scoped, public) — the first npm release; install with `npm install -g @devinmlowe/engram`. The CLI binary is still `engram` (#39).

### Fixed

- Hermes plugin expands a literal `~` in `HERMES_HOME` / `HERMES_AGENT_DIR` instead of resolving it against the cwd, which created a stray `<repo>/~/.hermes` home under fish (#33).
- Dream checkpoint errors are classified from `CascadeError` tier errors; the message regex is only a fallback (#34).
- A success checkpoint supersedes the same item's error row in the same dream run (#35).
- `consolidateFacts` continues past a failing fact and reports the failures; the batch checkpoint records the partial failure (#36).
- The CLI reports uncaught command errors as one line with exit 1 instead of a stack trace (#37).

### Security

- npm `overrides` pin the transitive `protobufjs` to `^7.6.3` (code-injection advisories in ≤7.6.2, reached via `@xenova/transformers` → `onnxruntime-web` → `onnx-proto`) and `sharp` to `^0.35.4` (libvips CVEs; engram never uses the image pipeline). `npm audit` reports 0 vulnerabilities; embeddings, the reranker and `engram doctor` were verified live against onnxruntime after the change (#40).

## [0.2.0] - 2026-09-17

### Upgrade notes

- **First dream run after upgrading re-extracts every conversation once.** The extract fingerprint now hashes exchange content instead of message lengths (#23), so every previously fingerprinted conversation looks changed. A full pass over a large archive takes hours; bound it with `ENGRAM_DREAM_MAX_CONVERSATIONS=<n>` for the first run(s). Duplicate memories are not created (the consolidator dedups), and later runs skip unchanged conversations as before.
- **Hermes plugin must be redeployed and Hermes restarted** — `interfaces/hermes-plugin/deploy.sh` (add `ENGRAM_PLUGIN_PROFILES="a b"` for profile copies), then restart the gateways; running sessions keep the old module until then (#17, #20).
- Restart the MCP HTTP daemon, dream daemon and visualizer after `npm run build` so they load the new `dist/` (see README "Updating an existing installation").
- Schema migrations are additive and run on the first database open; no manual step.

### Added

- MCP `ingest_turn`: record one user/assistant turn of an external agent session; idempotent upsert on `session_id` + `turn_index`; the conversation's `scope` is inherited by every memory the dream pipeline extracts from it (W2).
- Per-request tenant scoping: `scope` / `read_scopes` on `recall` and `recall_session`, `scope` on `remember` / `remember_batch`, overriding `ENGRAM_SCOPE` / `ENGRAM_READ_SCOPES` for that call (W1).
- CLI `engram export` / `engram import`: JSONL v1 transfer of memories, entities, relationships and commitments; import is idempotent by id (newer wins), regenerates embeddings, FTS and vectors (W11).
- Recall reinforces the memories it returns (FSRS access bookkeeping and stability growth); `reinforce: false` on the recall tools and `engram search --no-reinforce` opt out (W8, #22).
- `ENGRAM_LOCAL_MODEL_FALLBACKS`: comma-separated Ollama models tried in order when `ENGRAM_LOCAL_MODEL` is not pulled; `engram doctor` gains an `ollama` line showing the resolved local model and whether the tier is active (#16).
- `CascadeError` from the LLM factory: when every tier fails, the error names each tier and its reason (config skip vs runtime failure); config skips are warned once per process, runtime failures every call (#15).
- `DreamReport.collapsedCandidates` and a `Collapsed dupes` line in the `engram dream` summary; `DreamReport.skippedUnchanged` / `Skipped unchanged` for fingerprint-skipped conversations (W12, #23).
- Dream noise reduction: intra-batch and run-level near-duplicate collapse before insertion, a transient-status memory tier (importance ≤ 0.3, stability 7 days) and model-supplied `confidence` in extraction (W9).
- `engram dream --force`: re-extract conversations even when their fingerprint is unchanged (W12).
- Hermes plugin (http transport): per-turn ingestion via `ingest_turn` (`sync_turns`, default true), built-in MEMORY.md/USER.md mirror (`mirror_memory_writes`, default true), `prefetch_contexts` (default `["primary"]`), primary-only write gating, a warm-up recall on `initialize()`, and visible timeout misses (rate-limited warning + ⚠️ recall indicator) (W3–W5, #17).
- Contract tests: no direct Anthropic clients outside `_core/llm/providers`, SPEC/README path references resolve, MCP tool annotations pinned, CLI/MCP capability parity (W10, #22, #29).

### Changed

- Hermes plugin `timeout_secs` default 2.0 → 4.0 (cold recall on a ~17K-memory store measured ≈ 2 s); `is_available()` is config/deps only and the `/health` probe moved to `initialize()` → `unavailable_reason()` (W5, #17).
- All LLM calls (semantic and graph extractors, consolidator, commitments pass) go through the `_core/llm` factory cascade Ollama → OpenRouter → Anthropic; the consolidator therefore surfaces "no tool_use in either Anthropic model" as a transient per-batch error instead of a silent noop (W6, W7, #30).
- Extract fingerprint hashes each exchange's text (length-prefixed) with its id, index and timestamp, so same-length in-place edits are re-extracted (#23).
- `recall`, `recall_session`, `recall_drill` keep `readOnlyHint: true`; their descriptions state the access bookkeeping and the `reinforce: false` opt-out (#22).
- Ollama tier config skips report "Ollama not reachable" vs "model X not found; available: […]" distinctly (#16).
- `package.json`: version 0.2.0; `prepublishOnly` builds and runs the test suite (#31).

### Fixed

- Cascade failures no longer report only the Anthropic tier's "API key required" — the real failing tier (e.g. OpenRouter 401, Ollama timeout) is in the error and in dream extract checkpoints' `error_message` (#15).
- Extract phase recorded two error checkpoint rows per conversation per run (initial + retry); `recordFailure` now updates the existing row and increments `attempt_count` (#24).
- Consolidate phase records a failure checkpoint per batch and continues with the next batch; a tool_use-less response is classified transient (#30).
- Dream checkpoint `error_class` is `provider` rather than `unknown` for rejected API keys, so they are not pointlessly retried (#15).
- Consolidator refuses supersession ping-pong (a candidate restating a memory that the existing one already superseded) (W12).
- Stdio Hermes provider: fallback loader registers the Hermes contract module in `sys.modules` before exec (W0).
- CLI `engram explore <unknown>` prints `Entity not found: …` and exits 1 instead of a stack trace (#29).
- Extraction few-shot examples carry `confidence` so small local models emit it instead of defaulting to 0.5 (#23).

### Docs

- Hermes plugin README: write-loop config keys, contexts and write gating, scoping, turn idempotency, the `initialize` contract, troubleshooting (#20).
- `ingest_turn`, per-request scope, `reinforce`, `dream --force`, export/import, transient tier and `ENGRAM_LOCAL_MODEL_FALLBACKS` documented in README, docs/api-reference.md, docs/user-guide.md, docs/integrate-your-agent.md; stale counts and claims aligned (#21).
- Graph SPEC POST-2 aligned with the implementation (`exploreEntity` throws); uncovered SPEC rows covered or annotated; `SPEC-legacy.md` archived under `docs/history/` (#29).
- `interfaces/SPEC.md` INV-3 records the `readOnlyHint` policy (#22); ADR-010 renamed to `decisions/010-memory-provider-integration.md` to match the other ADRs (#31).

## [0.1.0]

- Initial release: phases 1–7 — episodic archive and search, semantic extraction and consolidation, knowledge graph and reflection, dream-state pipeline, RLM recall sessions, file-analysis tools, commitments ledger, MCP stdio/HTTP server, CLI and web visualizer.

[Unreleased]: https://github.com/devinmlowe/engram/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/devinmlowe/engram/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/devinmlowe/engram/releases/tag/v0.2.0
