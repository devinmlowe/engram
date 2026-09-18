---
module: db
level: L2
derives-from: ../SPEC.md
status: draft
verified-by:
  - ../../../tests/core/db.test.ts
  - ../../../tests/core/writer-contention.test.ts
decision-log:
  - ../../../decisions/004-thin-data-access-layer.md
---

# DB

Database connection management, schema ownership, and thin data access layer. Provides typed query helpers for common patterns while allowing raw SQL for complex domain queries.

## Requirements

- **REQ-1**: The module shall initialize SQLite with WAL mode, foreign keys, and required extensions (sqlite-vec, FTS5). *(traces to L0 PRE-1)*
- **REQ-2**: The module shall own the complete database schema and all migrations. *(traces to L0 INV-2)*
- **REQ-3**: The module shall provide typed helpers for common patterns: getById, search, upsert, transaction wrapping. *(traces to ADR-004)*
- **REQ-4**: The module shall expose the raw database connection for complex domain queries. *(traces to ADR-004)*
- **REQ-5**: The module shall let several processes write one WAL database without surfacing `SQLITE_BUSY` on the recall hot path: `busy_timeout = 5000` on every connection, read-then-write transactions opened as `BEGIN IMMEDIATE`, and `withBusyRetry` (`busy.ts`) for best-effort writes. *(#26)*
- **REQ-6**: The schema shall carry the memory lifecycle surface (#55, checkpoint `forget_v1`): nullable `memories.deleted_at` (ISO-8601) and `deleted_by`; `memory_changes(id, memory_id, op ∈ forget|edit|purge|restore, before, after, actor, at)`; `memory_suppressions(content_hash PRIMARY KEY, memory_id, scope, created_at)`; and nullable `entities.stale_since` / `relationships.stale_since`. The migration is idempotent and runs after the entities/relationships rebuild.

## Concurrency model

Writers sharing `engram.db`: the nightly dream daemon (many short per-fact transactions, yielding between conversations), the HTTP MCP daemon's worker threads (one connection each; `recall` writes FSRS reinforcement), per-profile stdio MCP servers, and CLI commands. Readers: the visualizer (read-only connection) and every recall.

- WAL mode lets readers proceed during a write; only writers serialise.
- `busy_timeout = 5000`: a statement waits up to 5 s for the lock before raising `SQLITE_BUSY`.
- Any transaction that reads and then writes the same rows (`recordAccess`, `recordCheckpoint`, `findOrCreateRelationship`) starts with `.immediate()` so it takes the reserved lock up front and cannot deadlock on a lock upgrade.
- Recall reinforcement is best-effort: `withBusyRetry` (3 attempts, 25 ms base backoff with jitter) and then the round is skipped; the recall itself never fails on contention (**INV-3**).
- One dream run per data dir: `runDream` takes `<dataDir>/tmp/dream.lock` (pid; stale locks are taken over) and a concurrent `engram dream` fails fast with `DreamLockedError`.

## Interface Contract

### Preconditions

- **PRE-1**: SQLite binary and extensions shall be available on the system.

### Postconditions

- **POST-1**: `initDatabase()` shall return a fully initialized database with current schema.
- **POST-2**: All writes via helpers shall be transactional (atomic commit or full rollback).

### Invariants

- **INV-1**: Schema changes shall be backward-compatible or handled via migration scripts.
- **INV-2**: The module shall not contain domain-specific query logic — domains own their queries.
- **INV-3**: A read shall never fail because a best-effort write that rides on it (recall reinforcement) lost the write lock; such writes are skipped, not surfaced. *(#26)*
