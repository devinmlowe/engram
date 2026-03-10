---
module: search
level: L2
derives-from: ../../../SPEC.md
status: draft
verified-by: ../../../tests/search/
decision-log:
  - ../../../decisions/006-shared-search-contract.md
---

# Search

Multi-source search orchestration, result fusion, score normalization, and output formatting. Composes domain-level search results into unified recall responses within token budgets.

## Requirements

- **REQ-1**: The module shall orchestrate parallel search across episodic, semantic, and graph domains. *(traces to L0 REQ-4)*
- **REQ-2**: The module shall fuse cross-source results using Reciprocal Rank Fusion (RRF). *(traces to L0 REQ-4)*
- **REQ-3**: The module shall normalize scores to [0.1, 1.0] using min-max scaling. *(traces to L0 REQ-4)*
- **REQ-4**: The module shall enforce token budgets with priority-aware allocation (semantic > graph > episodic). *(traces to L0 REQ-8)*
- **REQ-5**: The module shall support optional cross-encoder reranking. *(traces to L0 REQ-4)*
- **REQ-6**: The module shall format recall results as XML for LLM consumption. *(traces to L0 REQ-6)*

## Interface Contract

### Preconditions

- **PRE-1**: Domain search functions shall conform to `search(db, options) → LayerSearchResult[]` contract.

### Postconditions

- **POST-1**: `searchMultiSource()` shall return `RecallResponse` within the specified token budget.
- **POST-2**: Results shall be ordered by fused relevance score, descending.

### Invariants

- **INV-1**: The module shall not contain domain-specific search logic — it composes domain results.
- **INV-2**: RRF fusion constant k=60 shall be configurable but default to 60.

## Dependencies

- [_core/types](../types/SPEC.md) — `SearchOptions`, `LayerSearchResult`, `RecallResponse`
