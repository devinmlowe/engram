/**
 * Graph analysis using graphology.
 *
 * Provides community detection (Louvain), betweenness centrality,
 * bridge entity identification, and coherence scoring for the
 * knowledge graph layer.
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import betweennessCentrality from "graphology-metrics/centrality/betweenness.js";
import type Database from "better-sqlite3";
import type { GraphAnalysisResult, CommunityResult, BridgeScore, CommunityNaming } from "./types.js";

// ─── Graph Loading ───────────────────────────────────────────────

/**
 * Build an in-memory graphology graph from the entities and
 * relationships tables in SQLite.
 */
export function loadGraph(db: Database.Database): Graph {
  const graph = new Graph({ type: "undirected", multi: false });

  // Add nodes from entities table
  const entities = db
    .prepare("SELECT id, name, type FROM entities")
    .all() as Array<{ id: string; name: string; type: string }>;

  for (const entity of entities) {
    graph.addNode(entity.id, { name: entity.name, type: entity.type });
  }

  // Add edges from relationships table
  const relationships = db
    .prepare(
      "SELECT id, source_entity_id, target_entity_id, type, weight FROM relationships",
    )
    .all() as Array<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    type: string;
    weight: number;
  }>;

  for (const rel of relationships) {
    // Skip if either endpoint is missing (defensive)
    if (!graph.hasNode(rel.source_entity_id) || !graph.hasNode(rel.target_entity_id)) {
      continue;
    }
    // Skip self-loops
    if (rel.source_entity_id === rel.target_entity_id) {
      continue;
    }
    // Skip duplicate edges in undirected graph
    if (graph.hasEdge(rel.source_entity_id, rel.target_entity_id)) {
      continue;
    }
    graph.addEdgeWithKey(rel.id, rel.source_entity_id, rel.target_entity_id, {
      type: rel.type,
      weight: rel.weight,
    });
  }

  return graph;
}

// ─── Community Detection ─────────────────────────────────────────

/**
 * Run Louvain community detection on the graph.
 *
 * Returns a communities map (nodeId -> communityId), the community
 * count, and the modularity score.
 */
export function detectCommunities(
  graph: Graph,
  resolution?: number,
): {
  communities: Map<string, number>;
  count: number;
  modularity: number;
} {
  if (graph.order === 0) {
    return { communities: new Map(), count: 0, modularity: 0 };
  }

  // Single-node graphs: assign the one node to community 0
  if (graph.order === 1) {
    const communities = new Map<string, number>();
    graph.forEachNode((node) => {
      communities.set(node, 0);
    });
    return { communities, count: 1, modularity: 0 };
  }

  const result = louvain.detailed(graph, {
    resolution: resolution ?? 1,
    getEdgeWeight: "weight",
  });

  const communities = new Map<string, number>();
  for (const [nodeId, communityId] of Object.entries(result.communities)) {
    communities.set(nodeId, communityId as number);
  }

  return {
    communities,
    count: result.count,
    modularity: result.modularity,
  };
}

/**
 * Invert the node->community map to community->nodes[].
 */
export function groupByCommunity(
  communities: Map<string, number>,
): Map<number, string[]> {
  const groups = new Map<number, string[]>();

  for (const [nodeId, communityId] of communities) {
    const existing = groups.get(communityId);
    if (existing) {
      existing.push(nodeId);
    } else {
      groups.set(communityId, [nodeId]);
    }
  }

  return groups;
}

// ─── Coherence Scoring ───────────────────────────────────────────

/**
 * Compute the coherence of a community as the ratio of internal
 * edges to total edges incident on the community.
 *
 * A fully connected clique returns 1.0, an isolated set of nodes
 * with no internal edges returns 0.
 */
export function computeCoherence(
  graph: Graph,
  communityNodes: string[],
): number {
  const nodeSet = new Set(communityNodes);
  let internalEdges = 0;
  let externalEdges = 0;

  for (const nodeId of communityNodes) {
    if (!graph.hasNode(nodeId)) continue;

    graph.forEachEdge(nodeId, (_edge, _attrs, source, target) => {
      const neighbor = source === nodeId ? target : source;
      if (nodeSet.has(neighbor)) {
        // Internal edge — will be counted twice (once per endpoint),
        // so we count 0.5 per encounter to get the true count
        internalEdges += 0.5;
      } else {
        externalEdges += 1;
      }
    });
  }

  const total = internalEdges + externalEdges;
  if (total === 0) return 0;
  return internalEdges / total;
}

// ─── Betweenness Centrality ──────────────────────────────────────

/**
 * Compute betweenness centrality for all nodes.
 *
 * Uses graphology-metrics/centrality/betweenness which returns a
 * mapping { nodeId: score }.
 */
export function computeBetweenness(graph: Graph): Map<string, number> {
  if (graph.order === 0) {
    return new Map();
  }

  const scores = betweennessCentrality(graph, {
    getEdgeWeight: "weight",
  });

  const result = new Map<string, number>();
  for (const [nodeId, score] of Object.entries(scores)) {
    result.set(nodeId, score);
  }
  return result;
}

// ─── Bridge Entity Detection ─────────────────────────────────────

/**
 * Identify bridge entities — nodes that connect different
 * communities and have high betweenness centrality.
 *
 * bridgeScore = betweenness * communitySpan, where communitySpan
 * is the number of distinct communities in the node's 1-hop
 * neighborhood (including its own community).
 */
export function detectBridgeEntities(
  graph: Graph,
  communities: Map<string, number>,
): Array<{
  entityId: string;
  betweenness: number;
  communitySpan: number;
  bridgeScore: number;
}> {
  const betweennessScores = computeBetweenness(graph);
  const results: Array<{
    entityId: string;
    betweenness: number;
    communitySpan: number;
    bridgeScore: number;
  }> = [];

  graph.forEachNode((nodeId) => {
    const nodeCommunity = communities.get(nodeId);
    if (nodeCommunity === undefined) return;

    // Collect distinct communities in 1-hop neighborhood
    const neighborCommunities = new Set<number>();
    neighborCommunities.add(nodeCommunity);

    graph.forEachNeighbor(nodeId, (neighbor) => {
      const nc = communities.get(neighbor);
      if (nc !== undefined) {
        neighborCommunities.add(nc);
      }
    });

    const communitySpan = neighborCommunities.size;
    const betweenness = betweennessScores.get(nodeId) ?? 0;
    const bridgeScore = betweenness * communitySpan;

    if (bridgeScore > 0) {
      results.push({ entityId: nodeId, betweenness, communitySpan, bridgeScore });
    }
  });

  // Sort descending by bridgeScore
  results.sort((a, b) => b.bridgeScore - a.bridgeScore);

  return results;
}

// ─── Full Analysis Pipeline ──────────────────────────────────────

/**
 * Run the complete graph analysis pipeline:
 * 1. Load graph from DB
 * 2. Detect communities
 * 3. Compute coherence per community
 * 4. Detect bridge entities
 * 5. Return structured result with timing
 */
export function analyzeGraph(
  db: Database.Database,
  resolution?: number,
): GraphAnalysisResult {
  const startTime = performance.now();

  const graph = loadGraph(db);

  // Handle empty graph
  if (graph.order === 0) {
    return {
      communities: [],
      modularity: 0,
      bridgeEntities: [],
      totalNodes: 0,
      totalEdges: 0,
      durationMs: Math.round(performance.now() - startTime),
    };
  }

  const { communities, modularity } = detectCommunities(graph, resolution);
  const groups = groupByCommunity(communities);

  const communityResults: CommunityResult[] = [];
  for (const [communityId, entityIds] of groups) {
    const coherenceScore = computeCoherence(graph, entityIds);
    communityResults.push({
      communityId,
      entityIds,
      coherenceScore,
    });
  }

  const bridgeEntities = detectBridgeEntities(graph, communities);

  return {
    communities: communityResults,
    modularity,
    bridgeEntities,
    totalNodes: graph.order,
    totalEdges: graph.size,
    durationMs: Math.round(performance.now() - startTime),
  };
}

// ─── Persistence ─────────────────────────────────────────────────

/**
 * Persist graph analysis results to the topic_clusters table.
 *
 * Each community becomes a TopicCluster row. The generation counter
 * increments from the current max generation.
 *
 * When communityNames is provided, uses the LLM-generated name and
 * description instead of the generic "Community N" placeholder.
 */
export function persistAnalysis(
  db: Database.Database,
  analysis: GraphAnalysisResult,
  communityNames?: CommunityNaming[],
): void {
  // Get current max generation
  const row = db
    .prepare("SELECT MAX(generation) as maxGen FROM topic_clusters")
    .get() as { maxGen: number | null } | undefined;
  const nextGeneration = (row?.maxGen ?? 0) + 1;

  const now = Math.floor(Date.now() / 1000);

  // Index community names by communityId for fast lookup
  const nameMap = new Map<number, CommunityNaming>();
  if (communityNames) {
    for (const cn of communityNames) {
      nameMap.set(cn.communityId, cn);
    }
  }

  const insert = db.prepare(`
    INSERT INTO topic_clusters (id, name, description, entity_ids, memory_ids, coherence_score, created_at, updated_at, generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const community of analysis.communities) {
      const id = crypto.randomUUID();
      const naming = nameMap.get(community.communityId);
      const name = naming?.name ?? `Community ${community.communityId}`;
      const description =
        naming?.description ??
        `Auto-detected community with ${community.entityIds.length} entities (coherence: ${community.coherenceScore.toFixed(3)})`;
      const entityIdsJson = JSON.stringify(community.entityIds);
      const memoryIdsJson = JSON.stringify([]);

      insert.run(
        id,
        name,
        description,
        entityIdsJson,
        memoryIdsJson,
        community.coherenceScore,
        now,
        now,
        nextGeneration,
      );
    }
  });

  insertMany();
}

// ─── Bridge Score Persistence ────────────────────────────────────

/**
 * Get the latest bridge generation number.
 *
 * Returns 0 when no bridge scores exist.
 */
export function getLatestBridgeGeneration(db: Database.Database): number {
  const row = db
    .prepare("SELECT MAX(generation) as maxGen FROM bridge_scores")
    .get() as { maxGen: number | null } | undefined;
  return row?.maxGen ?? 0;
}

/**
 * Persist bridge entity scores to the bridge_scores table.
 *
 * Each bridge gets its betweenness, community_span, and bridge_score
 * recorded with a generation counter for temporal tracking.
 * Uses a transaction for atomicity — partial failures leave no data.
 */
export function persistBridgeScores(
  db: Database.Database,
  bridges: Array<{
    entityId: string;
    betweenness: number;
    communitySpan: number;
    bridgeScore: number;
  }>,
  generation?: number,
): void {
  const nextGeneration = generation ?? getLatestBridgeGeneration(db) + 1;

  const insert = db.prepare(`
    INSERT INTO bridge_scores (entity_id, betweenness, community_span, bridge_score, generation)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const bridge of bridges) {
      insert.run(
        bridge.entityId,
        bridge.betweenness,
        bridge.communitySpan,
        bridge.bridgeScore,
        nextGeneration,
      );
    }
  });

  insertAll();
}

/**
 * Retrieve bridge scores for a given generation (or latest if not specified).
 *
 * JOINs with entities to include entityName and entityType in the result.
 */
export function getBridgeScores(
  db: Database.Database,
  generation?: number,
): BridgeScore[] {
  const targetGeneration = generation ?? getLatestBridgeGeneration(db);

  if (targetGeneration === 0) {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT
        bs.entity_id,
        e.name AS entity_name,
        e.type AS entity_type,
        bs.betweenness,
        bs.community_span,
        bs.bridge_score,
        bs.narrative,
        bs.generation
      FROM bridge_scores bs
      JOIN entities e ON e.id = bs.entity_id
      WHERE bs.generation = ?
      ORDER BY bs.bridge_score DESC`,
    )
    .all(targetGeneration) as Array<{
    entity_id: string;
    entity_name: string;
    entity_type: string;
    betweenness: number;
    community_span: number;
    bridge_score: number;
    narrative: string | null;
    generation: number;
  }>;

  return rows.map((row) => ({
    entityId: row.entity_id,
    entityName: row.entity_name,
    entityType: row.entity_type as BridgeScore["entityType"],
    betweenness: row.betweenness,
    communitySpan: row.community_span,
    bridgeScore: row.bridge_score,
    narrative: row.narrative ?? undefined,
    generation: row.generation,
  }));
}
