# Tests

Vitest test suites organized to mirror the source structure. Run via `npm run test:run` (single pass) or `npm test` (watch mode).

## In Scope

- Unit tests for individual modules
- Contract tests verifying cross-module interfaces
- Integration tests for composed workflows
- End-to-end tests for CLI and MCP server

## Out of Scope

- Source implementation (see [src/](../src/))
- Test infrastructure and framework config (see [vitest](../package.json) in package.json)

## Contains

- [helpers.ts](./helpers.ts) — Shared test utilities (in-memory DB setup, fixtures)
- [contracts/](./contracts/) — Cross-module contract tests (schema, config, search, chunking)
- [core/](./core/) — `_core/` infrastructure tests (db, cache, sessions, scan, snippets)
- [dream/](./dream/) — Dream pipeline tests (daemon, scheduler, intelligence)
- [e2e/](./e2e/) — End-to-end tests (full pipeline, MCP server)
- [episodic/](./episodic/) — Episodic layer tests (parser, store, search, sync, embeddings)
- [graph/](./graph/) — Graph layer tests (entities, relationships, reflection, file indexer)
- [migration/](./migration/) — Data migration tests (migrate, validate)
- [retrieval/](./retrieval/) — Search retrieval tests (context, reranker)
- [semantic/](./semantic/) — Semantic layer tests (extractor, consolidator, decay, NLI, batch)

## See Also

- [src/](../src/) — Source modules these tests verify
- [SPEC.md](../SPEC.md) — Verification table mapping requirements to test locations
