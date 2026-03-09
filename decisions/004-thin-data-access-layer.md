# ADR-004: Thin Data Access Layer

**Status**: Accepted
**Date**: 2026-03-09

## Context

13 files across 8 modules execute raw SQL against the SQLite database. A schema change in `core/db.ts` ripples across the entire codebase (issue #5, #18). Three approaches were considered: full repository pattern, thin DAL with query builders, or organized raw SQL.

## Decision

Implement a **thin data access layer** in `_core/db/`. This provides:

- Connection management and schema ownership
- Common query patterns (getById, search, upsert) as typed helpers
- Transaction management with guaranteed atomic commit or rollback
- Raw SQL escape hatch for complex domain-specific queries

Domains own their query logic but call through the DAL for connection access and common patterns.

## Consequences

- Schema changes are isolated to `_core/db/` — domains consume typed interfaces
- Common CRUD patterns are DRY across domains
- Complex queries (e.g., graph traversals, FTS5 hybrid search) can still use raw SQL
- Migration path from current raw SQL is incremental — wrap existing queries one at a time
- Avoids over-engineering of full ORM/repository pattern for a single-user SQLite system
