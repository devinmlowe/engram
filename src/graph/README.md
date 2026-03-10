# Graph

Manages the knowledge graph — entities, relationships, topic clusters, community detection, temporal patterns, and structural analysis. Owns how things connect; content ownership belongs to semantic.

## Contains

- `extractor` — LLM-powered entity and relationship extraction
- `resolver` — Multi-stage entity resolution
- `entity` — Entity CRUD and alias management
- `relationship` — Relationship CRUD and edge weight computation
- `analyzer` — Community detection and bridge scoring
- `naming` — LLM-powered community naming
- `temporal` — Temporal pattern analysis
- `reflection` — Reflection pipeline orchestration
- `search` — Graph search and entity exploration

## Key Interfaces

- `extractEntities(conversation) → EntityExtractionResult` — Extract entities from exchanges
- `searchGraph(db, options) → LayerSearchResult[]` — Graph-layer search
- `exploreEntity(db, options) → ExploreResult | null` — Neighborhood traversal
- `runReflection(db, config) → ReflectResult` — Full reflection pipeline

## See Also

- [SPEC.md](./SPEC.md) — Full specification
- [Parent](../README.md) — System context
