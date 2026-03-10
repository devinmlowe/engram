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
- `schema.ts` — Full schema definition and initialization
- `helpers.ts` — Thin data access helpers (upsert, batch insert)
- `fts.ts` — FTS5 index rebuild and sync utilities
- `vector.ts` — sqlite-vec vector table operations
- `index.ts` — Module exports

## See Also

- [SPEC.md](./SPEC.md) — Module specification
- [decisions/004-thin-data-access-layer.md](../../../decisions/004-thin-data-access-layer.md) — Design rationale
- [_core/](../) — Parent shared infrastructure
