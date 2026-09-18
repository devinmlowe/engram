# CLI

Command-line interface for direct human interaction with engram. Built on Commander.js with 24 commands covering search, memory management, graph exploration, dream pipeline, commitments, portable export/import, self-update, and system administration.

## In Scope

- Command definitions, argument parsing, and output formatting
- Human-readable output (tables, colored text, progress indicators)
- Orchestration of shared operations for CLI context

## Out of Scope

- Core operation logic (delegated to [interfaces/shared/](../shared/) and domain modules)
- MCP protocol handling (see [interfaces/mcp/](../mcp/))

## Contains

- `index.ts` — All 24 CLI commands: `init`, `sync`, `search`, `remember`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `doctor`, `update`, `migrate`, `import-legacy`, `validate`, `backfill-event-ts`, `commitments`, `commitment-done`, `commitments-extract`, `export`, `import`, `mcp`
- `update.ts` — `engram update`: plan (install kind, data-dir candidates, model cache, services, plugin targets, blockers) and run (backup → stop → snapshot → code → migrate → restart → verify, rollback steps on failure). Post-swap steps run the new build in a child process (#44)
- `install-kind.ts` — git checkout vs global npm install detection, latest available version (git tags / npm dist-tag), `--check` output
- `services.ts` — Supervisor adapters (launchd, systemd user units, Windows Task Scheduler) behind one `ServiceStatus` shape with injectable `exec`/`probe`; never kills an unsupervised process
- `data-migration.ts` — `engram migrate`: data-dir split detection and move (refuses when two dirs hold a database), model cache (moves a pre-0.4.0 `node_modules` cache into the resolved dir; relocates an explicit dir that sits inside `node_modules`; no-op once the durable default applies, #53), schema checkpoint report
- `snapshot.ts` — Row counts for `engram stats --json` and the before/after comparison in `engram update`
- `doctor.ts` — Runtime diagnostics behind `engram doctor` (node, platform/arch, native modules, model cache with `durable: yes|no` + the tier that chose it, effective data dir + legacy-split warning, MCP daemon /health)
- `transfer.ts` — `engram export` / `engram import`: JSONL v1 transfer of memories, entities, relationships, and commitments

## Export / Import

| Command | Purpose |
|---------|---------|
| `engram export [--out <file>] [--scope <scope>...] [--include-inactive] [--kinds memories,entities,relationships,commitments]` | Write JSONL to stdout (or `--out`). Header line first (`kind: header`, `v: 1`, per-kind counts, applied `schema_migrations`), then one `{kind, v, data}` line per record with JSON columns decoded. Default: all scopes, active memories only, all kinds. `--scope` filters memories only (entities/relationships/commitments are unscoped). Embeddings are **not** exported. |
| `engram import <file> [--scope <override>] [--dry-run]` | Read that JSONL. Idempotent by id: an existing id is updated in place only when the incoming record is newer (`updated_at` for memories/relationships, `last_seen` for entities, `resolved_at` for commitments, each falling back to `created_at`), otherwise skipped. Inserts go through the existing helpers so `memories_fts`/`entities_fts` and the vec0 tables are regenerated from content. Relationships whose endpoints are missing are skipped and counted. `--scope` overrides the scope on every imported memory. The whole file is validated before the first write; a malformed line exits non-zero with nothing changed. |

Tests: `tests/interfaces/cli/transfer.test.ts`.

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
