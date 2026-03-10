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

- `daemon` — Pipeline orchestrator with phase sequencing and signal handling
- `scheduler` — Run lifecycle management, checkpointing, conversation prioritization
- `types` — Dream-specific type definitions (DreamPhase, DreamReport, DreamOptions)

## Key Interfaces

- `runDream(db, config, options) → DreamReport` — Execute dream pipeline
- `DreamOptions` — Phase selection, conversation targeting, dry-run, progress callbacks
- `DreamReport` — Per-phase metrics: items processed, errors, duration, new memories/entities

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [src/](../) — Parent source directory
- [launchd/](../../launchd/) — macOS Launch Agent plists for scheduling
- [scripts/run-dream.sh](../../scripts/run-dream.sh) — Manual dream execution wrapper
- [tests/dream/](../../tests/dream/) — Test suite
