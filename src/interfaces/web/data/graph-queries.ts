/**
 * Database query functions for graph data.
 *
 * All functions accept a Database instance and return structured data
 * for the graph visualizer API endpoints.
 */

import type Database from "better-sqlite3";

// ─── Types ──────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  description: string | null;
  mentionCount: number;
  firstSeen: number;
  community: string | null;
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;
  weight: number;
  context: string | null;
}

export interface DepthNode extends GraphNode {
  lastActive: number;
  bridgeScore: number;
}

export interface DiffResult {
  timestamp: number;
  newNodes: Array<DepthNode>;
  updatedNodes: Array<DepthNode>;
  newLinks: Array<GraphLink>;
  updatedLinks: Array<GraphLink>;
}

// ─── Community Lookup Helper ────────────────────────────────────

function buildCommunityMap(
  db: Database.Database,
  filterIds?: Set<string>,
): Record<string, string> {
  const clusters = db
    .prepare("SELECT name, entity_ids FROM topic_clusters")
    .all() as Array<{ name: string; entity_ids: string }>;

  const entityCommunity: Record<string, string> = {};
  for (const c of clusters) {
    try {
      const ids: string[] = JSON.parse(c.entity_ids);
      for (const id of ids) {
        if (filterIds && !filterIds.has(id)) continue;
        if (!entityCommunity[id]) entityCommunity[id] = c.name;
      }
    } catch { /* skip */ }
  }
  return entityCommunity;
}

// ─── Graph Data ─────────────────────────────────────────────────

export function getGraphData(db: Database.Database): { nodes: GraphNode[]; links: GraphLink[] } {
  const entities = db
    .prepare(
      `SELECT id, name, type, description, mention_count as mentionCount,
              COALESCE(first_seen, created_at) as firstSeen,
              created_at as createdAt
       FROM entities ORDER BY mention_count DESC`
    )
    .all() as Array<{
    id: string;
    name: string;
    type: string;
    description: string | null;
    mentionCount: number;
    firstSeen: number | null;
    createdAt: number | null;
  }>;

  const relationships = db
    .prepare(
      `SELECT r.source_entity_id as source, r.target_entity_id as target,
              r.type, r.weight, r.context
       FROM relationships r`
    )
    .all() as Array<{
    source: string;
    target: string;
    type: string;
    weight: number;
    context: string | null;
  }>;

  const entityCommunity = buildCommunityMap(db);

  return {
    nodes: entities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      description: e.description,
      mentionCount: e.mentionCount,
      firstSeen: e.firstSeen ?? e.createdAt ?? 0,
      community: entityCommunity[e.id] ?? null,
    })),
    links: relationships.map((r) => ({
      source: r.source,
      target: r.target,
      type: r.type,
      weight: r.weight,
      context: r.context,
    })),
  };
}

// ─── Stats ──────────────────────────────────────────────────────

export function getStats(db: Database.Database): { nodes: number; edges: number; communities: number } {
  const nodes = (db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
  const edges = (db.prepare("SELECT COUNT(*) as c FROM relationships").get() as { c: number }).c;
  const communities = (db.prepare("SELECT COUNT(*) as c FROM topic_clusters").get() as { c: number }).c;
  return { nodes, edges, communities };
}

// ─── Optimal Threshold ──────────────────────────────────────────

let cachedThreshold: { value: number; nodes: number; edges: number; edgePct: number } | null = null;

export function resetThresholdCache(): void {
  cachedThreshold = null;
}

export function computeOptimalThreshold(db: Database.Database): { value: number; nodes: number; edges: number; edgePct: number } {
  if (cachedThreshold) return cachedThreshold;

  const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
  const totalEdges = (db.prepare("SELECT COUNT(*) as c FROM relationships").get() as { c: number }).c;

  if (totalNodes === 0) {
    cachedThreshold = { value: 1, nodes: 0, edges: 0, edgePct: 100 };
    return cachedThreshold;
  }

  // Get distinct mention counts as candidate thresholds
  const candidates = db.prepare(
    `SELECT DISTINCT mention_count as t FROM entities
     WHERE mention_count BETWEEN 1 AND 100
     ORDER BY mention_count`
  ).all() as Array<{ t: number }>;

  const NODE_MIN = 1500;
  const NODE_MAX = 4000;

  let best = { value: 1, nodes: totalNodes, edges: totalEdges, edgePct: 100, score: 1 };

  for (const { t } of candidates) {
    const nodeCount = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE mention_count >= ?"
    ).get(t) as { c: number }).c;

    // Skip if outside performance band
    if (nodeCount > NODE_MAX && t > 1) continue;
    if (nodeCount < NODE_MIN) break; // thresholds only go up, so we're done

    const edgeCount = (db.prepare(
      `SELECT COUNT(*) as c FROM relationships r
       WHERE EXISTS (SELECT 1 FROM entities e WHERE e.id = r.source_entity_id AND e.mention_count >= ?)
         AND EXISTS (SELECT 1 FROM entities e WHERE e.id = r.target_entity_id AND e.mention_count >= ?)`
    ).get(t, t) as { c: number }).c;

    const nodePct = nodeCount / totalNodes;
    const edgePct = edgeCount / totalEdges;
    const score = edgePct / nodePct; // > 1 means we keep proportionally more edges than nodes

    if (score >= best.score) {
      best = { value: t, nodes: nodeCount, edges: edgeCount, edgePct: Math.round(edgePct * 1000) / 10, score };
    }
  }

  // If all thresholds leave us above NODE_MAX, pick the first one that drops below
  if (best.nodes > NODE_MAX) {
    for (const { t } of candidates) {
      const nodeCount = (db.prepare(
        "SELECT COUNT(*) as c FROM entities WHERE mention_count >= ?"
      ).get(t) as { c: number }).c;
      if (nodeCount <= NODE_MAX) {
        const edgeCount = (db.prepare(
          `SELECT COUNT(*) as c FROM relationships r
           WHERE EXISTS (SELECT 1 FROM entities e WHERE e.id = r.source_entity_id AND e.mention_count >= ?)
             AND EXISTS (SELECT 1 FROM entities e WHERE e.id = r.target_entity_id AND e.mention_count >= ?)`
        ).get(t, t) as { c: number }).c;
        best = { value: t, nodes: nodeCount, edges: edgeCount, edgePct: Math.round((edgeCount / totalEdges) * 1000) / 10, score: 0 };
        break;
      }
    }
  }

  cachedThreshold = { value: best.value, nodes: best.nodes, edges: best.edges, edgePct: best.edgePct };
  return cachedThreshold;
}

// ─── Graph Diff ─────────────────────────────────────────────────

export function getGraphDiff(db: Database.Database, since: number): DiffResult {
  const newNodes = db.prepare(
    `SELECT e.id, e.name, e.type, e.description, e.mention_count as mentionCount,
            COALESCE(e.last_seen, e.created_at) as lastActive, e.created_at as createdAt,
            e.first_seen as firstSeen,
            COALESCE(bs.bridge_score, 0) as bridgeScore
     FROM entities e
     LEFT JOIN bridge_scores bs ON bs.entity_id = e.id
       AND bs.generation = (SELECT MAX(generation) FROM bridge_scores)
     WHERE e.created_at > ?`
  ).all(since) as Array<{ id: string; name: string; type: string; description: string | null; mentionCount: number; lastActive: number | null; createdAt: number | null; firstSeen: number | null; bridgeScore: number }>;

  const updatedNodes = db.prepare(
    `SELECT e.id, e.name, e.type, e.description, e.mention_count as mentionCount,
            COALESCE(e.last_seen, e.created_at) as lastActive, e.created_at as createdAt,
            e.first_seen as firstSeen,
            COALESCE(bs.bridge_score, 0) as bridgeScore
     FROM entities e
     LEFT JOIN bridge_scores bs ON bs.entity_id = e.id
       AND bs.generation = (SELECT MAX(generation) FROM bridge_scores)
     WHERE e.last_seen > ? AND e.created_at <= ?`
  ).all(since, since) as Array<{ id: string; name: string; type: string; description: string | null; mentionCount: number; lastActive: number | null; createdAt: number | null; firstSeen: number | null; bridgeScore: number }>;

  const newLinks = db.prepare(
    `SELECT source_entity_id as source, target_entity_id as target, type, weight, context
     FROM relationships WHERE created_at > ?`
  ).all(since) as Array<{ source: string; target: string; type: string; weight: number; context: string | null }>;

  const updatedLinks = db.prepare(
    `SELECT source_entity_id as source, target_entity_id as target, type, weight, context
     FROM relationships WHERE updated_at > ? AND created_at <= ?`
  ).all(since, since) as Array<{ source: string; target: string; type: string; weight: number; context: string | null }>;

  // Get community for new/updated nodes
  const newIds = new Set(newNodes.map(n => n.id).concat(updatedNodes.map(n => n.id)));
  const entityCommunity = buildCommunityMap(db, newIds);

  const mapNode = (e: typeof newNodes[0]) => ({
    id: e.id, name: e.name, type: e.type, description: e.description,
    mentionCount: e.mentionCount, community: entityCommunity[e.id] ?? null,
    lastActive: e.lastActive ?? e.createdAt ?? 0,
    firstSeen: e.firstSeen ?? e.createdAt ?? 0,
    bridgeScore: e.bridgeScore,
  });

  return {
    timestamp: Math.floor(Date.now() / 1000),
    newNodes: newNodes.map(mapNode),
    updatedNodes: updatedNodes.map(mapNode),
    newLinks,
    updatedLinks,
  };
}

// ─── Depth (3D) Graph Data ──────────────────────────────────────

export function getDepthGraphData(db: Database.Database): { nodes: DepthNode[]; links: GraphLink[] } {
  const entities = db
    .prepare(
      `SELECT e.id, e.name, e.type, e.description, e.mention_count as mentionCount,
              COALESCE(e.last_seen, e.created_at) as lastActive, e.created_at as createdAt,
              e.first_seen as firstSeen,
              COALESCE(bs.bridge_score, 0) as bridgeScore
       FROM entities e
       LEFT JOIN bridge_scores bs ON bs.entity_id = e.id
         AND bs.generation = (SELECT MAX(generation) FROM bridge_scores)
       ORDER BY e.mention_count DESC`
    )
    .all() as Array<{
    id: string;
    name: string;
    type: string;
    description: string | null;
    mentionCount: number;
    lastActive: number | null;
    createdAt: number | null;
    firstSeen: number | null;
    bridgeScore: number;
  }>;

  const relationships = db
    .prepare(
      `SELECT r.source_entity_id as source, r.target_entity_id as target,
              r.type, r.weight, r.context
       FROM relationships r`
    )
    .all() as Array<{
    source: string;
    target: string;
    type: string;
    weight: number;
    context: string | null;
  }>;

  const entityCommunity = buildCommunityMap(db);

  return {
    nodes: entities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      description: e.description,
      mentionCount: e.mentionCount,
      community: entityCommunity[e.id] ?? null,
      lastActive: e.lastActive ?? e.createdAt ?? 0,
      firstSeen: e.firstSeen ?? e.createdAt ?? 0,
      bridgeScore: e.bridgeScore,
    })),
    links: relationships.map((r) => ({
      source: r.source,
      target: r.target,
      type: r.type,
      weight: r.weight,
      context: r.context,
    })),
  };
}
