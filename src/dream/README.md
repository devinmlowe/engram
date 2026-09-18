# Dream

Autonomous memory consolidation pipeline — orchestrates the five-phase dream cycle (ingest, extract, consolidate, reflect, prune) on schedule or on demand.

## In Scope

- Pipeline orchestration with phase sequencing and signal handling
- Run lifecycle management, checkpointing, and resume
- Conversation prioritization and work scheduling
- Progress reporting and dream run metrics

## Out of Scope

- Phase-specific processing logic (composed from episodic, semantic, and graph modules)
- LLM provider management (see [_core/llm/](../_core/llm/))
- Scheduling infrastructure (see [launchd/](../../launchd/) for macOS service)

## Contains

- `daemon` — Pipeline orchestrator with phase sequencing and signal handling. Extract drops facts whose content hash is in `memory_suppressions` (forgotten statements, #55; reported as `suppressedFacts`); prune hard-deletes forgotten memories older than `ENGRAM_FORGET_RETENTION_DAYS` (`forgottenPurged`, #56) and, via `pruneOrphanEntities`, removes `stale_since` graph rows with no remaining evidence regardless of age (`staleEntitiesPruned` / `staleRelationshipsPruned`, #57)
- `commitments-pass` — Commitments pass of the EXTRACT phase: scans never-scanned (or grown) conversations, cross-run checkpoints under phase `commitments`, capped by `ENGRAM_COMMITMENTS_MAX_CONVERSATIONS` (default 60); errors are logged and skipped
- `scheduler` — Run lifecycle management, checkpointing, conversation prioritization; extract checkpoints carry a conversation fingerprint (sha256 over each exchange's id, index, timestamp and message text) so unchanged conversations are skipped on later runs — a same-length in-place edit still counts as a change (`dream --force` overrides) (W12, #23)
- `types` — Dream-specific type definitions (DreamPhase, DreamReport, DreamOptions)

## Key Interfaces

- `runDream(db, config, options) → DreamReport` — Execute dream pipeline
- `DreamOptions` — Phase selection, conversation targeting, dry-run, progress callbacks
- `DreamReport` — Per-phase metrics: items processed, errors, duration, new memories/entities, `skippedUnchanged` (fingerprint-skipped conversations), `collapsedCandidates` (near-duplicate candidates folded before insertion, run-level + intra-batch)

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [src/](../) — Parent source directory
- [launchd/](../../launchd/) — macOS Launch Agent plists for scheduling
- [scripts/run-dream.sh](../../scripts/run-dream.sh) — Manual dream execution wrapper
- [tests/dream/](../../tests/dream/) — Test suite
