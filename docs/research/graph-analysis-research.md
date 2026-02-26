# Graph Analysis Research for Engram Phase 4

**Date:** 2026-02-26
**Scope:** Community detection, bridge identification, temporal patterns, topic clustering
**Target stack:** TypeScript, Node.js (>=22), SQLite (better-sqlite3), ESM

---

## 1. Graph Algorithm Libraries for TypeScript/JS

### Recommendation: graphology

**graphology** is the clear winner for engram's server-side graph analysis needs.

| Criteria | graphology | ngraph | cytoscape.js |
|---|---|---|---|
| Weekly npm downloads | ~571K | ~52K | ~250K (viz-focused) |
| GitHub stars | 1,600+ | ~560 | ~10K (viz-focused) |
| TypeScript support | Native (ships types) | Minimal | Yes (viz API) |
| Visualization deps | None in core | None in core | Core IS visualization |
| Community detection | Built-in Louvain | Separate pkg (stale) | Plugin-based |
| Centrality metrics | Full suite built-in | Separate pkg | Limited |
| Shortest path | Dijkstra, A*, BFS | Separate pkgs | Yes |
| Traversal (BFS/DFS) | Built-in | Separate pkg | Built-in |
| Last release | Feb 2025 (v0.26.0) | 6+ years ago (Louvain) | Active but viz-centric |
| Monorepo/tree-shake | Yes, individual packages | Separate repos | Monolith |

**Key advantages for engram:**

1. **No visualization baggage.** The core `graphology` package is a pure data structure. Algorithm packages (`graphology-communities-louvain`, `graphology-metrics`, `graphology-traversal`, etc.) are separate npm packages with no DOM/canvas/WebGL dependencies. Ideal for server-side Node.js usage.

2. **Comprehensive algorithm standard library.** 22 packages covering everything we need:
   - `graphology-communities-louvain` -- Louvain community detection
   - `graphology-metrics` -- betweenness centrality, closeness, pagerank, eigenvector, HITS, edge betweenness, modularity, density
   - `graphology-traversal` -- BFS, DFS with depth tracking
   - `graphology-shortest-path` -- Dijkstra, A*, unweighted bidirectional
   - `graphology-simple-path` -- all simple paths between two nodes
   - `graphology-components` -- connected/strongly-connected components
   - `graphology-operators` -- union, intersection, reverse, conversion
   - `graphology-indices` -- specialized indexes (neighborhood index, Louvain index)
   - `graphology-cores` -- k-core decomposition
   - `graphology-dag` -- cycle detection, topological sort

3. **TypeScript out of the box.** Ships type declarations via peer dependencies. Full intellisense for the graph API and all standard library functions.

4. **Active maintenance.** 1,370 commits, 32+ contributors, last release early 2025.

**Installation approach for engram:**

```bash
# Core graph data structure
npm install graphology

# Only the algorithm packages we need (no viz packages)
npm install graphology-communities-louvain
npm install graphology-metrics
npm install graphology-traversal
npm install graphology-shortest-path
npm install graphology-components
```

This installs zero visualization dependencies. Each package is typically <50KB.

**Alternative considered: ngraph**

The ngraph ecosystem (`ngraph.graph`, `ngraph.louvain`, `ngraph.centrality`) is lighter-weight but significantly less maintained. `ngraph.louvain` was last published 6+ years ago. The performance gap is small (graphology Louvain: 52ms vs ngraph: 71ms on 1000-node undirected graph), and graphology's richer API and active maintenance make it the better investment.

### Sources
- [Graphology homepage](https://graphology.github.io/)
- [Graphology GitHub](https://github.com/graphology/graphology)
- [Graphology standard library](https://graphology.github.io/standard-library/)
- [graphology npm](https://www.npmjs.com/package/graphology)
- [npm trends: graphology vs ngraph](https://npmtrends.com/graph.js-vs-graphology-vs-ngraph.graph)
- [ngraph.louvain npm](https://www.npmjs.com/package/ngraph.louvain)

---

## 2. Louvain Community Detection

### Algorithm Overview

The Louvain method (Blondel et al., 2008) is a greedy hierarchical algorithm for community detection that maximizes modularity:

1. **Local move phase:** Each node is moved to the neighboring community that maximizes the modularity gain. Repeated until no single move improves modularity.
2. **Aggregation phase:** Communities are collapsed into super-nodes, creating a coarsened graph. Edge weights between super-nodes are summed.
3. **Repeat** steps 1-2 on the coarsened graph until no further improvement.

**Complexity:** O(n log n) in practice for sparse graphs, though worst case is O(n * m) where m is the number of edges. For engram's expected scale (100-10,000 nodes), this will be instantaneous (sub-100ms).

### graphology Implementation

```typescript
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

// Load graph from SQLite entities/relationships
const graph = new Graph({ type: 'undirected' });
// ... add nodes and edges ...

// Basic usage: returns { nodeId: communityId }
const communities = louvain(graph);

// Assign directly as node attributes
louvain.assign(graph);

// Detailed output with metrics
const details = louvain.detailed(graph);
// details.communities    -- partition mapping
// details.count          -- number of communities found
// details.modularity     -- quality metric (-0.5 to 1.0)
// details.dendrogram     -- hierarchical partition history
// details.moves          -- node moves per iteration
// details.nodesVisited   -- total visits
```

**Key options:**

| Option | Default | Purpose |
|---|---|---|
| `resolution` | 1 | Higher = more communities, lower = fewer larger ones |
| `getEdgeWeight` | `'weight'` | Edge weight attribute name or function. `null` to ignore weights |
| `fastLocalMoves` | `true` | Queue-based optimization |
| `randomWalk` | `true` | Random traversal order |
| `rng` | `Math.random` | Custom RNG for reproducibility |

**Resolution parameter tuning for engram:**
- `resolution: 0.5` -- broader communities, grouping whole technology stacks together
- `resolution: 1.0` (default) -- standard modularity-optimized communities
- `resolution: 2.0` -- finer-grained communities, splitting sub-topics apart

Recommendation: start with `resolution: 1.0`, expose as a configurable parameter. Use `louvain.detailed()` to get the modularity score and evaluate quality.

### Leiden vs. Louvain

The Leiden algorithm (Traag et al., 2019) improves on Louvain by:
1. Guaranteeing well-connected communities (Louvain can produce disconnected communities)
2. Faster convergence via refined local moves (only visits nodes whose neighborhoods changed)
3. Better partition quality

**However:** There is no maintained JavaScript/TypeScript implementation of Leiden. The reference implementation is in Python (`leidenalg`). Microsoft's GraphRAG uses Leiden (via Python) for its community detection.

**Recommendation for engram:** Use Louvain via graphology. For our graph sizes (100-10K nodes), the Louvain pathologies (disconnected communities) are rare and can be detected post-hoc by checking component connectivity within each community. If quality becomes an issue, we could implement a simplified Leiden-like refinement step or call out to a Python subprocess, but this is premature optimization.

### Label Propagation Alternative

Label Propagation is simpler and faster than Louvain:
1. Each node starts with a unique label
2. Each iteration: every node adopts the most frequent label among its neighbors
3. Converges when no node changes label

**Pros:** O(m) per iteration, very fast, no modularity optimization overhead.
**Cons:** Non-deterministic, may require multiple runs for stable results, can produce trivially large communities.

graphology does not ship a label propagation implementation, but it is straightforward to implement from scratch (~50 lines). Could serve as a fast "quick clustering" mode.

### Sources
- [graphology communities-louvain docs](https://graphology.github.io/standard-library/communities-louvain.html)
- [Louvain method - Wikipedia](https://en.wikipedia.org/wiki/Louvain_method)
- [Leiden algorithm paper](https://arxiv.org/abs/1810.08473)
- [From Louvain to Leiden (Nature)](https://www.nature.com/articles/s41598-019-41695-z)
- [haljin/js-louvain](https://github.com/haljin/js-louvain)
- [jLouvain](https://github.com/upphiminn/jLouvain)
- [Community detection algorithms compared](https://hypermode.com/blog/community-detection-algorithms)

---

## 3. Bridge Detection / Betweenness Centrality

### Betweenness Centrality

Betweenness centrality measures how often a node lies on the shortest path between other node pairs. High betweenness = bridge entity connecting otherwise-separate communities.

**Formula:** BC(v) = sum over all pairs (s,t) of: (number of shortest paths through v) / (total shortest paths from s to t)

**Complexity:** Brandes' algorithm runs in O(n * m) time, O(n + m) space. For 10K nodes and 50K edges, this is ~500M operations -- still fast in JavaScript (< 1 second).

### graphology Implementation

```typescript
import betweennessCentrality from 'graphology-metrics/centrality/betweenness';
import edgeBetweennessCentrality from 'graphology-metrics/centrality/edge-betweenness';

// Node betweenness: returns { nodeId: score }
const nodeCentrality = betweennessCentrality(graph);

// Assign directly to node attributes
betweennessCentrality.assign(graph);

// With custom weight handling
betweennessCentrality.assign(graph, {
  getEdgeWeight: (_, attr) => attr.weight,
  nodeCentralityAttribute: 'bridgeScore'
});

// Edge betweenness: identifies bridge edges
const edgeCentrality = edgeBetweennessCentrality(graph);
edgeBetweennessCentrality.assign(graph, {
  edgeCentralityAttribute: 'edgeBridge'
});
```

### Additional Centrality Metrics Available

All from `graphology-metrics`:

| Metric | Import path | Use for engram |
|---|---|---|
| Betweenness | `centrality/betweenness` | Bridge entity detection |
| Edge betweenness | `centrality/edge-betweenness` | Bridge relationship detection |
| Closeness | `centrality/closeness` | Find "central" entities |
| Degree centrality | `centrality/degree` | Find most-connected entities |
| Eigenvector | `centrality/eigenvector` | Important entities (recursive importance) |
| PageRank | `centrality/pagerank` | Authoritative entities |
| HITS | `centrality/hits` | Hub vs authority distinction |

### Bridge Detection Strategy for Engram

Recommended multi-metric approach:

1. **Run Louvain** to detect communities
2. **Run betweenness centrality** on nodes
3. **Identify bridges:** nodes with high betweenness AND whose neighbors span multiple communities
4. **Score:** `bridgeScore = betweenness * communitySpan` where `communitySpan` = number of distinct communities in the node's 1-hop neighborhood

This is more robust than Girvan-Newman (which is O(m^2 * n) -- too expensive for our scale) and directly answers "which entities connect disparate topic areas?"

### Sources
- [graphology-metrics docs](https://graphology.github.io/standard-library/metrics.html)
- [graphology-metrics npm](https://www.npmjs.com/package/graphology-metrics)
- [Betweenness centrality - Wikipedia](https://en.wikipedia.org/wiki/Betweenness_centrality)
- [Neo4j betweenness centrality](https://neo4j.com/blog/graph-algorithms-neo4j-betweenness-centrality/)
- [ngraph.centrality](https://github.com/anvaka/ngraph.centrality)

---

## 4. Multi-Hop Traversal Patterns

### Approach: Hybrid SQLite + In-Memory

For engram, graph traversal should use a **load-into-memory** strategy rather than pure SQL recursive CTEs.

**Why not pure SQLite recursive CTEs:**

1. **Cycle prevention is expensive in SQL.** Requires `WHERE NOT path LIKE '%' || node_id || '%'` checks, which are O(path_length) string operations per row.
2. **Repeated node visits.** Without a visited set, the same node is expanded multiple times via different paths, leading to exponential blowup.
3. **No complex scoring.** We need to apply edge weights, decay, and relevance during traversal -- difficult in pure SQL.
4. **Performance ceiling.** SQLite forum users report significant slowdowns for graphs beyond a few hundred nodes with multi-hop CTEs.

**When SQLite CTEs ARE useful:**
- Simple 1-hop neighborhood queries (direct JOIN, no recursion needed)
- Depth-limited (2-hop) traversals on small, tree-like subgraphs
- Quick existence checks ("is there a path between A and B?")

### Recommended Architecture

```
SQLite (entities + relationships tables)
          |
          | Load on demand or at dream-time
          v
graphology Graph (in-memory)
          |
          | BFS/DFS, community detection, centrality
          v
Results written back to SQLite (topic_clusters, cached metrics)
```

**Loading the graph:**

```typescript
import Graph from 'graphology';
import type Database from 'better-sqlite3';

function loadGraph(db: Database.Database): Graph {
  const graph = new Graph({ type: 'undirected', multi: false });

  // Load all entities as nodes
  const entities = db.prepare('SELECT id, name, type, mention_count FROM entities').all();
  for (const e of entities) {
    graph.addNode(e.id, { name: e.name, type: e.type, mentions: e.mention_count });
  }

  // Load all relationships as edges
  const rels = db.prepare('SELECT id, source_entity_id, target_entity_id, type, weight FROM relationships').all();
  for (const r of rels) {
    if (graph.hasNode(r.source_entity_id) && graph.hasNode(r.target_entity_id)) {
      graph.addEdge(r.source_entity_id, r.target_entity_id, {
        id: r.id,
        type: r.type,
        weight: r.weight
      });
    }
  }

  return graph;
}
```

For a graph of 10K entities and 50K relationships, this loads in < 100ms and uses < 50MB of RAM. Well within engram's operating constraints.

### Traversal Implementations

**1-hop neighborhood (direct from SQLite, fast):**
```sql
SELECT e.* FROM entities e
JOIN relationships r ON (r.source_entity_id = ? AND r.target_entity_id = e.id)
   OR (r.target_entity_id = ? AND r.source_entity_id = e.id);
```

**Multi-hop with graphology (in-memory):**
```typescript
import { bfsFromNode } from 'graphology-traversal';

function getNeighborhood(graph: Graph, startNode: string, maxDepth: number) {
  const neighborhood: Array<{ id: string; depth: number }> = [];

  bfsFromNode(graph, startNode, (node, attrs, depth) => {
    if (depth > maxDepth) return true; // stop expanding
    neighborhood.push({ id: node, depth });
  });

  return neighborhood;
}
```

**Path finding between two entities:**
```typescript
import { bidirectional } from 'graphology-shortest-path';
import { dijkstra } from 'graphology-shortest-path';

// Unweighted shortest path
const path = bidirectional(graph, sourceId, targetId);

// Weighted shortest path
const weightedPath = dijkstra.bidirectional(graph, sourceId, targetId, 'weight');
```

### SQLite Recursive CTE Reference (for simple cases)

For cases where loading the full graph is overkill (e.g., quick 2-hop lookup):

```sql
WITH RECURSIVE neighbors(entity_id, depth) AS (
  -- Seed: the starting entity
  SELECT ?, 0

  UNION

  -- Expand: find connected entities up to depth 2
  SELECT
    CASE
      WHEN r.source_entity_id = n.entity_id THEN r.target_entity_id
      ELSE r.source_entity_id
    END,
    n.depth + 1
  FROM neighbors n
  JOIN relationships r ON r.source_entity_id = n.entity_id OR r.target_entity_id = n.entity_id
  WHERE n.depth < 2
)
SELECT DISTINCT e.* FROM entities e
JOIN neighbors n ON e.id = n.entity_id;
```

**Critical index:** Ensure both `idx_relationships_source` and `idx_relationships_target` exist (they do in engram's schema).

### Sources
- [SQLite WITH clause / recursive CTEs](https://sqlite.org/lang_with.html)
- [SQLite forum: BFS graph traversal](https://sqlite.org/forum/info/3b309a9765636b79)
- [graphology traversal docs](https://graphology.github.io/standard-library/traversal.html)
- [graphology shortest-path docs](https://graphology.github.io/standard-library/shortest-path.html)
- [SQLite recursive CTE deep dive](https://runebook.dev/en/articles/sqlite/lang_with/rcex3)

---

## 5. Topic Cluster / Map of Content Generation

### Architecture: Community Detection + LLM Summarization

Following the approach validated by Microsoft's GraphRAG system:

1. **Detect communities** using Louvain on the entity-relationship graph
2. **Extract community contents** -- entities, their descriptions, relationship types, connected memories
3. **LLM-summarize** each community into a topic name + description
4. **Score coherence** based on intra-community edge density vs. inter-community connections
5. **Store** as `TopicCluster` records in SQLite

### GraphRAG Approach (Reference)

Microsoft's GraphRAG uses this pipeline:
1. LLM extracts entities and relationships from text
2. Leiden algorithm partitions the knowledge graph hierarchically
3. For each community, element descriptions (nodes, edges) are prioritized by combined source+target node degree
4. An LLM generates "report-like summaries" for each community
5. Summaries include: topic name, key entities, relationship patterns, significance
6. Vector embeddings of summaries enable retrieval via similarity search

### Recommended Implementation for Engram

**Step 1: Community Detection**
```typescript
const details = louvain.detailed(graph, { resolution: 1.0 });
// details.communities: { [nodeId]: communityId }
// details.count: number of communities
// details.modularity: quality score
```

**Step 2: Extract Community Contents**
```typescript
interface CommunityContent {
  communityId: number;
  entities: Array<{ id: string; name: string; type: string; mentions: number }>;
  relationships: Array<{ source: string; target: string; type: string; weight: number }>;
  relatedMemories: string[]; // memory contents linked via source_memories
}
```

**Step 3: LLM Summarization Prompt**

```
Given the following cluster of entities and relationships from a knowledge graph,
generate a concise topic name (3-6 words) and a 1-2 sentence description.

Entities:
{{#each entities}}
- {{name}} ({{type}}): mentioned {{mentions}} times
{{/each}}

Relationships:
{{#each relationships}}
- {{source}} --[{{type}}]--> {{target}} (weight: {{weight}})
{{/each}}

Respond in JSON:
{
  "name": "short topic name",
  "description": "1-2 sentence description of what this cluster represents"
}
```

This maps directly to Claude Haiku calls during the dream-state `reflect` phase.

**Step 4: Coherence Scoring**

```typescript
function computeCoherence(graph: Graph, communityNodes: string[]): number {
  const nodeSet = new Set(communityNodes);
  let internalEdges = 0;
  let externalEdges = 0;

  for (const node of communityNodes) {
    graph.forEachEdge(node, (edge, attrs, source, target) => {
      if (nodeSet.has(source) && nodeSet.has(target)) {
        internalEdges++;
      } else {
        externalEdges++;
      }
    });
  }

  // Avoid double-counting undirected edges
  internalEdges /= 2;

  const total = internalEdges + externalEdges;
  return total > 0 ? internalEdges / total : 0;
}
```

### Hierarchical Topic Clusters

For larger graphs, use the Louvain dendrogram (returned by `louvain.detailed()`) to create hierarchical topic maps:

- **Level 0:** Fine-grained topics (e.g., "Fish Shell Configuration")
- **Level 1:** Mid-level topics (e.g., "Shell & Terminal Setup")
- **Level 2:** Broad themes (e.g., "Development Environment")

The `generation` field in engram's `TopicCluster` table can track this hierarchy level.

### Sources
- [GraphRAG paper (Microsoft)](https://arxiv.org/abs/2404.16130)
- [GraphRAG project page](https://www.microsoft.com/en-us/research/project/graphrag/)
- [Global community summary retriever](https://graphrag.com/reference/graphrag/global-community-summary-retriever/)
- [LLM-guided topic modeling (ACL 2025)](https://aclanthology.org/2025.acl-long.902.pdf)
- [Text cluster naming with LLMs](https://jds-online.org/journal/JDS/article/1385/file/pdf)

---

## 6. Incremental Graph Analysis

### The Problem

When new entities and relationships are added (during dream-state extraction), must we recompute all communities from scratch?

### Approaches

**Full Recomputation (Recommended for Engram)**

For engram's expected scale (100-10K nodes), full Louvain recomputation takes < 100ms. This is the simplest and most reliable approach. Run it during each dream cycle.

**Reasons to prefer full recomputation:**
1. Louvain on 10K nodes: ~50ms (benchmarked by graphology)
2. No complex incremental state to maintain or corrupt
3. Communities may shift significantly when key bridge entities are added
4. Dream cycles are already batch processes (not real-time)

**Incremental approaches (for future consideration at larger scale):**

1. **DynaMo (Dynamic Modularity Optimization):** Maintains previous community structure, only re-evaluates nodes whose neighborhoods changed. Two-step approach:
   - Initialize intermediate structure based on incremental changes + previous communities
   - Run local modularity optimization on affected neighborhoods

2. **Delta-screening:** Track which nodes/edges changed since last analysis. Only re-evaluate communities that contain modified neighborhoods. If a community's internal structure hasn't changed, keep it as-is.

3. **Warm-start Louvain:** Use previous community assignments as `partition_init` (graphology supports this via the initial community node attribute). The algorithm converges faster when starting from a good partition.

### Recommended Strategy for Engram

```
Phase 1 (Now): Full recomputation in dream cycle
  - Simple, correct, fast enough for our scale
  - ~50-100ms for typical graphs

Phase 2 (If scale demands): Warm-start Louvain
  - Store previous communities as node attributes
  - Use as initial partition for next run
  - graphology supports this natively

Phase 3 (If needed): Delta-screening
  - Track modified entity/relationship IDs since last dream run
  - Expand to affected communities
  - Only recompute those + their neighbors
```

### Change Detection

Track modifications in the dream checkpoint system:
```sql
-- New entities since last graph analysis
SELECT id FROM entities WHERE created_at > ?;

-- Modified relationships since last graph analysis
SELECT id FROM relationships WHERE updated_at > ? OR created_at > ?;
```

### Sources
- [Temporal community evolution algorithms](https://appliednetsci.springeropen.com/articles/10.1007/s41109-023-00592-1)
- [Incremental community discovery](https://link.springer.com/article/10.1007/s10115-019-01422-6)
- [Comprehensive review of community detection](https://arxiv.org/html/2309.11798v4)

---

## 7. Weight and Scoring

### Edge Weight Model for Engram

Engram's `relationships` table already has a `weight` field (REAL, default 1.0). The question is how to compute and maintain meaningful weights.

### Recommended Multi-Factor Weight Formula

```typescript
function computeEdgeWeight(relationship: {
  mentionCount: number;     // times this relationship was extracted
  lastSeen: number;         // unix timestamp of most recent mention
  confidence: number;       // extraction confidence (0-1)
  sourceImportance: number; // source entity importance
  targetImportance: number; // target entity importance
}, now?: number): number {
  const currentTime = now ?? Math.floor(Date.now() / 1000);

  // Factor 1: Frequency (log-scaled to prevent domination by high-frequency pairs)
  const frequencyScore = Math.log2(1 + relationship.mentionCount) / Math.log2(11); // normalized to ~1.0 at 10 mentions

  // Factor 2: Recency (exponential decay)
  const daysSinceLastSeen = (currentTime - relationship.lastSeen) / 86400;
  const halfLifeDays = 90; // 90-day half-life
  const lambda = Math.LN2 / halfLifeDays;
  const recencyScore = Math.exp(-lambda * daysSinceLastSeen);

  // Factor 3: Confidence (direct passthrough)
  const confidenceScore = relationship.confidence;

  // Factor 4: Entity importance (average of source + target)
  const importanceScore = (relationship.sourceImportance + relationship.targetImportance) / 2;

  // Weighted combination
  const weight =
    0.35 * frequencyScore +
    0.25 * recencyScore +
    0.20 * confidenceScore +
    0.20 * importanceScore;

  return Math.max(0.01, weight); // floor at 0.01 to prevent zero-weight edges
}
```

### How Weights Affect Community Detection

The Louvain modularity formula for weighted graphs:

```
Q = (1/2m) * sum_ij [ A_ij - (k_i * k_j) / (2m) ] * delta(c_i, c_j)
```

Where:
- `A_ij` = weight of edge between i and j
- `k_i` = sum of weights of edges attached to node i
- `m` = sum of all edge weights
- `delta(c_i, c_j)` = 1 if i and j are in the same community

**Effect of weights:**
- **Higher weights pull nodes together.** Frequently co-mentioned, recently seen entities with high confidence cluster together.
- **Low-weight edges are easier to "cut"** during community boundary placement.
- **Recency decay** naturally causes old, stale relationships to weaken their community bonds, allowing the graph structure to evolve over time.

### Temporal Decay for Edges (Aligning with Engram's FSRS Model)

Engram already uses an FSRS-inspired decay model for semantic memories (see `/src/semantic/decay.ts`). The edge weight recency factor should align with this approach:

```typescript
// Consistent with engram's existing decay model
// R(t) = 0.9 ^ (days / stability)
// For relationships, use a fixed stability of ~90 days
const RELATIONSHIP_STABILITY = 90; // days
const recencyFactor = Math.pow(0.9, daysSinceLastSeen / RELATIONSHIP_STABILITY);
```

This uses the same power-law decay formula as the memory system, maintaining conceptual consistency.

### Weight Update Strategy

Weights should be recomputed during the dream cycle's `reflect` phase:

1. For each relationship, look up connected entity mention counts and importance
2. Apply the multi-factor weight formula
3. Store the computed weight
4. Then run community detection on the freshly-weighted graph

### Research on Weighted Community Detection Quality

- The weighted Louvain algorithm achieves higher modularity than unweighted, with faster convergence (IEEE 2024 study)
- Weights should reflect meaningful signal, not just arbitrary scaling -- our multi-factor approach satisfies this
- A Monte Carlo evaluation (Frontiers, 2016) found that community detection on weighted graphs is most reliable when weights have low noise and reflect true connection strength -- hence the confidence factor in our formula

### Sources
- [Exponential decay - Wikipedia](https://en.wikipedia.org/wiki/Exponential_decay)
- [Milvus exponential decay docs](https://milvus.io/docs/exponential-decay.md)
- [Enhancing community detection with weighted Louvain (IEEE)](https://ieeexplore.ieee.org/document/11006186/)
- [Monte Carlo evaluation of weighted community detection (Frontiers)](https://www.frontiersin.org/articles/10.3389/fninf.2016.00045/full)
- [Statistical significance of communities from weighted graphs (Nature)](https://www.nature.com/articles/s41598-021-99175-2)
- [Temporal Personalized PageRank (VLDB)](https://www.vldb.org/pvldb/vol16/p1332-li.pdf)

---

## Implementation Recommendations Summary

### Dependencies to Add

```json
{
  "graphology": "^0.26.0",
  "graphology-communities-louvain": "^0.12.0",
  "graphology-metrics": "^2.3.0",
  "graphology-traversal": "^0.3.0",
  "graphology-shortest-path": "^2.1.0",
  "graphology-components": "^1.5.0",
  "@types/graphology": "^0.26.0"
}
```

Estimated addition to node_modules: ~2-3MB total (no visualization dependencies).

### New Module Structure

```
src/graph/
  index.ts          -- Graph loading, caching, lifecycle
  analyzer.ts       -- Community detection, centrality, bridge detection
  traversal.ts      -- Multi-hop queries, path finding, neighborhood
  clusters.ts       -- Topic cluster generation and LLM naming
  weights.ts        -- Edge weight computation and update
```

### Integration Points

1. **Dream cycle `reflect` phase:** Run full graph analysis
   - Recompute edge weights
   - Load graph into graphology
   - Run Louvain community detection
   - Compute betweenness centrality for bridge detection
   - Generate/update topic clusters with LLM naming
   - Write results back to SQLite

2. **MCP `recall` tool:** Use graph for context-aware retrieval
   - Neighborhood expansion: given a relevant entity, pull in related entities/memories
   - Community context: when recalling a memory, include its topic cluster summary

3. **Search enrichment:** Graph-based query expansion
   - Find entities matching the query
   - Expand to their communities
   - Include community-related memories in search results

### Performance Budget

| Operation | Expected time (10K nodes) | When |
|---|---|---|
| Load graph from SQLite | ~50-100ms | Dream cycle start |
| Louvain community detection | ~50-100ms | Dream reflect phase |
| Betweenness centrality | ~200-500ms | Dream reflect phase |
| BFS neighborhood (2-hop) | ~1-5ms | Real-time query |
| Shortest path (Dijkstra) | ~5-20ms | Real-time query |
| LLM topic naming (per cluster) | ~500-2000ms | Dream reflect phase |

All analysis operations fit well within dream cycle timing. Real-time queries (neighborhood, path) are sub-millisecond to low-millisecond.
