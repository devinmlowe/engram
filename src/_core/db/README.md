# Database

SQLite database connection, schema management, and thin data access helpers. All persistent state resides in a single SQLite file with WAL mode enabled.

## In Scope

- Database connection management and PRAGMA configuration
- Schema definition and migration (12 tables + 5 virtual tables)
- FTS5 full-text search index management
- sqlite-vec vector table management
- Thin query helpers (no ORM, direct SQL)

## Out of Scope

- Domain-specific query logic (owned by each domain module)
- Embedding generation (see [_core/embeddings/](../embeddings/))

## Contains

- `connection.ts` — Database connection with WAL mode, PRAGMA tuning
- `schema.ts` — Full schema definition and initialization. Checkpointed migrations in `schema_migrations`: `commitments_v1`, `conversations_scope_v1`, `graph_scope_v1`, `exchanges_author_v1`, `forget_v1` (#55: `memories.deleted_at` / `deleted_by`, `memory_changes`, `memory_suppressions`, `entities.stale_since`, `relationships.stale_since`). Schema version (#65): `SCHEMA_MIGRATIONS` is that list in apply order, `SCHEMA_VERSION` its length, `schemaVersion(db)` the checkpoints a database has recorded, and `BREAKING_MIGRATIONS` the checkpoints an older build cannot read past (empty: every migration is additive). `engram update` persists the version, and `--rollback` refuses a code-only rollback across a breaking one — add a checkpoint to the set in the same change that makes it breaking
- `helpers.ts` — Thin data access helpers (upsert, batch insert)
- `fts.ts` — FTS5 index rebuild and sync utilities
- `vector.ts` — sqlite-vec vector table operations
- `update.ts` — `buildUpdate(columns)`: SET fragments + values for partial updates, skipping undefined (#121)
- `index.ts` — Module exports

## See Also

- [SPEC.md](./SPEC.md) — Module specification
- [decisions/004-thin-data-access-layer.md](../../../decisions/004-thin-data-access-layer.md) — Design rationale
- [_core/](../) — Parent shared infrastructure
