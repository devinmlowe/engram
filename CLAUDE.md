# CLAUDE.md — Engram

Cognitive memory system that ingests LLM conversation history and consolidates it into structured knowledge via autonomous "dream state" processing. See SPEC.md for full specification.

## Architecture

Four domains with shared core infrastructure:

- **episodic** — Conversation archive ingestion, indexing, episodic search
- **semantic** — Knowledge extraction, consolidation, adaptive chunking, decay
- **graph** — Entity/relationship graph, topic clusters, file structure indexing, reflection
- **dream** — Autonomous consolidation pipeline (ingest → extract → consolidate → reflect → prune)

Shared infrastructure in `_core/` (config, db, types, embeddings, search, llm, cache). Interfaces in `interfaces/` (CLI, MCP server, web visualization).

## Engram MCP Tools

### Core Tools

- **recall** — Hybrid search (vector + FTS5 + graph) with token budget enforcement
- **remember** — Store a single memory (fact, decision, pattern, solution, convention, preference)
- **show** — Retrieve full conversation or memory context
- **explore** — Fixed-depth graph traversal from an entity
- **reflect** — Graph analysis — communities, bridges, temporal patterns

### Memory & Knowledge (Phase 6 RLM)

- **recall_session** — Create/resume a stateful recall session with token budget tracking
- **recall_drill** — Drill into a specific memory for full content with budget deduction
- **explore_selective** — Criteria-driven graph traversal; returns relevant nodes without loading raw data
- **remember_batch** — Batch ingest memories with adaptive chunking and dedup

### File Analysis (Phase 7)

- **index_file_structure** — Parse a source file server-side; extract and index functions, classes, modules as graph entities. Use FIRST on unfamiliar files to get a structural map before reading.
- **fetch_snippets** — Read multiple line ranges from a file in one call (session budget aware). Replaces multiple Read calls with a single request.
- **scan_file** — Apply up to 10 regex patterns against a file server-side; returns structured matches with context lines and enclosing function name. The file is NEVER loaded into context.

### Recommended Workflow

For large file analysis, combine tools in this order:
1. `index_file_structure` → structural map (functions, classes, relationships)
2. `explore_selective` → find relevant code by criteria without reading the file
3. `scan_file` → exhaustive regex search for enumeration tasks (breadth)
4. `fetch_snippets` → read specific line ranges for detail extraction (depth)

## CLI Commands (14)

`init`, `sync`, `search`, `remember`, `extract`, `dream`, `reflect`, `explore`, `entities`, `relationships`, `stats`, `health`, `migrate`, `validate`

## Web Visualization

Port 3000 — Force graph (`/graph`), 3D depth view (`/graph/depth`), galaxy view (`/graph/galaxy`), word cloud (`/words`). Real-time SSE updates via WAL watching, dream pipeline control with live phase tracking.

Terminal-optimized views at `/terminal/graph`, `/terminal/depth`, `/terminal/words`, `/terminal/communities` — SVG-based, pre-stabilized, high-contrast layouts for carbonyl or other terminal browsers.

**Theme:** Everforest Hard Dark, centralized in `src/interfaces/web/pages/theme.ts`. All page files import colors from this module — no hardcoded hex values in pages. See ADR-009 for theming architecture and carbonyl rendering lessons.

Start: `npx tsx src/interfaces/web/server.ts`

## Key Configuration

- `ENGRAM_DB_PATH` — Database path (default: `~/.local/share/engram/engram.db`)
- `ENGRAM_CHUNKING_STRATEGY` — `fixed` or `adaptive` (content-aware chunk boundaries)
- `ENGRAM_LLM_PROVIDER` / `ENGRAM_LLM_MODEL` — LLM provider and model selection

## Development

```bash
npm run build        # TypeScript compilation
npm run test:run     # Run tests (vitest, 56 test files)
npm run mcp          # Start MCP server
npm run dev          # Dev CLI via tsx
npm run dream        # Run dream consolidation
npm run lint         # Type-check without emit
```

## References

- `SPEC.md` — Full specification with requirements and interface contract
- `plans/` — Implementation plans (phases 1–4, phase 6 RLM, phase 7 extensions)
- `decisions/` — Architecture Decision Records (9 ADRs)
