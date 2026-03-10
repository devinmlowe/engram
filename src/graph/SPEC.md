---
module: graph
level: L1
derives-from: ../../SPEC.md
status: draft
verified-by: ../../tests/graph/
decision-log:
  - ../../decisions/005-unified-llm-factory.md
  - ../../decisions/006-shared-search-contract.md
  - ../../decisions/007-hybrid-type-ownership.md
---

# Graph

The graph domain manages the knowledge graph — entities, typed relationships, topic clusters, and emergent structural analysis. It owns the structural layer of engram's memory: how things connect, not what they contain (content ownership belongs to semantic).

## Requirements

- **REQ-1**: The domain shall extract entities and relationships from conversations via LLM. *(traces to L0 REQ-2, REQ-3)*
- **REQ-2**: The domain shall resolve extracted entities against existing graph nodes (exact name, alias, embedding similarity, LLM disambiguation). *(traces to L0 REQ-3)*
- **REQ-3**: The domain shall detect communities via graph analysis (Louvain-style modularity). *(traces to L0 REQ-3)*
- **REQ-4**: The domain shall identify bridge entities that connect communities. *(traces to L0 REQ-3)*
- **REQ-5**: The domain shall detect temporal patterns (bursts, shifts, emergence, decay). *(traces to L0 REQ-3)*
- **REQ-6**: The domain shall provide graph search returning `LayerSearchResult[]`. *(traces to L0 REQ-4)*
- **REQ-7**: The domain shall support entity exploration (neighborhood traversal with depth). *(traces to L0 REQ-4)*
- **REQ-8**: The domain shall generate community names and reflection observations via LLM. *(traces to L0 REQ-3)*

## Interface Contract

### Preconditions

- **PRE-1**: Database shall be initialized with graph schema (entities, relationships, topic_clusters tables).
- **PRE-2**: `_core/llm/` shall be available for extraction and naming operations.

### Postconditions

- **POST-1**: `searchGraph()` shall return results conforming to `LayerSearchResult[]` contract.
- **POST-2**: `exploreEntity()` shall return null when entity is not found (not throw).
- **POST-3**: Entity resolution shall produce one of: merge (with existing) or create (new node).
- **POST-4**: Community detection shall produce coherence scores for each cluster.

### Invariants

- **INV-1**: The domain owns structure (entities, relationships, clusters) — not content (memories).
- **INV-2**: Relationship weights shall be recomputed from source factors, never manually set.
- **INV-3**: Entity IDs shall be stable across resolution — merges update aliases, not IDs.

## Decomposes Into

- `extractor` — LLM-powered entity and relationship extraction (owns prompt templates and schemas)
- `resolver` — Multi-stage entity resolution (exact → alias → embedding → LLM → create)
- `entity` — Entity CRUD and alias management
- `relationship` — Relationship CRUD and edge weight computation
- `analyzer` — Community detection, modularity, bridge scoring
- `naming` — LLM-powered community naming
- `temporal` — Temporal pattern analysis across graph generations
- `reflection` — Reflection pipeline: edge weights, communities, bridges, observations, pruning
- `search` — Graph-layer search and entity exploration

## Dependencies

- [_core/db](../_core/db/SPEC.md) — Database connection and query helpers
- [_core/embeddings](../_core/embeddings/SPEC.md) — Embedding similarity for entity resolution
- [_core/llm](../_core/llm/SPEC.md) — LLM client factory for extraction, naming, observations
- [_core/types](../_core/types/SPEC.md) — `SearchOptions`, `LayerSearchResult`

## Verification

| ID | Method | Location |
|----|--------|----------|
| REQ-1 | Integration test | `../tests/graph/extractor.test.ts` |
| REQ-2 | Unit test | `../tests/graph/resolver.test.ts` |
| REQ-3 | Unit test | `../tests/graph/analyzer.test.ts` |
| REQ-6 | Integration test | `../tests/graph/search.test.ts` |
| REQ-7 | Unit test | `../tests/graph/explore.test.ts` |
| POST-2 | Unit test | `../tests/graph/explore.test.ts` |
