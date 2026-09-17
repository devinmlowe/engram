# Changelog

All notable changes to engram are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) while the project is pre-1.0
(minor bumps may change behaviour, as noted below).

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
