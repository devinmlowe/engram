/**
 * Database query functions for graph data.
 *
 * All functions accept a Database instance and return structured data
 * for the graph visualizer API endpoints. Every view (2D, 3D, galaxy,
 * terminal) receives the same node shape; consumers ignore fields they
 * do not use.
 */

import type Database from "better-sqlite3";

// ─── Types ──────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  description: string | null;
  mentionCount: number;
  informativeness: number;
  firstSeen: number;
  community: string | null;
  lastActive: number;
  bridgeScore: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;
  weight: number;
  context: string | null;
}

export interface DiffResult {
  timestamp: number;
  newNodes: GraphNode[];
  updatedNodes: GraphNode[];
  newLinks: GraphLink[];
  updatedLinks: GraphLink[];
}

// ─── Shared SELECTs ─────────────────────────────────────────────

interface NodeRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
  mentionCount: number;
  informativeness: number;
  lastActive: number | null;
  createdAt: number | null;
  firstSeen: number | null;
  bridgeScore: number;
}

const NODE_SELECT = `
  SELECT e.id, e.name, e.type, e.description, e.mention_count as mentionCount,
         COALESCE(e.informativeness, 0) as informativeness,
         COALESCE(e.last_seen, e.created_at) as lastActive, e.created_at as createdAt,
         e.first_seen as firstSeen,
         COALESCE(bs.bridge_score, 0) as bridgeScore
  FROM entities e
  LEFT JOIN bridge_scores bs ON bs.entity_id = e.id
    AND bs.generation = (SELECT MAX(generation) FROM bridge_scores)`;

const LINK_SELECT = `
  SELECT source_entity_id as source, target_entity_id as target, type, weight, context
  FROM relationships`;

/** `suffix` is the SQL after the joins (WHERE / ORDER BY); `params` bind its placeholders. */
function selectNodes(db: Database.Database, suffix: string, ...params: unknown[]): NodeRow[] {
  return db.prepare(`${NODE_SELECT} ${suffix}`).all(...params) as NodeRow[];
}

function selectLinks(db: Database.Database, suffix: string, ...params: unknown[]): GraphLink[] {
  return db.prepare(`${LINK_SELECT} ${suffix}`).all(...params) as GraphLink[];
}

function toNode(e: NodeRow, community: Record<string, string>): GraphNode {
  return {
    id: e.id,
    name: e.name,
    type: e.type,
    description: e.description,
    mentionCount: e.mentionCount,
    informativeness: e.informativeness,
    community: community[e.id] ?? null,
    lastActive: e.lastActive ?? e.createdAt ?? 0,
    firstSeen: e.firstSeen ?? e.createdAt ?? 0,
    bridgeScore: e.bridgeScore,
  };
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
  const community = buildCommunityMap(db);
  return {
    nodes: selectNodes(db, "ORDER BY e.mention_count DESC").map((e) => toNode(e, community)),
    links: selectLinks(db, ""),
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

export interface Threshold {
  value: number;
  nodes: number;
  edges: number;
  edgePct: number;
}

let cachedThreshold: Threshold | null = null;

export function resetThresholdCache(): void {
  cachedThreshold = null;
}

export function computeOptimalThreshold(db: Database.Database): Threshold {
  if (cachedThreshold) return cachedThreshold;

  const { nodes: totalNodes, edges: totalEdges } = getStats(db);

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

  const countNodes = db.prepare("SELECT COUNT(*) as c FROM entities WHERE mention_count >= ?");
  const countEdges = db.prepare(
    `SELECT COUNT(*) as c FROM relationships r
     WHERE EXISTS (SELECT 1 FROM entities e WHERE e.id = r.source_entity_id AND e.mention_count >= ?)
       AND EXISTS (SELECT 1 FROM entities e WHERE e.id = r.target_entity_id AND e.mention_count >= ?)`
  );
  const pct = (edges: number) => Math.round((edges / totalEdges) * 1000) / 10;

  const NODE_MIN = 1500;
  const NODE_MAX = 4000;

  let best: Threshold = { value: 1, nodes: totalNodes, edges: totalEdges, edgePct: 100 };
  let bestScore = 1;
  // First candidate at or below NODE_MAX: used when no in-band candidate beats the baseline
  let fallback: Threshold | null = null;

  for (const { t } of candidates) {
    const nodeCount = (countNodes.get(t) as { c: number }).c;

    // Skip if outside performance band
    if (nodeCount > NODE_MAX && t > 1) continue;

    const edgeCount = (countEdges.get(t, t) as { c: number }).c;
    if (nodeCount <= NODE_MAX && !fallback) {
      fallback = { value: t, nodes: nodeCount, edges: edgeCount, edgePct: pct(edgeCount) };
    }
    if (nodeCount < NODE_MIN) break; // thresholds only go up, so we're done

    const score = (edgeCount / totalEdges) / (nodeCount / totalNodes); // > 1 keeps proportionally more edges than nodes
    if (score >= bestScore) {
      bestScore = score;
      best = { value: t, nodes: nodeCount, edges: edgeCount, edgePct: pct(edgeCount) };
    }
  }

  // If every scored threshold leaves us above NODE_MAX, take the first one that drops below
  if (best.nodes > NODE_MAX && fallback) best = fallback;

  cachedThreshold = best;
  return cachedThreshold;
}

// ─── Graph Diff ─────────────────────────────────────────────────

export function getGraphDiff(db: Database.Database, since: number): DiffResult {
  const newNodes = selectNodes(db, "WHERE e.created_at > ?", since);
  const updatedNodes = selectNodes(db, "WHERE e.last_seen > ? AND e.created_at <= ?", since, since);

  // Get community for new/updated nodes
  const ids = new Set(newNodes.map((n) => n.id).concat(updatedNodes.map((n) => n.id)));
  const community = buildCommunityMap(db, ids);

  return {
    timestamp: Math.floor(Date.now() / 1000),
    newNodes: newNodes.map((e) => toNode(e, community)),
    updatedNodes: updatedNodes.map((e) => toNode(e, community)),
    newLinks: selectLinks(db, "WHERE created_at > ?", since),
    updatedLinks: selectLinks(db, "WHERE updated_at > ? AND created_at <= ?", since, since),
  };
}

// ─── Community Data ─────────────────────────────────────────────

export interface CommunityNode {
  id: string;
  name: string;
  description: string | null;
  entityCount: number;
  coherenceScore: number;
  generation: number;
}

export function getCommunityData(db: Database.Database): CommunityNode[] {
  return db.prepare(
    `SELECT id, name, description,
            json_array_length(entity_ids) as entityCount,
            COALESCE(coherence_score, 0) as coherenceScore,
            generation
     FROM topic_clusters
     WHERE generation = (SELECT MAX(generation) FROM topic_clusters)
     ORDER BY json_array_length(entity_ids) DESC`
  ).all() as CommunityNode[];
}
