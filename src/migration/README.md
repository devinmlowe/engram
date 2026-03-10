# Migration

Data migration utilities for importing conversation history from the legacy superpowers conversation-index database into engram's schema.

## In Scope

- Schema mapping from superpowers DB to engram tables
- Data import with re-embedding (nomic-embed-text replaces all-MiniLM-L6-v2)
- Migration validation and integrity checks

## Out of Scope

- Ongoing conversation sync (see [episodic/sync](../episodic/))
- Schema definition and management (see [_core/db/](../_core/db/))

## Contains

- `migrate.ts` — Import exchanges, tool calls, and conversations from superpowers DB
- `validate.ts` — Post-migration integrity validation
- `types.ts` — Migration-specific type definitions

## See Also

- [docs/research/data-migration-strategy.md](../../docs/research/data-migration-strategy.md) — Migration analysis and design
- [SPEC-legacy.md](../../SPEC-legacy.md) — Phase 2 migration specification
- [tests/migration/](../../tests/migration/) — Migration test suite
