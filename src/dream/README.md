# Dream

Autonomous memory consolidation pipeline — orchestrates the five-phase dream cycle (ingest, extract, consolidate, reflect, prune) on schedule or on demand.

## Contains

- `daemon` — Pipeline orchestrator with phase sequencing and signal handling
- `scheduler` — Run lifecycle management, checkpointing, conversation prioritization
- `intelligence` — *(transitional)* LLM tier config, migrating to `_core/llm/`

## Key Interfaces

- `runDream(db, config, options) → DreamReport` — Execute dream pipeline
- `DreamOptions` — Phase selection, conversation targeting, dry-run, progress callbacks
- `DreamReport` — Per-phase metrics: items processed, errors, duration, new memories/entities

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [Parent](../README.md) — System context
