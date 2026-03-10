# Contract Tests

Tests that verify cross-module interfaces and invariants — ensuring modules integrate correctly without testing internal implementation details.

## In Scope

- Schema contract tests (DB tables, FTS5, vector tables exist and match expectations)
- Config default verification
- Search orchestration contracts (RRF math, budget enforcement)
- Embedding singleton behavior
- Chunking and recall/remember interface contracts

## Out of Scope

- Module-internal unit tests (see sibling directories)
- End-to-end integration (see [e2e/](../e2e/))

## See Also

- [tests/](../) — Parent test directory
- [src/_core/](../../src/_core/) — Core modules these contracts verify
