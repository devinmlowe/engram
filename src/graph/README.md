# Graph

Manages the knowledge graph — entities, relationships, topic clusters, community detection, temporal patterns, and structural analysis. Owns how things connect; content ownership belongs to [semantic/](../semantic/).

## In Scope

- Entity extraction, resolution, and alias management
- Relationship extraction and edge weight computation
- Community detection (Louvain), bridge scoring, temporal patterns
- Reflection pipeline (observations, naming, pattern synthesis)
- File structure indexing into graph entities (Phase 7B)
- Graph search and entity exploration

## Out of Scope

- Memory content and confidence (see [semantic/](../semantic/))
- Raw conversation data (see [episodic/](../episodic/))
- Search orchestration across layers (see [_core/search/](../_core/search/))

## Contains

- `extractor` — LLM-powered entity and relationship extraction
- `resolver` — Multi-stage entity resolution (exact → alias → embedding → LLM)
- `entity` — Entity CRUD and alias management
- `relationship` — Relationship CRUD and edge weight computation
- `analyzer` — Community detection and bridge scoring via graphology
- `naming` — LLM-powered community naming
- `temporal` — Temporal pattern analysis
- `reflection` — Reflection pipeline orchestration
- `search` — Graph search and entity exploration
- `file-indexer` — Source file structure parsing into graph entities (Phase 7B)
- `types` — Graph-specific type definitions

## Key Interfaces

- `extractEntities(conversation) → EntityExtractionResult` — Extract entities from exchanges
- `searchGraph(db, options) → LayerSearchResult[]` — Graph-layer search
- `exploreEntity(db, options) → ExploreResult | null` — Neighborhood traversal
- `runReflection(db, config) → ReflectResult` — Full reflection pipeline

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [src/](../) — Parent source directory
- [prompts/](../../prompts/) — Entity/relationship extraction templates
- [tests/graph/](../../tests/graph/) — Test suite
- [docs/research/graph-analysis-research.md](../../docs/research/graph-analysis-research.md) — graphology research
