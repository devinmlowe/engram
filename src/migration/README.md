# Migration

One-off data backfills that rewrite existing rows once. Schema changes live in `_core/db/schema.ts`; install/data-dir migration is `engram migrate` in `interfaces/cli/data-migration.ts`; store integrity checks are `engram validate` in `interfaces/cli/validate.ts`.

## In Scope

- Backfills over already-stored rows that need data from outside the database

## Out of Scope

- Schema definition and `schema_migrations` checkpoints (see [_core/db/](../_core/db/))
- Ongoing conversation sync (see [episodic/](../episodic/))
- Install/data-dir migration and store validation (see [interfaces/cli/](../interfaces/cli/))

## Contains

- `backfill-event-ts.ts` — Recover `memories.event_ts` from the dream pipeline's pending-facts files (`engram backfill-event-ts`)

## See Also

- [tests/migration/](../../tests/migration/) — Backfill and schema-column tests
