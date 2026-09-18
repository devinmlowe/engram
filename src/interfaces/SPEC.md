---
module: interfaces
level: L1
derives-from: ../../SPEC.md
status: draft
verified-by: ../../tests/interfaces/
decision-log:
  - ../../decisions/001-target-architecture.md
  - ../../decisions/006-shared-search-contract.md
---

# Interfaces

The interfaces domain provides all external access points to engram: CLI for direct human interaction, MCP server for LLM agent integration, and web interface for visualization and management. All interfaces share the same underlying search and memory operations with consistent behavior.

## Requirements

- **REQ-1**: All interfaces shall use `_core/search/searchMultiSource()` for recall operations — no interface shall implement its own search path. *(traces to L0 REQ-4, REQ-6, REQ-7)*
- **REQ-2**: CLI and MCP shall expose the same memory capabilities — recall (CLI `search` / MCP `recall`), remember, explore, reflect, forget (CLI `memories delete` / MCP `forget`) — each routed through the same `interfaces/shared/` or `semantic/` operation. Operator actions (`dream`, `sync`, `init`, `migrate`, `memories edit|restore|purge|log`, `validate --fix`, …) are CLI-only by design; turn-level ingestion for agents is MCP `ingest_turn`. *(traces to L0 REQ-6, REQ-7)*
- **REQ-3**: MCP output shall be optimized for LLM consumption (XML formatting, token-aware truncation). *(traces to L0 REQ-6)*
- **REQ-4**: The web interface shall provide graph visualization, word cloud, and dream pipeline management. *(traces to L0 REQ-4)*
- **REQ-5**: The `remember` operation shall deduplicate against existing memories using embedding similarity. *(traces to L0 REQ-10)*
- **REQ-6**: All interfaces shall use consistent parameter naming conventions. *(traces to L0 INV-4)*

## Interface Contract

### Preconditions

- **PRE-1**: Database shall be initialized and accessible.
- **PRE-2**: Embedding pipeline shall be initialized for search and remember operations.

### Postconditions

- **POST-1**: MCP `recall` shall return XML-formatted results within the requested token budget.
- **POST-2**: CLI `search` shall return human-readable formatted results.
- **POST-3**: Web interface shall serve on configurable port with real-time updates via SSE.
- **POST-4**: `remember` dedup logic shall be identical across CLI and MCP — no behavioral divergence.

### Invariants

- **INV-1**: Interfaces shall not contain business logic — they are adapters to domain operations.
- **INV-2**: Parameter naming shall use snake_case for MCP tool inputs and camelCase for internal APIs.
- **INV-3**: MCP retrieval tools (`recall`, `recall_session`, `recall_drill`) shall be annotated `readOnlyHint: true` even though retrieval reinforces the memories it returns. Reinforcement is FSRS bookkeeping only — `access_count`, `last_accessed`, `stability` — and never creates, edits or deletes a memory or changes its content; annotating it as a write would make MCP clients prompt for approval on every recall. The tool descriptions shall state the bookkeeping and that `reinforce: false` opts out. Tools that create or modify memories, commitments, exchanges or graph entities (`remember`, `remember_batch`, `reflect`, `index_file_structure`, `commitments_update`, `ingest_turn`, `forget`) shall be `readOnlyHint: false`. *(decision recorded with #22)*
- **INV-4**: `forget` shall be the only tool annotated `destructiveHint: true`, shall never delete on a query unless `confirm` is true and the query is unambiguous (one result, or one result whose normalised content equals the normalised query), shall record the MCP client's `clientInfo.name` (or `cli`) as the actor of every change, and shall refuse memories outside the call's `read_scopes` unless `scope` is `"global"`. *(#55; decisions #56, #57)*

## Decomposes Into

- [CLI](./cli/SPEC.md) — Command-line interface (commander-based)
- [MCP](./mcp/SPEC.md) — Model Context Protocol server for LLM agents
- [Web](./web/SPEC.md) — Web interface for visualization and management

## Dependencies

- [_core/search](../_core/search/SPEC.md) — Multi-source search orchestration
- [_core/db](../_core/db/SPEC.md) — Database connection
- [_core/embeddings](../_core/embeddings/SPEC.md) — Embedding pipeline for remember dedup
- [episodic](../episodic/SPEC.md) — Conversation sync operations
- [semantic](../semantic/SPEC.md) — Memory operations (insert, find nearest)
- [graph](../graph/SPEC.md) — Entity exploration and reflection queries
- [dream](../dream/SPEC.md) — Dream pipeline triggering

## Verification

| ID | Method | Location |
|----|--------|----------|
| REQ-1 | Unit test (partial) | `../tests/contracts/recall-contract.test.ts` (MCP recall handler routed through the shared search); CLI path uncovered |
| REQ-2 | Contract test | `../tests/contracts/interface-parity.test.ts` (the four shared capabilities are registered on both surfaces and both import them from `interfaces/shared/`) |
| REQ-3 | Unit test | `../tests/contracts/recall-contract.test.ts` (XML output), `../tests/episodic/search.test.ts` (formatRecallXml) |
| REQ-5 | Unit test | `../tests/contracts/remember-contract.test.ts`, `../tests/e2e/mcp-server.test.ts` (remember deduplication) |
| POST-4 | Contract test | `../tests/contracts/interface-parity.test.ts` (both surfaces call `rememberFact()` from `../src/interfaces/shared/remember.ts` and neither inserts memories directly); dedup behaviour itself: `../tests/contracts/remember-contract.test.ts` |
| INV-3 | Unit test | `../tests/interfaces/mcp/tool-annotations.test.ts` (readOnlyHint per tool, reinforcement sentence on retrieval tools) |
