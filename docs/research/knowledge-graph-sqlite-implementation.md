# Knowledge Graph Implementation in SQLite: State of the Art

> **Project:** engram
> **Domain:** cognitive memory, knowledge graphs, entity resolution
> **Created:** 2026-02-26
> **Purpose:** Research findings to inform Phase 4 (Knowledge Graph) implementation

---

## Table of Contents

1. [Graph Storage Patterns in SQLite](#1-graph-storage-patterns-in-sqlite)
2. [Entity Resolution and Normalization](#2-entity-resolution-and-normalization)
3. [Graph Traversal in SQLite](#3-graph-traversal-in-sqlite)
4. [Community Detection Algorithms](#4-community-detection-algorithms)
5. [Graphiti/Zep Entity Extraction Pipeline](#5-graphitizep-entity-extraction-pipeline)
6. [Microsoft GraphRAG](#6-microsoft-graphrag)
7. [sqlite-vec for Entity Embeddings](#7-sqlite-vec-for-entity-embeddings)
8. [Synthesis: Recommendations for Engram](#8-synthesis-recommendations-for-engram)

---

## 1. Graph Storage Patterns in SQLite

### Edge Table Pattern (Recommended for Engram)

The dominant pattern for storing graphs in SQLite uses separate node and edge tables. The `simple-graph` project demonstrates the canonical minimal schema:

```sql
CREATE TABLE IF NOT EXISTS nodes (
  body TEXT,
  id TEXT GENERATED ALWAYS AS (json_extract(body, '$.id')) VIRTUAL NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS id_idx ON nodes(id);

CREATE TABLE IF NOT EXISTS edges (
  source TEXT,
  target TEXT,
  properties TEXT,
  UNIQUE(source, target, properties) ON CONFLICT REPLACE,
  FOREIGN KEY(source) REFERENCES nodes(id),
  FOREIGN KEY(target) REFERENCES nodes(id)
);
CREATE INDEX IF NOT EXISTS source_idx ON edges(source);
CREATE INDEX IF NOT EXISTS target_idx ON edges(target);
```

**Key design decisions:**
- JSON body storage for flexible node properties (engram already uses this pattern with TEXT columns)
- Composite uniqueness on `(source, target, properties)` prevents duplicate edges
- Separate indexes on both `source` and `target` columns are essential for bidirectional traversal
- Foreign key constraints maintain referential integrity

### Engram's Current Schema Assessment

Engram's existing `entities` and `relationships` tables already follow the edge table pattern correctly:

```sql
-- Entities = nodes
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  aliases TEXT,        -- JSON array of alternate names
  ...
);

-- Relationships = edges
CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL REFERENCES entities(id),
  target_entity_id TEXT NOT NULL REFERENCES entities(id),
  type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  context TEXT,
  ...
);
```

**Recommended additions for Phase 4:**

```sql
-- Composite index for fast edge lookups in both directions
CREATE INDEX IF NOT EXISTS idx_rel_source_target
  ON relationships(source_entity_id, target_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_target_source
  ON relationships(target_entity_id, source_entity_id);

-- Unique constraint to prevent duplicate edges
CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique_edge
  ON relationships(source_entity_id, target_entity_id, type);

-- Entity name lookup (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_entities_name_lower
  ON entities(lower(name));
```

### Adjacency List vs. Edge Table vs. Closure Table

| Pattern | Read Performance | Write Performance | Storage | Best For |
|---------|-----------------|-------------------|---------|----------|
| **Adjacency List** | O(n) per level | O(1) insert | Minimal | Simple parent-child trees |
| **Edge Table** | O(n) per hop via CTE | O(1) insert | Moderate | General graphs with typed edges |
| **Closure Table** | O(1) for any depth | O(n) for inserts | High (quadratic) | Read-heavy hierarchies |

**Verdict for engram:** The edge table pattern is correct. Closure tables are unsuitable because engram's graph is not purely hierarchical and needs frequent writes during dream processing. Recursive CTEs provide adequate traversal performance for the expected scale (100s to low 10,000s of entities).

### Performance at Scale

- **100s of entities:** Recursive CTEs perform well with no special optimization needed
- **1,000s of entities:** Index coverage becomes important; ensure both directions of edge lookups are indexed
- **10,000+ entities:** Consider depth limits on recursive CTEs, pre-computed shortest paths for hot queries, and periodic ANALYZE runs to keep query planner statistics fresh

**Sources:**
- [simple-graph: Graph Database in SQLite](https://github.com/dpapathanasiou/simple-graph)
- [SQLite WITH Clause (Recursive CTE documentation)](https://sqlite.org/lang_with.html)
- [Simple-graph HN Discussion](https://news.ycombinator.com/item?id=25544397)
- [Strategies for Managing Hierarchical Data in SQLite](https://moldstud.com/articles/p-strategies-for-managing-hierarchical-data-structures-in-sqlite)
- [SQLite Graph Ext (Cypher-style queries)](https://news.ycombinator.com/item?id=45751339)

---

## 2. Entity Resolution and Normalization

### Overview of Production Approaches

Entity resolution is the process of determining whether two entity mentions refer to the same real-world thing. This is the single most critical operation for knowledge graph quality.

### Approach Comparison

| System | Entity Resolution Method | Threshold | Notes |
|--------|------------------------|-----------|-------|
| **Zep/Graphiti** | Embedding similarity + full-text + LLM dedup | Not disclosed (uses 1024-dim cosine) | Gold standard but requires Neo4j |
| **Mem0** | LLM extraction + conflict detection + update resolver | Configurable (default 0.75 confidence) | Two-phase: Extract then Update |
| **Microsoft GraphRAG** | LLM-based extraction + description merging | N/A (merges by entity title) | Batch-oriented, not incremental |
| **FalkorDB** | Vector similarity | 0.95 cosine similarity | Very strict — near-exact matches only |
| **General practice** | Cascading: embedding blocking -> fuzzy match -> LLM verify | 0.7-0.9 depending on stage | Cost-effective multi-stage pipeline |

### Recommended Multi-Stage Pipeline for Engram

Given engram's constraint of local-first operation with optional LLM enhancement, a cascading resolution pipeline is recommended:

**Stage 1: Exact Name Match (Free)**
```sql
SELECT id, name, type FROM entities
WHERE lower(name) = lower(?);
```

**Stage 2: Alias Match (Free)**
```sql
-- Search the aliases JSON array
SELECT id, name, type, aliases FROM entities
WHERE aliases LIKE '%' || lower(?) || '%';
```

**Stage 3: Embedding Similarity (Cheap — sqlite-vec)**
```sql
SELECT e.id, e.name, e.type, v.distance
FROM vec_entities v
JOIN entities e ON e.id = v.id
WHERE v.embedding MATCH ?
  AND v.k = 5
ORDER BY v.distance;
-- Apply threshold: cosine distance < 0.15 (similarity > 0.85)
```

**Stage 4: LLM Verification (Expensive — Optional)**
For ambiguous cases where embedding similarity is in the gray zone (0.15-0.30 cosine distance), use an LLM to make the final determination.

### Similarity Threshold Guidelines

Based on research across multiple production systems:

| Cosine Similarity | Cosine Distance | Interpretation | Action |
|-------------------|-----------------|----------------|--------|
| > 0.95 | < 0.05 | Near-identical | Auto-merge |
| 0.85 - 0.95 | 0.05 - 0.15 | Likely same entity | Merge with confidence flag |
| 0.70 - 0.85 | 0.15 - 0.30 | Possibly same entity | LLM verification or manual review |
| < 0.70 | > 0.30 | Likely different | Treat as distinct entities |

**Important caveat:** These thresholds are model-dependent. With smaller embedding models (e.g., 384-dim), thresholds should be lower. With larger models (768-1024 dim), the above ranges apply. Always calibrate by computing pairwise distances for known-same and known-different entity pairs in your data.

### Canonical Name Selection

When merging entities, production systems use these strategies:
1. **Most frequent mention** — The name that appears most often becomes canonical
2. **Most formal/complete mention** — "TypeScript" over "TS", "Visual Studio Code" over "VSCode"
3. **LLM-selected** — Ask the LLM which name is most appropriate given context
4. **Recency-weighted** — More recent mentions may reflect updated naming (e.g., "Twitter" -> "X")

For engram, a pragmatic approach: keep the first-seen name as canonical, store all variants in the `aliases` JSON array, and allow the dream process to periodically re-evaluate canonical names when mention counts diverge significantly.

### Alias Merging

When two entities are determined to be the same:
1. Select one as the canonical entity (higher mention count wins)
2. Merge the other's aliases into the canonical entity's alias array
3. Update all relationships pointing to the merged entity
4. Transfer source_memories references
5. Soft-delete or tombstone the merged-away entity

```sql
-- Merge entity B into entity A
UPDATE entities SET
  aliases = json_insert(aliases, '$[#]', (SELECT name FROM entities WHERE id = ?)),
  mention_count = mention_count + (SELECT mention_count FROM entities WHERE id = ?),
  description = ? -- LLM-merged description or concatenation
WHERE id = ?;

-- Repoint all relationships from B to A
UPDATE relationships SET source_entity_id = ? WHERE source_entity_id = ?;
UPDATE relationships SET target_entity_id = ? WHERE target_entity_id = ?;

-- Remove duplicate relationships that now exist
-- (A->C and B->C become two A->C entries)
DELETE FROM relationships WHERE id IN (
  SELECT r2.id FROM relationships r1
  JOIN relationships r2 ON r1.source_entity_id = r2.source_entity_id
    AND r1.target_entity_id = r2.target_entity_id
    AND r1.type = r2.type
    AND r1.id < r2.id
);
```

**Sources:**
- [Entity Resolution at Scale: Deduplication Strategies for Knowledge Graph Construction](https://medium.com/@shereshevsky/entity-resolution-at-scale-deduplication-strategies-for-knowledge-graph-construction-7499a60a97c3)
- [The Rise of Semantic Entity Resolution (Graphlet AI)](https://blog.graphlet.ai/the-rise-of-semantic-entity-resolution-45c48d5eb00a)
- [Entity-Resolved Knowledge Graphs (Towards Data Science)](https://towardsdatascience.com/entity-resolved-knowledge-graphs-6b22c09a1442/)
- [Pre-trained Embeddings for Entity Resolution (VLDB)](https://www.vldb.org/pvldb/vol16/p2225-skoutas.pdf)
- [Rule of Thumb Cosine Similarity Thresholds (OpenAI Forum)](https://community.openai.com/t/rule-of-thumb-cosine-similarity-thresholds/693670)
- [From LLMs to Knowledge Graphs: Building Production-Ready Graph Systems in 2025](https://medium.com/@claudiubranzan/from-llms-to-knowledge-graphs-building-production-ready-graph-systems-in-2025-2b4aff1ec99a)

---

## 3. Graph Traversal in SQLite

### Recursive CTE Fundamentals

SQLite supports `WITH RECURSIVE` for graph traversal. The key patterns:

#### Breadth-First Search (BFS)

```sql
WITH RECURSIVE reachable(id, depth, path) AS (
  -- Base case: start node
  SELECT id, 0, id
  FROM entities
  WHERE id = :start_id

  UNION

  -- Recursive case: follow edges
  SELECT e.id, r.depth + 1, r.path || ',' || e.id
  FROM reachable r
  JOIN relationships rel ON rel.source_entity_id = r.id
  JOIN entities e ON e.id = rel.target_entity_id
  WHERE r.depth < :max_depth
    AND r.path NOT LIKE '%' || e.id || '%'  -- cycle prevention
)
SELECT * FROM reachable ORDER BY depth;
```

**BFS is the default** when using `UNION` (not `UNION ALL`) because SQLite processes the recursive queue in FIFO order.

#### Depth-First Search (DFS)

```sql
WITH RECURSIVE reachable(id, depth, path) AS (
  SELECT id, 0, id
  FROM entities
  WHERE id = :start_id

  UNION ALL

  SELECT e.id, r.depth + 1, r.path || ',' || e.id
  FROM reachable r
  JOIN relationships rel ON rel.source_entity_id = r.id
  JOIN entities e ON e.id = rel.target_entity_id
  WHERE r.depth < :max_depth
    AND r.path NOT LIKE '%' || e.id || '%'
)
SELECT * FROM reachable;
```

**DFS uses `UNION ALL`** and relies on the path-based cycle detection.

#### UNION vs. UNION ALL

- **`UNION`**: Deduplicates rows, preventing cycles automatically. Slightly slower due to deduplication overhead but safer for general graph traversal.
- **`UNION ALL`**: Faster but can visit the same node multiple times via different paths. Requires explicit cycle detection via the `path` column. Essential when you need to enumerate *all paths* rather than *all reachable nodes*.

### Bidirectional Traversal

For undirected graphs or when you want to traverse in both directions:

```sql
WITH RECURSIVE neighborhood(id, depth, path) AS (
  SELECT id, 0, id
  FROM entities
  WHERE id = :start_id

  UNION

  SELECT e.id, n.depth + 1, n.path || ',' || e.id
  FROM neighborhood n
  JOIN relationships rel
    ON rel.source_entity_id = n.id OR rel.target_entity_id = n.id
  JOIN entities e
    ON e.id = CASE
      WHEN rel.source_entity_id = n.id THEN rel.target_entity_id
      ELSE rel.source_entity_id
    END
  WHERE n.depth < :max_depth
    AND n.path NOT LIKE '%' || e.id || '%'
)
SELECT * FROM neighborhood;
```

### Multi-Hop Queries for Engram

Typical engram queries and their traversal patterns:

**"What tools does project X use?"** (1-hop)
```sql
SELECT e.name, e.type, r.type as rel_type
FROM relationships r
JOIN entities e ON e.id = r.target_entity_id
WHERE r.source_entity_id = :project_entity_id
  AND r.type = 'uses';
```

**"What is related to technology Y within 2 hops?"** (2-hop BFS)
```sql
WITH RECURSIVE related(id, depth, path) AS (
  SELECT id, 0, id FROM entities WHERE id = :tech_id
  UNION
  SELECT e.id, r.depth + 1, r.path || ',' || e.id
  FROM related r
  JOIN relationships rel
    ON rel.source_entity_id = r.id OR rel.target_entity_id = r.id
  JOIN entities e
    ON e.id = CASE
      WHEN rel.source_entity_id = r.id THEN rel.target_entity_id
      ELSE rel.source_entity_id
    END
  WHERE r.depth < 2 AND r.path NOT LIKE '%' || e.id || '%'
)
SELECT DISTINCT e.*, related.depth
FROM related
JOIN entities e ON e.id = related.id
WHERE related.id != :tech_id
ORDER BY related.depth, e.mention_count DESC;
```

### Performance Optimization

1. **Index both edge columns**: `CREATE INDEX idx_rel_source ON relationships(source_entity_id)` and `idx_rel_target ON relationships(target_entity_id)` — both are essential for bidirectional traversal.

2. **Depth limits**: Always set a `max_depth` (typically 2-3 for engram's use case). Without limits, CTEs on graphs with cycles can run indefinitely.

3. **Cycle detection cost**: The `path LIKE '%' || id || '%'` pattern works but is O(path_length) per check. For small graphs (<10K nodes), this is fine. For larger graphs, consider a virtual table extension that maintains a visited set.

4. **ANALYZE after bulk operations**: Run `ANALYZE` after dream processing to update SQLite's statistics, enabling the query planner to choose optimal indexes.

5. **Pre-computation**: For frequently accessed patterns (e.g., "all tools used by project X"), consider materializing results in a cache table that gets refreshed during dream processing.

**Sources:**
- [SQLite WITH Clause (Official Documentation)](https://sqlite.org/lang_with.html)
- [SQLite Recursive Queries for Graph Traversal: A Deep Dive](https://runebook.dev/en/articles/sqlite/lang_with/rcex3)
- [SQLite Forum: Breadth-first Graph Traversal](https://sqlite.org/forum/info/3b309a9765636b79)
- [SQLite Forum: Optimizing Recursive CTE Performance](https://sqlite.org/forum/info/016a25083a9f8eb5c6532ed5a961eb7c2362f667cbca305f65dccb2e82170df7)
- [Graph Algorithms in a Database: Recursive CTEs (Fusionbox)](https://www.fusionbox.com/blog/detail/graph-algorithms-in-a-database-recursive-ctes-and-topological-sort-with-postgres/620/)

---

## 4. Community Detection Algorithms

Community detection identifies clusters of densely connected entities. For engram, this powers the `topic_clusters` table — grouping related entities into meaningful clusters with summaries.

### Algorithm Comparison

| Algorithm | Complexity | Quality | Deterministic | Dependencies | Best For |
|-----------|-----------|---------|---------------|-------------|----------|
| **Louvain** | O(n log n) | Good | No (random order) | graphology-communities-louvain | General community detection |
| **Leiden** | O(n log n) | Better (guaranteed connected) | No | No JS implementation | Quality-critical applications |
| **Label Propagation** | O(n + m) | Lower | No | None needed (trivial to implement) | Speed-critical, large graphs |

### Louvain via Graphology (Recommended for Engram)

The `graphology-communities-louvain` package provides a well-tested, TypeScript-compatible implementation:

```bash
npm install graphology graphology-communities-louvain
```

```typescript
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

// Build graph from engram's entities and relationships
const graph = new Graph();

// Add all entities as nodes
for (const entity of entities) {
  graph.addNode(entity.id, { name: entity.name, type: entity.type });
}

// Add all relationships as edges
for (const rel of relationships) {
  graph.addEdge(rel.source_entity_id, rel.target_entity_id, {
    weight: rel.weight,
    type: rel.type
  });
}

// Run Louvain community detection
const details = louvain.detailed(graph, {
  resolution: 1.0,        // Higher = more communities
  getEdgeWeight: 'weight', // Use relationship weight
});

// details.communities: { [nodeId]: communityIndex }
// details.count: number of communities
// details.modularity: quality metric (0-1, higher is better)
// details.dendrogram: hierarchical partition sequence
```

**Configuration options:**
- `resolution` (default: 1.0) — Higher values produce more, smaller communities. For engram's scale (100s-1000s of entities), values between 0.8 and 1.2 are typical.
- `getEdgeWeight` — Point to the `weight` attribute on edges to make frequently co-occurring entities cluster together.
- `randomWalk` (default: true) — Randomized traversal improves quality but makes results non-deterministic. Use `rng` with a seed for reproducibility.
- `fastLocalMoves` (default: true) — Queue-based optimization, keep enabled.

**Output:** Returns a mapping of `nodeId -> communityIndex` (integers starting from 0), plus the dendrogram for hierarchical analysis.

### Label Propagation (Alternative — Zero Dependencies)

Label Propagation is simpler and can be implemented directly without any graph library:

```typescript
function labelPropagation(
  entities: Entity[],
  relationships: Relationship[],
  maxIterations: number = 50
): Map<string, number> {
  // Initialize: each node gets its own label
  const labels = new Map<string, number>();
  entities.forEach((e, i) => labels.set(e.id, i));

  // Build adjacency list with weights
  const adjacency = new Map<string, Array<{neighbor: string, weight: number}>>();
  for (const rel of relationships) {
    if (!adjacency.has(rel.source_entity_id))
      adjacency.set(rel.source_entity_id, []);
    if (!adjacency.has(rel.target_entity_id))
      adjacency.set(rel.target_entity_id, []);
    adjacency.get(rel.source_entity_id)!.push({
      neighbor: rel.target_entity_id, weight: rel.weight
    });
    adjacency.get(rel.target_entity_id)!.push({
      neighbor: rel.source_entity_id, weight: rel.weight
    });
  }

  // Iterate until convergence
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    // Shuffle entity order for non-determinism
    const shuffled = [...entities].sort(() => Math.random() - 0.5);

    for (const entity of shuffled) {
      const neighbors = adjacency.get(entity.id) || [];
      if (neighbors.length === 0) continue;

      // Count weighted votes for each label
      const votes = new Map<number, number>();
      for (const {neighbor, weight} of neighbors) {
        const label = labels.get(neighbor)!;
        votes.set(label, (votes.get(label) || 0) + weight);
      }

      // Adopt the label with the highest weighted vote
      let bestLabel = labels.get(entity.id)!;
      let bestWeight = 0;
      for (const [label, weight] of votes) {
        if (weight > bestWeight) {
          bestWeight = weight;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels.get(entity.id)) {
        labels.set(entity.id, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return labels;
}
```

**Pros:** Zero dependencies, linear time O(n + m), trivial to implement.
**Cons:** Lower quality results, non-deterministic, doesn't optimize modularity, can produce unstable partitions.

### Leiden vs. Louvain

The Leiden algorithm (used by Microsoft GraphRAG) improves on Louvain by:
- Guaranteeing all communities are connected (Louvain can produce disconnected communities — up to 25% in some cases)
- Adding a refinement phase where communities may be split
- Running 20x faster on very large networks (39M+ nodes)

However, there is **no production-ready JavaScript/TypeScript implementation of Leiden**. For engram's scale (100s to low 10,000s of entities), Louvain via graphology is sufficient. The disconnected-community issue can be addressed with a post-processing step that splits disconnected components.

### Recommendation for Engram

1. **Primary:** Use `graphology-communities-louvain` for community detection during dream processing
2. **Incremental updates:** Between full re-runs, use Graphiti's approach — when a new entity is added, survey the communities of its neighbors and assign it to the plurality community
3. **Post-processing:** After Louvain, verify community connectivity and split any disconnected communities
4. **Hierarchy:** The `detailed()` output includes a dendrogram for hierarchical clustering, which can be used to generate summaries at different granularity levels (matching GraphRAG's approach)

**Sources:**
- [graphology-communities-louvain (NPM)](https://www.npmjs.com/package/graphology-communities-louvain)
- [Graphology: communities-louvain API](https://graphology.github.io/standard-library/communities-louvain.html)
- [Graphology: JavaScript/TypeScript Graph Library](https://github.com/graphology/graphology)
- [jLouvain: Original JS Implementation](https://github.com/upphiminn/jLouvain)
- [From Louvain to Leiden (Nature Scientific Reports)](https://www.nature.com/articles/s41598-019-41695-z)
- [Leiden Algorithm (Wikipedia)](https://en.wikipedia.org/wiki/Leiden_algorithm)
- [Label Propagation Algorithm (Wikipedia)](https://en.wikipedia.org/wiki/Label_propagation_algorithm)
- [Louvain Method Explained (Medium)](https://medium.com/data-science-in-your-pocket/community-detection-in-a-graph-using-louvain-algorithm-with-example-7a77e5e4b079)

---

## 5. Graphiti/Zep Entity Extraction Pipeline

### Architecture Overview

Graphiti (the open-source framework powering Zep) implements the most sophisticated incremental knowledge graph system in the current landscape. Its key innovation is real-time graph updates without batch recomputation.

### Data Model

The knowledge graph G = (N, E, phi) comprises three hierarchical subgraphs:

1. **Episode Subgraph**: Raw message/text/JSON data stored non-lossily. Episodes are discrete data events (messages, documents, JSON payloads).

2. **Semantic Entity Subgraph**: Extracted entities with bidirectional relationships to episodes. Entities have embeddings (1024-dim) for similarity search.

3. **Community Subgraph**: Higher-level entity clusters with LLM-generated summaries.

### Entity Extraction Process

1. **Context window**: The system processes the current message + the last n messages (n=4, providing 2 complete conversation turns) for entity extraction context.

2. **Speaker extraction**: The speaker is automatically extracted as the first entity.

3. **Named entity recognition**: LLM identifies significant entities, concepts, and actors. Relationships and temporal information are explicitly excluded at this stage.

4. **Reflection technique**: Inspired by the Reflexion framework, a second pass minimizes hallucinations and enhances extraction coverage.

5. **Summary generation**: Entity summaries are generated for subsequent resolution and retrieval.

### Entity Resolution Mechanism

Graphiti uses a three-stage hybrid matching approach:

**Stage 1 — Embedding Search:**
- Each entity name is embedded into a 1024-dimensional vector space
- Cosine similarity search retrieves candidate matching nodes
- (Specific threshold not disclosed in the paper)

**Stage 2 — Full-Text Fallback:**
- Separate full-text search across existing entity names and summaries
- Catches cases where embeddings might miss lexical similarities

**Stage 3 — LLM Deduplication:**
- Candidate nodes from both stages are combined with episode context
- LLM evaluates using specialized prompts whether candidates refer to the same entity
- When duplicates are confirmed, the system generates an updated name and summary

### Edge/Fact Extraction

After entity resolution:
1. Facts are extracted as edges between resolved entities
2. Each edge carries four timestamps (bi-temporal model):
   - `t'_created`, `t'_expired` (transactional — when the system learned it)
   - `t_valid`, `t_invalid` (event-based — when it was actually true)
3. Contradictory facts trigger edge invalidation rather than deletion

### Community Detection

Graphiti uses **label propagation** (not Leiden) for community detection:
- When new entities are added, the system surveys communities of neighboring nodes
- New nodes are assigned to the community held by the plurality of neighbors
- Periodic complete refreshes correct drift from dynamic updates

### Key Takeaways for Engram

1. **Episode-first design**: Store raw data non-lossily, derive entities from it
2. **Hybrid resolution**: Combine cheap methods (embedding, full-text) with expensive (LLM) only when needed
3. **Bi-temporal model**: Track both "when we learned it" and "when it was true" for conflict resolution
4. **Incremental communities**: Don't re-run full community detection on every change; use neighbor-based assignment with periodic refresh
5. **Label propagation for communities**: Simpler than Louvain, sufficient when combined with periodic full recalculation

**Sources:**
- [Graphiti GitHub Repository](https://github.com/getzep/graphiti)
- [Zep: A Temporal Knowledge Graph Architecture (arXiv)](https://arxiv.org/html/2501.13956v1)
- [Zep Technical Paper (PDF)](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf)
- [Graphiti Overview (Neo4j Blog)](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [Building AI Agents with Knowledge Graph Memory (Medium)](https://medium.com/@saeedhajebi/building-ai-agents-with-knowledge-graph-memory-a-comprehensive-guide-to-graphiti-3b77e6084dec)
- [Graphiti Documentation: Overview](https://help.getzep.com/graphiti/getting-started/overview)
- [Graphiti: Custom Entity and Edge Types](https://help.getzep.com/graphiti/core-concepts/custom-entity-and-edge-types)

---

## 6. Microsoft GraphRAG

### Architecture Overview

GraphRAG is a batch-oriented system for constructing knowledge graphs from document corpora. Unlike Graphiti (incremental/real-time), GraphRAG processes entire document collections at once to produce a hierarchical graph with community summaries.

### Indexing Pipeline (6 Phases)

**Phase 1 — Compose TextUnits:**
- Documents are chunked into analyzable units (default: 1200 tokens)
- Larger chunks reduce processing time but lower extraction fidelity

**Phase 2 — Document Processing:**
- Link documents to their constituent TextUnits for provenance

**Phase 3 — Graph Extraction:**
- LLM identifies entities (people, places, events) with titles, types, and descriptions
- LLM extracts relationships with source-target pairs and descriptions
- Duplicate entities and relationships are merged by title
- Each entity/relationship gets a list of descriptions, which are then summarized by the LLM into a single description

**Phase 4 — Graph Augmentation (Community Detection):**
- **Hierarchical Leiden Algorithm** applied recursively
- Recursion continues until reaching a community-size threshold
- Creates hierarchical clustering at multiple granularity levels
- Each node belongs to exactly one community (hard partition)

**Phase 5 — Community Summarization:**
- LLM generates summary reports for each community at different hierarchy levels
- Reports contain: executive overview, key entities, relationships, and claims
- Provides both high-level and low-level perspectives

**Phase 6 — Text Embedding:**
- Embeddings generated for TextUnits, entity descriptions, and community reports
- Enables vector-based downstream retrieval

### Entity Extraction Approach

GraphRAG's extraction uses a simple but effective pattern:
- Each text chunk is processed independently by the LLM
- Entities are extracted as (title, type, description) tuples
- Relationships are extracted as (source, target, description) tuples
- When the same entity appears in multiple chunks, descriptions are merged into a list and then LLM-summarized into a single description

**Key difference from Graphiti:** GraphRAG does entity deduplication primarily by title matching, not by embedding similarity. This is simpler but less robust for entity variations.

### Hierarchical Community Structure

The Leiden algorithm produces a tree of communities:
- **Level 0 (leaf)**: Individual entities or very small groups
- **Level 1**: Small topic clusters (5-20 entities)
- **Level 2+**: Progressively larger thematic groupings
- **Root**: The entire graph as one community

Each level gets its own set of LLM-generated summaries, creating a "map of content" that can answer questions at different scales.

### Variants and Optimizations

- **FastGraphRAG**: Uses NLP instead of LLMs for entity extraction to reduce cost
- **LightRAG**: Optimizes the indexing pipeline for speed
- **LazyGraphRAG**: Defers expensive graph construction until query time, dramatically reducing upfront cost

### Key Takeaways for Engram

1. **Hierarchical summaries**: The community summary hierarchy is powerful for "what do I know about X?" queries
2. **Description merging**: When the same entity appears in multiple contexts, merging descriptions provides richer entity profiles
3. **Batch vs. incremental**: GraphRAG's batch approach is too expensive for engram's real-time use case, but the community hierarchy concept is valuable
4. **Leiden > Louvain**: Microsoft chose Leiden for quality guarantees, but Louvain is adequate for engram's scale
5. **Multi-level community summaries** can be adopted for engram's `topic_clusters` table

**Sources:**
- [GraphRAG Default Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/)
- [Project GraphRAG (Microsoft Research)](https://www.microsoft.com/en-us/research/project/graphrag/)
- [GraphRAG: New Tool for Complex Data Discovery (Microsoft Research Blog)](https://www.microsoft.com/en-us/research/blog/graphrag-new-tool-for-complex-data-discovery-now-on-github/)
- [Understanding Hierarchical Levels in Leiden (GraphRAG Discussion)](https://github.com/microsoft/graphrag/discussions/1128)
- [GraphRAG Community Detection Parameters (Discussion)](https://github.com/microsoft/graphrag/discussions/683)
- [Implementing GraphRAG with Neo4j and LangChain](https://neo4j.com/blog/developer/global-graphrag-neo4j-langchain/)
- [GraphRAG: The Complete Guide (Medium, Feb 2026)](https://medium.com/@brian-curry-research/graphrag-the-complete-guide-to-graph-powered-retrieval-augmented-generation-eeb58a6bb4d1)

---

## 7. sqlite-vec for Entity Embeddings

### Current Engram Setup

Engram already uses sqlite-vec with a `vec_entities` virtual table:

```typescript
createVecIfNeeded(db, "vec_entities", dims);
// Creates: CREATE VIRTUAL TABLE vec_entities USING vec0(
//   id TEXT PRIMARY KEY, embedding float[{dims}]
// )
```

### Enhanced Schema for Entity Resolution

To better support entity resolution, the vec_entities table should leverage metadata columns and partition keys:

```sql
CREATE VIRTUAL TABLE vec_entities USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[384],                    -- entity name/description embedding
  entity_type TEXT,                        -- metadata: filter by type during KNN
  +name TEXT,                              -- auxiliary: avoid JOIN for name lookup
  +description TEXT                        -- auxiliary: avoid JOIN for description
);
```

**Why metadata columns matter:** During entity resolution, you typically want to find similar entities *of the same type*. A metadata `entity_type` column lets sqlite-vec pre-filter before computing distances:

```sql
SELECT id, name, distance
FROM vec_entities
WHERE embedding MATCH :query_embedding
  AND k = 10
  AND entity_type = 'technology'
ORDER BY distance;
```

This is faster than retrieving all 10 nearest neighbors and post-filtering by type.

### Distance Metric Selection

sqlite-vec supports three distance functions:

| Function | Usage | Best For |
|----------|-------|----------|
| `vec_distance_L2()` | Default for vec0 MATCH | General similarity |
| `vec_distance_cosine()` | Scalar function or `distance_metric=cosine` | Normalized embeddings (most embedding models) |
| `vec_distance_L1()` | Scalar function | Sparse vectors |

For entity resolution with typical embedding models (sentence-transformers, OpenAI, etc.), **cosine distance is preferred** because these models produce normalized vectors:

```sql
CREATE VIRTUAL TABLE vec_entities USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[384] distance_metric=cosine,
  entity_type TEXT
);
```

### KNN Query Patterns for Entity Resolution

**Find candidate matches for a new entity:**
```sql
-- Using vec0 virtual table (fast, indexed)
WITH candidates AS (
  SELECT id, distance
  FROM vec_entities
  WHERE embedding MATCH :new_entity_embedding
    AND k = 5
)
SELECT e.id, e.name, e.type, e.aliases, e.description, c.distance
FROM candidates c
JOIN entities e ON e.id = c.id
WHERE c.distance < 0.15;  -- cosine distance threshold
```

**Manual KNN with scalar functions (more flexible):**
```sql
SELECT e.id, e.name, e.type,
  vec_distance_cosine(v.embedding, :query) as distance
FROM vec_entities v
JOIN entities e ON e.id = v.id
WHERE e.type = :entity_type  -- pre-filter by type
ORDER BY distance
LIMIT 10;
```

### Combining Vector Search with FTS5

For entity resolution, combining embedding similarity with full-text search improves recall:

```sql
-- Hybrid search: vector similarity + FTS5
WITH vec_candidates AS (
  SELECT id, distance as vec_score
  FROM vec_entities
  WHERE embedding MATCH :query_embedding AND k = 10
),
fts_candidates AS (
  SELECT rowid as id, rank as fts_score
  FROM entities_fts  -- would need an FTS table for entity names
  WHERE entities_fts MATCH :entity_name
),
merged AS (
  SELECT
    COALESCE(v.id, f.id) as id,
    v.vec_score,
    f.fts_score
  FROM vec_candidates v
  FULL OUTER JOIN fts_candidates f ON v.id = f.id
)
SELECT e.*, m.vec_score, m.fts_score
FROM merged m
JOIN entities e ON e.id = m.id
ORDER BY COALESCE(m.vec_score, 1.0) + COALESCE(m.fts_score, 0) ASC;
```

**Note:** SQLite does not support `FULL OUTER JOIN`. Use `UNION` of two LEFT JOINs instead:

```sql
WITH vec_candidates AS (...), fts_candidates AS (...),
merged AS (
  SELECT v.id, v.vec_score, f.fts_score
  FROM vec_candidates v LEFT JOIN fts_candidates f ON v.id = f.id
  UNION
  SELECT f.id, v.vec_score, f.fts_score
  FROM fts_candidates f LEFT JOIN vec_candidates v ON f.id = v.id
)
...
```

### Performance Considerations

1. **No ANN index yet**: sqlite-vec currently performs exact KNN (brute-force scan). This is fine for engram's expected scale (<10K entities) but would be a bottleneck at 100K+.

2. **Partition keys help**: If you partition by `entity_type`, each partition is scanned independently, reducing the effective search space.

3. **Metadata filtering is pre-filter**: Metadata columns with `WHERE` clauses are applied before distance computation, saving CPU.

4. **Auxiliary columns avoid JOINs**: The `+name TEXT` syntax stores the name directly in the vec0 table, eliminating the need for a JOIN back to the `entities` table for simple lookups.

5. **Vector format**: Vectors can be provided as JSON arrays (`'[0.1, 0.2, ...]'`) or compact binary BLOBs. Binary is faster for bulk operations.

**Sources:**
- [sqlite-vec GitHub Repository](https://github.com/asg017/sqlite-vec)
- [sqlite-vec Documentation](https://alexgarcia.xyz/sqlite-vec/)
- [sqlite-vec KNN Queries](https://alexgarcia.xyz/sqlite-vec/features/knn.html)
- [sqlite-vec Metadata Columns and Filtering](https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html)
- [How sqlite-vec Works (Medium)](https://medium.com/@stephenc211/how-sqlite-vec-works-for-storing-and-querying-vector-embeddings-165adeeeceea)
- [How to Use sqlite-vec (DEV Community)](https://dev.to/stephenc222/how-to-use-sqlite-vec-to-store-and-query-vector-embeddings-58mf)
- [Embedded Intelligence: sqlite-vec (DEV Community)](https://dev.to/aairom/embedded-intelligence-how-sqlite-vec-delivers-fast-local-vector-search-for-ai-3dpb)
- [sqlite-vec Community Fork with Distance Constraints](https://github.com/vlasky/sqlite-vec)

---

## 8. Synthesis: Recommendations for Engram

### Architecture Summary

Based on the research, here is the recommended architecture for engram's Phase 4 knowledge graph:

```
Conversation Episodes
       |
       v
  [Entity Extraction]  <-- LLM with structured output
       |
       v
  [Entity Resolution]  <-- 4-stage cascading pipeline
       |                    1. Exact name match
       v                    2. Alias match
  [Edge Extraction]         3. Embedding similarity (sqlite-vec)
       |                    4. LLM verification (optional)
       v
  [Graph Storage]       <-- SQLite edge table (existing schema)
       |
       v
  [Community Detection] <-- Louvain via graphology (dream phase)
       |
       v
  [Community Summaries] <-- LLM-generated (dream phase)
```

### Schema Enhancements

1. **Add composite indexes** for bidirectional edge traversal
2. **Add unique constraint** on `(source_entity_id, target_entity_id, type)` to prevent duplicate edges
3. **Enhance `vec_entities`** with metadata columns for type-filtered KNN
4. **Add `entities_fts`** for full-text search on entity names/descriptions/aliases
5. **Add `community_id` column** to `entities` table for direct community membership lookup
6. **Consider adding temporal fields** to relationships: `valid_from`, `valid_until` (inspired by Graphiti's bi-temporal model)

### Entity Extraction Approach

Follow the two-call pattern from KGGen (2025):
1. **First LLM call**: Extract entities with `{name, type, description}` using structured output
2. **Second LLM call**: Extract relationships as `{source, target, type, description}` given the entity list

This decomposition reduces cognitive load on the LLM and improves extraction quality compared to single-pass extraction.

### Entity Resolution Pipeline

Implement the 4-stage cascading pipeline described in Section 2. Key thresholds:
- **Auto-merge**: cosine similarity > 0.95 (distance < 0.05)
- **Likely match**: cosine similarity 0.85-0.95 (distance 0.05-0.15) — merge with flag
- **Review zone**: cosine similarity 0.70-0.85 (distance 0.15-0.30) — LLM verification
- **Distinct**: cosine similarity < 0.70 (distance > 0.30) — create new entity

### Community Detection Strategy

- **During dream processing**: Run Louvain via graphology on the full graph
- **Between dream runs**: Use label-propagation-style incremental assignment (assign new entities to the community of their most-connected neighbor)
- **Post-processing**: Verify community connectivity, split disconnected communities
- **Summaries**: Generate LLM summaries for each community, store in `topic_clusters`

### Graph Traversal Queries

- Use recursive CTEs with BFS (UNION) for "related to" queries
- Always set depth limit (max 3 hops for general queries, 2 for performance-sensitive paths)
- Index both directions of the relationships table
- For frequently accessed patterns, consider materialized views refreshed during dream processing

### Dependencies to Add

```json
{
  "graphology": "^0.25.0",
  "graphology-communities-louvain": "^2.0.0"
}
```

These are the only new dependencies needed. All other capabilities (graph storage, vector search, FTS) are already available through SQLite, sqlite-vec, and FTS5.
