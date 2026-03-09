---
module: dream
level: L1
derives-from: ../SPEC.md
status: draft
verified-by: ../tests/dream/
decision-log:
  - ../decisions/001-target-architecture.md
  - ../decisions/005-unified-llm-factory.md
---

# Dream

The dream domain orchestrates autonomous memory consolidation through a five-phase pipeline (INGEST → EXTRACT → CONSOLIDATE → REFLECT → PRUNE) that runs on a schedule or on demand. It mimics human memory synthesis — processing raw experiences into structured knowledge during "off-hours."

## Requirements

- **REQ-1**: The domain shall execute a sequential five-phase pipeline: ingest (sync + embed), extract (facts + entities), consolidate (merge + link), reflect (communities + patterns + observations), prune (decay + forget). *(traces to L0 REQ-5)*
- **REQ-2**: The domain shall support per-conversation checkpointing for crash-safe resume. *(traces to L0 REQ-5)*
- **REQ-3**: The domain shall schedule runs via configurable cron-style timing (default: 2 AM). *(traces to L0 REQ-5)*
- **REQ-4**: The domain shall handle graceful shutdown on SIGTERM/SIGINT, completing the current item before stopping. *(traces to L0 REQ-5)*
- **REQ-5**: The domain shall apply type-specific decay rates to memory retrievability during the prune phase. *(traces to L0 REQ-9)*
- **REQ-6**: The domain shall produce a `DreamReport` with per-phase metrics on completion. *(traces to L0 POST-3)*
- **REQ-7**: The domain shall support selective phase execution and single-conversation targeting. *(traces to L0 REQ-5)*

## Interface Contract

### Preconditions

- **PRE-1**: Database shall be initialized and populated with episodic data.
- **PRE-2**: At least one LLM provider shall be reachable (via `_core/llm/`).
- **PRE-3**: Embedding pipeline shall be initialized (via `_core/embeddings/`).

### Postconditions

- **POST-1**: Completed runs shall produce a `DreamReport` with non-zero phase entries.
- **POST-2**: Failed items shall be recorded with error details for retry on next run.
- **POST-3**: Checkpoints shall allow resuming from the last successful item, not from scratch.

### Invariants

- **INV-1**: The domain orchestrates other domains' operations — it shall not contain extraction, search, or storage logic itself.
- **INV-2**: The pipeline shall be idempotent — re-running on the same data shall not create duplicates.
- **INV-3**: Shutdown flag shall prevent new item processing but not corrupt in-progress items.

## Decomposes Into

- `daemon` — Pipeline orchestrator: phase sequencing, progress tracking, signal handling
- `scheduler` — Run lifecycle (create/resume/complete/fail), checkpointing, conversation prioritization
- `intelligence` — *(transitional)* LLM tier configuration; migrating to `_core/llm/`

## Dependencies

- [_core/db](../_core/db/SPEC.md) — Database connection and query helpers
- [_core/llm](../_core/llm/SPEC.md) — Unified LLM client factory
- [_core/embeddings](../_core/embeddings/SPEC.md) — Vector embedding pipeline
- [episodic](../episodic/SPEC.md) — Conversation sync and indexing (ingest phase)
- [semantic](../semantic/SPEC.md) — Fact extraction and consolidation (extract + consolidate phases)
- [graph](../graph/SPEC.md) — Entity extraction and reflection (reflect phase)

## Verification

| ID | Method | Location |
|----|--------|----------|
| REQ-1 | Integration test | `../tests/dream/daemon.test.ts` |
| REQ-2 | Unit test | `../tests/dream/scheduler.test.ts` |
| REQ-3 | Unit test | `../tests/dream/scheduler.test.ts` |
| REQ-4 | Integration test | `../tests/dream/daemon.test.ts` |
| REQ-6 | Integration test | `../tests/dream/integration.test.ts` |
| INV-2 | Integration test | `../tests/dream/idempotency.test.ts` |
