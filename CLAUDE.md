# CLAUDE.md — Engram

Cognitive memory system that ingests LLM conversation history and consolidates it into structured knowledge via autonomous "dream state" processing. See SPEC.md for full specification.

## Architecture

Four domains: **episodic** (conversation archive ingestion/indexing), **semantic** (knowledge extraction/consolidation), **graph** (entity/relationship graph), **dream** (autonomous consolidation pipeline). Shared infrastructure in `_core/` (config, db, types, embeddings, search, llm, cache).

## Phase 6 RLM Tools

MCP tools for Recursive Large Model context management:

- **recall_session** — Create/resume a stateful recall session with token budget tracking
- **recall_drill** — Drill into a specific memory for full content with budget deduction
- **explore_selective** — Multi-step selective exploration with session state
- **remember_batch** — Batch ingest memories with adaptive chunking

## Adaptive Chunking

Set `ENGRAM_CHUNKING_STRATEGY=adaptive` to enable content-aware chunk sizing (adjusts boundaries based on semantic structure rather than fixed token counts).

## Development

```bash
npm run build        # TypeScript compilation
npm run test:run     # Run tests (vitest)
npm run mcp          # Start MCP server
npm run dev          # Dev CLI via tsx
npm run dream        # Run dream consolidation
npm run lint         # Type-check without emit
```

## References

- `SPEC.md` — Full specification with requirements and interface contract
- `plans/` — Implementation plans (phases 1-4, phase 6 RLM integration)
- `plans/phase-6-rlm-integration.md` — RLM integration master plan
