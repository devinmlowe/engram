# CLI

Command-line interface for direct human interaction with engram. Built on Commander.js with 26 commands covering search, memory management and curation, graph exploration, dream pipeline, commitments, portable export/import, self-update, and system administration.

## In Scope

- Command definitions, argument parsing, and output formatting
- Human-readable output (tables, colored text, progress indicators)
- Orchestration of shared operations for CLI context

## Out of Scope

- Core operation logic (delegated to [interfaces/shared/](../shared/) and domain modules)
- MCP protocol handling (see [interfaces/mcp/](../mcp/))

## Contains

- `index.ts` — All 26 CLI commands: `init`, `sync`, `search`, `remember`, `memories`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `doctor`, `preflight`, `update`, `migrate`, `import-legacy`, `validate`, `backfill-event-ts`, `commitments`, `commitment-done`, `commitments-extract`, `export`, `import`, `mcp` (with the `install` / `uninstall` / `status` subcommands from `hosts-command.ts`)
- `memories.ts` — `engram memories list|show|edit|delete|restore|purge|log` (#55): the inspection and curation surface over `semantic/inspect.ts` and `semantic/forget.ts`; pure formatters exported for tests
- `update.ts` — `engram update`: plan (install kind, data-dir candidates, model cache, services, plugin targets, blockers) and run (backup → stop → snapshot → code → migrate → restart → verify, rollback steps on failure). Post-swap steps run the new build in a child process (#44)
- `install-kind.ts` — git checkout vs global npm install detection, latest available version (git tags / npm dist-tag), `--check` output
- `services.ts` — Supervisor adapters (launchd, systemd user units, Windows Task Scheduler) behind one `ServiceStatus` shape with injectable `exec`/`probe`; never kills an unsupervised process
- `data-migration.ts` — `engram migrate`: data-dir split detection and move (refuses when two dirs hold a database), model cache (moves a pre-0.4.0 `node_modules` cache into the resolved dir; relocates an explicit dir that sits inside `node_modules`; no-op once the durable default applies, #53), schema checkpoint report
- `snapshot.ts` — Row counts for `engram stats --json` and the before/after comparison in `engram update`
- `doctor.ts` — Runtime diagnostics behind `engram doctor` (node, platform/arch incl. libc + Node ABI, native modules with their prebuild verdict `prebuilt — …` / `compiled locally — …`, model cache with `durable: yes|no` + the tier that chose it, effective data dir + legacy-split warning, MCP daemon /health, registered hosts)
- `hosts.ts` — `engram mcp install|uninstall|status` (#50): per-host config paths, transport decision (`decideTransport`, #51), entry builder + token reference (#52), the JSON and TOML writers, dependency-free unified diff, atomic write with `.bak`, Claude plugin detection, Hermes deploy via `pluginDeployTargets`, the status report and the doctor `hosts` summary. Pure apart from the injected `probe` / `exec`
- `hosts-command.ts` — Commander wiring for the three `mcp` subcommands (flag parsing and printing only)
- `preflight.ts` — Typed `createRequire` bridge to `scripts/preflight.cjs` (resolved through `PACKAGE_ROOT`, so it works from a checkout, a global install and `npx`): `loadPreflight()`, the re-exported `PREBUILT_TARGETS` / `PREBUILT_NODE_MAJORS` / `MIN_NODE_MAJOR`, and `describePrebuild()` for doctor lines. `engram preflight [--strict] [--json] [--expect <spec>]` prints the per-dependency prebuild verdict without opening the database or loading models (#63)
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

`engram validate [--source <db>] [--fix]`: `--source` is optional; the memory-index check fails on vector/FTS rows for forgotten or missing memories and `--fix` repairs them (vectors by id; FTS by rebuild + re-unindexing every forgotten row). Tests: `tests/interfaces/cli/memories.test.ts`, `tests/semantic/forget.test.ts`.

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
| `engram preflight [--strict] [--json] [--expect <spec>]` | One line per native dependency (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`): `[ok] prebuilt`, `[warn] compiled locally` / `will compile (needs python3 + C++ toolchain)`, `[FAIL] unsupported`, `[--] unknown (<reason>)`, each warn/fail followed by the fix for this OS and `nvm use <major>` when the gap is a Node major. Inspects `node_modules` when present, else the static table. `--strict` exits 1 on any `[FAIL]`; `--expect prebuilt` or `--expect better-sqlite3=prebuilt,sqlite-vec=unsupported` exits 1 unless the verdicts match (CI). Same script as the npm `postinstall` hook; `ENGRAM_SKIP_PREFLIGHT` only silences the hook. |
| `engram doctor [--json]` | Full post-build diagnostics; the `better-sqlite3` / `sqlite-vec` lines end with the same prebuild verdict; `hosts` is `[ok]` when a registered host points at this install, `[--]` with the `engram mcp install` hint otherwise (never `[FAIL]`). |

Tests: `tests/deployment/preflight.test.ts`, `tests/deployment/prebuild-probe.test.ts`, `tests/deployment/supported-platforms.test.ts`, `tests/interfaces/cli/doctor.test.ts`.

## Update / migrate

| Command | Purpose |
|---------|---------|
| `engram update --check` | Current vs available version (git: highest `vX.Y.Z` tag on origin; npm: `dist-tags.latest`). |
| `engram update --plan` (`--dry-run`) | Read-only plan: install kind, every directory holding an `engram.db` (effective, pre-0.2.0 legacy, platform default), model-cache location, every service with its supervisor and restart command, Hermes plugin deploy targets, backup path, blockers. |
| `engram update [--yes] [--no-backup] [--to <version>]` | Runs the plan. Refuses on blockers: dirty checkout, two populated data dirs, a daemon answering on its port with no supervisor. |
| `engram migrate [all\|data-dir\|model-cache\|schema] [--dry-run]` | Idempotent install/data migration; refuses to move the data dir while the MCP daemon answers on its port. `--source` forwards to `import-legacy` with a deprecation notice. |
| `engram import-legacy --source <path>` | The legacy conversation-index importer (unchanged behaviour, new name). |

Tests: `tests/interfaces/cli/update.test.ts`.

## See Also

- [interfaces/shared/](../shared/) — Shared operation logic used by CLI and MCP
- [interfaces/](../) — Parent interfaces module
- [docs/user-guide.md](../../../docs/user-guide.md) — User-facing CLI documentation
