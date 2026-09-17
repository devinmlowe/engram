# CLI

Command-line interface for direct human interaction with engram. Built on Commander.js with 22 commands covering search, memory management, graph exploration, dream pipeline, commitments, portable export/import, and system administration.

## In Scope

- Command definitions, argument parsing, and output formatting
- Human-readable output (tables, colored text, progress indicators)
- Orchestration of shared operations for CLI context

## Out of Scope

- Core operation logic (delegated to [interfaces/shared/](../shared/) and domain modules)
- MCP protocol handling (see [interfaces/mcp/](../mcp/))

## Contains

- `index.ts` — All 22 CLI commands: `init`, `sync`, `search`, `remember`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `doctor`, `migrate`, `validate`, `backfill-event-ts`, `commitments`, `commitment-done`, `commitments-extract`, `export`, `import`, `mcp`
- `doctor.ts` — Runtime diagnostics behind `engram doctor` (node, platform/arch, native modules, model cache)
- `transfer.ts` — `engram export` / `engram import`: JSONL v1 transfer of memories, entities, relationships, and commitments

## Export / Import

| Command | Purpose |
|---------|---------|
| `engram export [--out <file>] [--scope <scope>...] [--include-inactive] [--kinds memories,entities,relationships,commitments]` | Write JSONL to stdout (or `--out`). Header line first (`kind: header`, `v: 1`, per-kind counts, applied `schema_migrations`), then one `{kind, v, data}` line per record with JSON columns decoded. Default: all scopes, active memories only, all kinds. `--scope` filters memories only (entities/relationships/commitments are unscoped). Embeddings are **not** exported. |
| `engram import <file> [--scope <override>] [--dry-run]` | Read that JSONL. Idempotent by id: an existing id is updated in place only when the incoming record is newer (`updated_at` for memories/relationships, `last_seen` for entities, `resolved_at` for commitments, each falling back to `created_at`), otherwise skipped. Inserts go through the existing helpers so `memories_fts`/`entities_fts` and the vec0 tables are regenerated from content. Relationships whose endpoints are missing are skipped and counted. `--scope` overrides the scope on every imported memory. The whole file is validated before the first write; a malformed line exits non-zero with nothing changed. |

Tests: `tests/interfaces/cli/transfer.test.ts`.

## See Also

- [interfaces/shared/](../shared/) — Shared operation logic used by CLI and MCP
- [interfaces/](../) — Parent interfaces module
- [docs/user-guide.md](../../../docs/user-guide.md) — User-facing CLI documentation
