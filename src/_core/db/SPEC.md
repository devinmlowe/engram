---
module: db
level: L2
derives-from: ../SPEC.md
status: draft
verified-by: ../../../tests/core/db.test.ts
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

## Interface Contract

### Preconditions

- **PRE-1**: SQLite binary and extensions shall be available on the system.

### Postconditions

- **POST-1**: `initDatabase()` shall return a fully initialized database with current schema.
- **POST-2**: All writes via helpers shall be transactional (atomic commit or full rollback).

### Invariants

- **INV-1**: Schema changes shall be backward-compatible or handled via migration scripts.
- **INV-2**: The module shall not contain domain-specific query logic — domains own their queries.
