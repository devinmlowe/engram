# CLI

Command-line interface for direct human interaction with engram. Built on Commander.js with 27 commands covering search, memory management and curation, graph exploration, dream pipeline, commitments, portable export/import, self-update, first-run setup, and system administration.

## In Scope

- Command definitions, argument parsing, and output formatting
- Human-readable output (tables, colored text, progress indicators)
- Orchestration of shared operations for CLI context

## Out of Scope

- Core operation logic (delegated to [interfaces/shared/](../shared/) and domain modules)
- MCP protocol handling (see [interfaces/mcp/](../mcp/))

## Contains

- `index.ts` — All 26 CLI commands: `init`, `sync`, `search`, `remember`, `memories`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `doctor`, `setup`, `preflight`, `update`, `migrate`, `validate`, `backfill-event-ts`, `commitments`, `commitment-done`, `commitments-extract`, `export`, `import`, `mcp` (with the `install` / `uninstall` / `status` subcommands from `hosts-command.ts`)
- `first-run.ts` — The bodies of `init` (`runInit`) and `sync` (`runSync`), so `setup` runs the same steps (#61)
- `setup.ts` — `engram setup` (#61, decision #62): doctor → init → sync → mcp install → all three daemons → doctor --fix → extraction smoke → summary; orchestration only, every collaborator injected through `SetupDeps`
- `smoke.ts` — The `extraction smoke` doctor check (#61): latest conversation or bundled fixture, capped input, 60 s budget, `tier=… memories=N` or per-tier cascade reasons; real-conversation facts stored with `source='smoke'`
- `memories.ts` — `engram memories list|show|edit|delete|restore|purge|log` (#55): the inspection and curation surface over `semantic/inspect.ts` and `semantic/forget.ts`; pure formatters exported for tests
- `update.ts` — `engram update`: plan (install kind, data-dir candidates, model cache, services, plugin targets, warnings, blockers) and run (persist the rollback plan → stop → backup → snapshot → code → migrate → restart → verify; a failed post-swap step offers the rollback). Post-swap steps run the new build in a child process (#44, #65)
- `rollback.ts` — `engram update --rollback` (#65, decision #66): the persisted plan `<data dir>/updates/<stamp>.json` (prior version/sha, install, backup dir, services + start commands, plugin targets, target, schema version, snapshot, `progress` marker; newest 10 kept), `restoreDataDir` (the backup allowlist in reverse + WAL checkpoint), `schemaRollbackCheck` against `BREAKING_MIGRATIONS`, `rollbackUpdate` (code-only by default, `--restore-data` opt-in; migrate + verify run the *restored* build in a child process), and the stop / start / verify steps shared with `runUpdate`
- `install-path.ts` — doctor's `install path` check (#65): every `engram` on PATH (symlinks and shim scripts resolved) vs the install root `engram update` upgrades; pure and injectable
- `update-check.ts` — the daily cached version check (#65): `<data dir>/cache/update-check.json`, `refreshUpdateCheck` (one lookup per day, bounded by a timeout, failures cached), `updateNotice` (pure), `updateHealthField` for `/health`; `ENGRAM_NO_UPDATE_CHECK=1` disables
- `install-kind.ts` — git checkout vs global npm install detection, latest available version (git tags / npm dist-tag), `--check` output
- `services.ts` — Supervisor adapters (launchd, systemd user units, Windows Task Scheduler) behind one `ServiceStatus` shape with injectable `exec`/`probe`; never kills an unsupervised process
- `data-migration.ts` — `engram migrate`: data-dir split detection and move (refuses when two dirs hold a database), model cache (moves a pre-0.4.0 `node_modules` cache into the resolved dir; relocates an explicit dir that sits inside `node_modules`; no-op once the durable default applies, #53), schema checkpoint report
- `snapshot.ts` — Row counts for `engram stats --json` and the before/after comparison in `engram update`
- `doctor.ts` — Runtime diagnostics behind `engram doctor` (node, platform/arch incl. libc + Node ABI, native modules with their prebuild verdict `prebuilt — …` / `compiled locally — …`, model cache with `durable: yes|no` + the tier that chose it, ollama, llm providers, effective data dir + legacy-split warning, service env file, install path, MCP daemon /health, registered hosts, extraction smoke). #61: `DoctorCheck.fix`, `applyDoctorFixes` / `formatFixResults` (`--fix [--yes]`), `DoctorContext` (every probe/shell/host/service collaborator injectable), `--strict`, `--no-smoke`
- `hosts.ts` — `engram mcp install|uninstall|status` (#50): per-host config paths, transport decision (`decideTransport`, #51), entry builder + token reference (#52), the JSON and TOML writers, dependency-free unified diff, atomic write with `.bak`, Claude plugin detection, Hermes deploy via `pluginDeployTargets`, the status report and the doctor `hosts` summary. Pure apart from the injected `probe` / `exec`
- `hosts-command.ts` — Commander wiring for the three `mcp` subcommands (flag parsing and printing only)
- `preflight.ts` — Typed `createRequire` bridge to `scripts/preflight.cjs` (resolved through `PACKAGE_ROOT`, so it works from a checkout, a global install and `npx`): `loadPreflight()`, the re-exported `PREBUILT_TARGETS` / `MIN_NODE_MAJOR`, and `describePrebuild()` for doctor lines. `engram preflight [--strict] [--json] [--expect <spec>]` prints the per-dependency prebuild verdict without opening the database or loading models (#63)
- `transfer.ts` — `engram export` / `engram import`: JSONL v1 transfer of memories, entities, relationships, and commitments

## Export / Import

| Command | Purpose |
|---------|---------|
| `engram export [--out <file>] [--scope <scope>...] [--include-inactive] [--kinds memories,entities,relationships,commitments]` | Write JSONL to stdout (or `--out`). Header line first (`kind: header`, `v: 1`, per-kind counts, applied `schema_migrations`), then one `{kind, v, data}` line per record with JSON columns decoded. Default: all scopes, active memories only, all kinds. `--scope` filters memories only (entities/relationships/commitments are unscoped). Embeddings are **not** exported. |
| `engram import <file> [--scope <override>] [--dry-run]` | Read that JSONL. Idempotent by id: an existing id is updated in place only when the incoming record is newer (`updated_at` for memories/relationships, `last_seen` for entities, `resolved_at` for commitments, each falling back to `created_at`), otherwise skipped. Inserts go through the existing helpers so `memories_fts`/`entities_fts` and the vec0 tables are regenerated from content. Relationships whose endpoints are missing are skipped and counted. `--scope` overrides the scope on every imported memory. The whole file is validated before the first write; a malformed line exits non-zero with nothing changed. |

Tests: `tests/interfaces/cli/transfer.test.ts`.

## Memories (#55)

| Command | Behaviour |
|---------|-----------|
| `engram memories list [--type t] [--scope a,b] [--since date] [--query text] [--deleted] [--inactive] [--limit n] [--json]` | Newest first. Forgotten rows appear only with `--deleted` (marked `[forgotten <day> by <actor>]`). |
| `engram memories show <id>` | Full provenance: content, type, scope, `source` (extractor tier), `extraction_basis`, status (active / forgotten by whom / superseded), FSRS stats (stored + composite confidence, importance, stability, retrievability, access count, embedding presence), source conversation(s) with title (summary), project, archive path (the `show` MCP tool's `path`) and the source exchanges, graph entities it evidences (with `stale_since`), and its change log. `<id>` may be a unique prefix of 6+ characters. |
| `engram memories edit <id> --content <text>` | Replaces the text, re-embeds and re-indexes, logs `edit` with before/after. Refuses forgotten memories. |
| `engram memories delete <id> [--hard]` (alias `forget`) | Soft delete kept for `ENGRAM_FORGET_RETENTION_DAYS` (out of every recall path now; vector/FTS rows removed; graph counts decremented, #57). `--hard` deletes the row outright. |
| `engram memories restore <id>` | Undo a forget inside the retention window (re-indexed; extraction suppression lifted). |
| `engram memories purge --conversation <id> [--hard]` | Forget every memory derived from that conversation's exchanges (privacy purge). |
| `engram memories log [--memory id] [--op forget\|edit\|purge\|restore] [--limit n] [--json]` | The change log, newest first, with actor (`cli` or the MCP client name). |

`engram validate [--fix]` (`validate.ts`): embedding dimensions/norms, FTS5 integrity and hit rate, and the memory-index check, which fails on vector/FTS rows for forgotten or missing memories; `--fix` repairs them (vectors by id; FTS by rebuild + re-unindexing every forgotten row). Tests: `tests/interfaces/cli/validate.test.ts`, `tests/interfaces/cli/memories.test.ts`, `tests/semantic/forget.test.ts`.

## MCP host registration (#50)

| Command | Behaviour |
|---------|-----------|
| `engram mcp install <host> [--all] [--project] [--transport http\|stdio] [--dry-run] [--force] [--inline-token] [--json]` | `claude` → `~/.claude.json` (`CLAUDE_CONFIG_DIR` honoured; `--project` → `.mcp.json`), `codex` → `~/.codex/config.toml` `[mcp_servers.engram]` (`--project` → `.codex/config.toml`), `cursor` → `~/.cursor/mcp.json` (`--project` → `.cursor/mcp.json`), `hermes` → `interfaces/hermes-plugin/deploy.sh` to `$HERMES_HOME/plugins/engram` + profiles that already have it (manual step on Windows / npm installs). `--all` = every host whose config dir exists. HTTP `http://127.0.0.1:<port>/mcp` when `/health` answers, else stdio `node <install>/dist/interfaces/cli/index.js mcp` (`--port` added when non-default); the reason is printed. Token: env reference per host when `ENGRAM_MCP_TOKEN` is set here or in the service env file, literal only with `--inline-token` (mode 600). Atomic write, `<file>.bak`, other servers/keys and formatting preserved, idempotent. Claude user scope is skipped while the plugin is installed unless `--force`. `--dry-run` prints path + unified diff. Never restarts a host. |
| `engram mcp uninstall <host> [--project] [--dry-run]` | Removes only the `engram` entry (TOML: the table and its sub-tables), keeps `<file>.bak`; `hermes` removes the deployed copies that hold our `plugin.yaml`. |
| `engram mcp status [--json]` | Per host: present / registered / transport / target, points at this install (stdio script realpath under the package root, or daemon port = `ENGRAM_MCP_PORT`), daemon `/health` for the port the entry uses, `ENGRAM_MCP_TOKEN` referenced → resolves in this environment (platform hint when not), Claude plugin as a registered host, Hermes copies vs the checkout + `engram.json` token. |

Tests: `tests/interfaces/cli/hosts.test.ts`.

## Preflight / doctor

| Command | Purpose |
|---------|---------|
| `engram preflight [--strict] [--json] [--expect <spec>]` | One line per native dependency (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`): `[ok] prebuilt`, `[warn] compiled locally` / `will compile (needs python3 + C++ toolchain)`, `[FAIL] unsupported`, `[--] unknown (<reason>)`, each warn/fail followed by the fix for this OS. Answers from the static target table (every native module is N-API, so the Node major never matters), confirming the shipped binary is on disk when `node_modules` is present. `--strict` exits 1 on any `[FAIL]`; `--expect prebuilt` or `--expect better-sqlite3=prebuilt,sqlite-vec=unsupported` exits 1 unless the verdicts match (CI). Same script as the npm `postinstall` hook; `ENGRAM_SKIP_PREFLIGHT` only silences the hook. |
| `engram doctor [--json] [--fix [--yes]] [--strict] [--no-smoke]` | Full post-build diagnostics (14 checks); the `better-sqlite3` / `sqlite-vec` lines end with the same prebuild verdict; `install path` lists every `engram` on PATH and is `[--]` when there is more than one distinct binary or the first is not this install (fix: `npm uninstall -g` in the other tree, or reorder PATH; never `[FAIL]`); `env file` is `[--]` with a create/chmod fix when `~/.config/engram/env` is missing or wider than 600; `hosts` is `[ok]` when a registered host points at this install, `[--]` with the `engram mcp install` hint otherwise (never `[FAIL]`); `extraction smoke` runs one real extraction (`tier=… memories=N`, or every tier's reason; real-conversation facts stored with `source=smoke`). `--fix` applies each non-ok check's remediation (env file, durable model cache, confirm-gated `ollama pull`, start a stopped daemon, register a host), re-runs it, prints `[fixed|applied|skipped|failed]` + the manual command, and is idempotent (`nothing to fix`). `--strict` exits 1 on any non-`[ok]` line. |
| `engram setup [--yes] [--sync\|--no-sync] [--no-daemons\|--daemons=<ids>] [--host <id...>] [--no-smoke] [--json]` | First run in one command (#61, decision #62): doctor → init → sync (asked) → `mcp install` for every present host (Hermes deploy offered) → the MCP daemon, dream timer and visualizer through the shipped installers (all three by default; already-running left alone; visualizer port/bind line; Linux linger confirm-gated, never implied by `--yes`) → `doctor --fix` → extraction smoke → summary table + next steps. Ends with `[warn] dream timer installed but no LLM tier is reachable …` (exit 0) when the smoke found no tier; exit 1 only on a required doctor failure or a failed init. |

Tests: `tests/deployment/preflight.test.ts`, `tests/deployment/prebuild-probe.test.ts`, `tests/deployment/supported-platforms.test.ts`, `tests/interfaces/cli/doctor.test.ts`, `tests/interfaces/cli/doctor-fix.test.ts`, `tests/interfaces/cli/smoke.test.ts`, `tests/interfaces/cli/setup.test.ts`.

## Update / migrate

| Command | Purpose |
|---------|---------|
| `engram update --check` | Current vs available version (git: highest `vX.Y.Z` tag on origin; npm: `dist-tags.latest`), cached 24 h in `<data dir>/cache/update-check.json`. |
| `engram update --plan` (`--dry-run`) | Read-only plan: install kind, every directory holding an `engram.db` (effective, pre-0.2.0 legacy, platform default), model-cache location, every service with its supervisor and restart command, Hermes plugin deploy targets, backup path, rollback-plan location, warnings (install path), blockers. |
| `engram update [--yes] [--no-backup] [--to <version>]` | Runs the plan. Refuses on blockers: dirty checkout, two populated data dirs, a daemon answering on its port with no supervisor. Writes `<data dir>/updates/<stamp>.json` before step 1 and advances its `progress` at every step; a failed post-swap step offers the rollback (`--yes` performs it; a TTY is asked; otherwise the command is printed), restoring the backup only when verification showed counts dropped. |
| `engram update --rollback [<stamp>] [--restore-data] [--yes]` | Code-only rollback of the newest (or named) plan: stop → `git checkout <sha> && npm ci` / `npm install -g <pkg>@<prev>` → `migrate schema` with the restored build → restart → verify. `--restore-data` also copies the backup back (refused without one). Refused across a `BREAKING_MIGRATIONS` checkpoint. Records `rolledBack` in the plan. |
| `engram update --list-rollbacks` | The recorded plans, newest first. |
| `engram migrate [all\|data-dir\|model-cache\|schema] [--dry-run]` | Idempotent install/data migration; refuses to move the data dir while the MCP daemon answers on its port. |

Tests: `tests/interfaces/cli/update.test.ts`, `tests/interfaces/cli/install-path.test.ts`, `tests/interfaces/cli/update-check.test.ts`.

## See Also

- [interfaces/shared/](../shared/) — Shared operation logic used by CLI and MCP
- [interfaces/](../) — Parent interfaces module
- [docs/user-guide.md](../../../docs/user-guide.md) — User-facing CLI documentation
