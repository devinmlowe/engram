# Search

Multi-source search orchestration — combines episodic, semantic, and graph search results via Reciprocal Rank Fusion with optional cross-encoder reranking. Also hosts RLM session management and file analysis tools.

## In Scope

- Search orchestration across all memory layers
- RRF fusion and score normalization
- Cross-encoder reranking (BGE-reranker-base)
- Token budget tracking and enforcement
- Stateful recall sessions with iterative refinement
- File snippet fetching and regex-based scanning

## Out of Scope

- Layer-specific search logic (owned by episodic, semantic, graph modules)
- Embedding generation (see [_core/embeddings/](../embeddings/))

## Contains

- `orchestrator.ts` — Multi-source search composition and fusion
- `rrf.ts` — Reciprocal Rank Fusion implementation
- `reranker.ts` — Cross-encoder reranking with BGE-reranker-base
- `budget.ts` — Token budget tracking and enforcement
- `format.ts` — Search result formatting for MCP/CLI output
- `text.ts` — Full-text search utilities
- `session.ts` — Stateful recall session management (Phase 6B)
- `drill.ts` — Deep drill into search results (Phase 6B)
- `snippets.ts` — Multi-range file snippet fetching (Phase 7A)
- `scan.ts` — Regex-based file scanning with context (Phase 7D)
- `index.ts` — Module exports

## See Also

- [SPEC.md](./SPEC.md) — Module specification
- [decisions/006-shared-search-contract.md](../../../decisions/006-shared-search-contract.md) — Search contract design
- [_core/](../) — Parent shared infrastructure
