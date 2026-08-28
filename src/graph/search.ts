/**
 * Graph search and entity exploration.
 *
 * Provides entity-centric search for multi-source recall,
 * neighborhood traversal for the explore tool, and
 * entity lookup by name or alias.
 *
 * Phase 4, Stream D implementation.
 */

import type Database from "better-sqlite3";
import type {
  SearchOptions,
  SearchResult,
} from "../_core/types/index.js";
import type { Entity, RelationshipType } from "./types.js";
import type { ExploreOptions, ExploreResult } from "./types.js";
import { embedQuery } from "../_core/embeddings/index.js";
import {
  findNearestEntities,
  ftsSearchEntities,
  getEntity,
  getEntityByName,
  getEntityByAlias,
} from "./entity.js";
import { getRelationshipsForEntity } from "./relationship.js";
import { rrfFuse, normalizeMinMaxFloored } from "../_core/search/rrf.js";
import { searchVector } from "../_core/db/index.js";

// ─── Entity Lookup ───────────────────────────────────────────────

/**
 * Find an entity by name or alias. Tries exact name match first,
 * then alias lookup.
 */
export function findEntityByNameOrAlias(
  db: Database.Database,
  nameOrAlias: string,
): Entity | null {
  return getEntityByName(db, nameOrAlias) ?? getEntityByAlias(db, nameOrAlias);
}

// ─── Graph Search ────────────────────────────────────────────────

/**
 * Entity-centric search for multi-source recall.
 *
 * Pipeline:
 * 1. Embed query with embedQuery()
 * 2. Vector search on vec_entities (top-10)
 * 3. FTS search on entities_fts (top-10)
 * 4. RRF fusion
 * 5. For each matched entity, include description + connected relationships
 * 6. Format as SearchResult[] with source: "graph"
 *
 * Zero LLM calls.
 */
export async function searchGraph(
  db: Database.Database,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const { query, limit = 10 } = options;

  if (!query || query.trim().length === 0) {
    return [];
  }

  const fetchK = Math.max(limit, 10);

  // 1. Embed query
  const queryEmbedding = await embedQuery(query);

  // 2. Vector search
  const vectorResults = findNearestEntities(db, queryEmbedding, fetchK);
  const vectorRanked = vectorResults.map((r, idx) => ({
    id: r.id,
    rank: idx + 1,
  }));

  // 3. FTS search
  const ftsEntities = ftsSearchEntities(db, query, fetchK);
  const ftsRanked = ftsEntities.map((e, idx) => ({
    id: e.id,
    rank: idx + 1,
  }));

  // 4. RRF fusion
  const fused = rrfFuse(vectorRanked, ftsRanked);

  if (fused.length === 0) {
    return [];
  }

  // 5. Normalize scores
  normalizeMinMaxFloored(fused);

  // 6. Build SearchResult[] with entity content and relationships
  const results: SearchResult[] = [];

  for (const item of fused.slice(0, limit)) {
    const entity = getEntity(db, item.id);
    if (!entity) continue;

    // Build content string with entity info and relationships
    const content = buildEntityContent(db, entity);

    results.push({
      id: entity.id,
      source: "graph",
      score: item.score,
      content,
      metadata: {
        entityName: entity.name,
        entityType: entity.type,
        mentionCount: entity.mentionCount,
      },
      tokenEstimate: Math.ceil(content.length / 4) + 10,
    });
  }

  return results;
}

/**
 * Build a content string for a graph search result, including
 * the entity description and its connected relationships.
 */
function buildEntityContent(db: Database.Database, entity: Entity): string {
  const parts: string[] = [];

  parts.push(`${entity.name} (${entity.type}): ${entity.description ?? "No description"}`);

  const rels = getRelationshipsForEntity(db, entity.id);
  if (rels.length > 0) {
    const relDescriptions: string[] = [];
    for (const rel of rels.slice(0, 10)) {
      const isSource = rel.sourceEntityId === entity.id;
      const otherId = isSource ? rel.targetEntityId : rel.sourceEntityId;
      const other = getEntity(db, otherId);
      const otherName = other?.name ?? otherId;
      const dir = isSource ? "->" : "<-";
      relDescriptions.push(`${dir} ${rel.type} ${otherName}`);
    }
    parts.push(`Relationships: ${relDescriptions.join(", ")}`);
  }

  return parts.join("\n");
}

// ─── Entity Exploration ──────────────────────────────────────────

/**
 * Explore an entity's connections in the knowledge graph.
 *
 * 1. Find entity by name or alias
 * 2. Use traverseNeighborhood for 1-N depth traversal
 * 3. Build ExploreResult with center entity, neighbors, optional community
 */
export function exploreEntity(
  db: Database.Database,
  options: ExploreOptions,
): ExploreResult {
  const { entity: entityQuery, depth = 1, relationshipTypes, limit = 25 } = options;

  // Find the center entity
  const centerEntity = findEntityByNameOrAlias(db, entityQuery);
  if (!centerEntity) {
    throw new Error(`Entity not found: ${entityQuery}`);
  }

  // Traverse neighborhood
  const maxDepth = Math.min(Math.max(depth, 1), 3);
  const rawNeighbors = traverseNeighborhood(
    db,
    centerEntity.id,
    maxDepth,
    relationshipTypes,
  );

  // Sort by weight descending so strongest connections survive truncation
  rawNeighbors.sort((a, b) => b.relationship.weight - a.relationship.weight);

  // Apply limit
  const cappedLimit = Math.min(Math.max(limit, 1), 50);
  const trimmed = rawNeighbors.slice(0, cappedLimit);

  // Build neighbor details
  const neighbors: ExploreResult["neighbors"] = [];
  for (const n of trimmed) {
    const neighborEntity = getEntity(db, n.entityId);
    if (!neighborEntity) continue;

    neighbors.push({
      entity: {
        id: neighborEntity.id,
        name: neighborEntity.name,
        type: neighborEntity.type,
        description: neighborEntity.description,
      },
      relationship: n.relationship,
      depth: n.depth,
    });
  }

  // Look up community from topic_clusters
  let community: ExploreResult["community"];
  const clusters = db
    .prepare("SELECT name, description, entity_ids FROM topic_clusters")
    .all() as Array<{ name: string; description: string | null; entity_ids: string }>;

  for (const cluster of clusters) {
    try {
      const entityIds: string[] = JSON.parse(cluster.entity_ids);
      if (entityIds.includes(centerEntity.id)) {
        community = {
          name: cluster.name,
          description: cluster.description ?? undefined,
          entityCount: entityIds.length,
        };
        break;
      }
    } catch {
      // Skip malformed JSON
    }
  }

  return {
    centerEntity: {
      id: centerEntity.id,
      name: centerEntity.name,
      type: centerEntity.type,
      description: centerEntity.description,
      mentionCount: centerEntity.mentionCount,
    },
    neighbors,
    community,
  };
}

// ─── Neighborhood Traversal ──────────────────────────────────────

/**
 * Bidirectional neighborhood traversal (breadth-first).
 *
 * Returns entities reachable within maxDepth hops from the starting
 * entity, along with the relationship connecting them.
 */
export function traverseNeighborhood(
  db: Database.Database,
  entityId: string,
  maxDepth: number,
  relationshipTypes?: RelationshipType[],
): Array<{
  entityId: string;
  depth: number;
  relationship: {
    type: RelationshipType;
    weight: number;
    context?: string;
    direction: "outgoing" | "incoming";
  };
}> {
  // Level-by-level BFS in JS (same shape as exploreSelective). The previous
  // recursive CTE enumerated every walk up to maxDepth — d^depth rows for a
  // degree-d hub — before DISTINCT; this visits each edge once per level.
  const typeSet =
    relationshipTypes && relationshipTypes.length > 0
      ? new Set<string>(relationshipTypes)
      : null;

  const results: Array<{
    entityId: string;
    depth: number;
    relationship: {
      type: RelationshipType;
      weight: number;
      context?: string;
      direction: "outgoing" | "incoming";
    };
  }> = [];

  // `reported`: first arrival via a type-matching edge (shallowest depth).
  // `expanded`: nodes already queued for expansion — traversal continues
  // through non-matching edges exactly as the CTE did.
  const reported = new Set<string>([entityId]);
  const expanded = new Set<string>([entityId]);
  let frontier: string[] = [entityId];
  const CHUNK = 400; // stay well under SQLite's bound-variable limit

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];

    for (let i = 0; i < frontier.length; i += CHUNK) {
      const chunk = frontier.slice(i, i + CHUNK);
      const chunkSet = new Set(chunk);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT id, source_entity_id, target_entity_id, type, weight, context
           FROM relationships
           WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`,
        )
        .all(...chunk, ...chunk) as Array<{
        id: string;
        source_entity_id: string;
        target_entity_id: string;
        type: string;
        weight: number;
        context: string | null;
      }>;

      for (const r of rows) {
        const hops: Array<[string, string, "outgoing" | "incoming"]> = [
          [r.source_entity_id, r.target_entity_id, "outgoing"],
          [r.target_entity_id, r.source_entity_id, "incoming"],
        ];
        for (const [from, to, direction] of hops) {
          if (!chunkSet.has(from) || to === entityId) continue;

          if (!reported.has(to) && (typeSet === null || typeSet.has(r.type))) {
            reported.add(to);
            results.push({
              entityId: to,
              depth,
              relationship: {
                type: r.type as RelationshipType,
                weight: r.weight,
                context: r.context ?? undefined,
                direction,
              },
            });
          }
          if (!expanded.has(to)) {
            expanded.add(to);
            next.push(to);
          }
        }
      }
    }

    frontier = next;
  }

  return results;
}

// ─── Selective Exploration ────────────────────────────────────────

/**
 * Options for criteria-driven selective graph exploration.
 */
export interface SelectiveExploreOptions {
  entityName: string;
  criteria: string;
  maxDepth?: number;
  maxNodes?: number;
  relevanceThreshold?: number;
  relationshipTypes?: RelationshipType[];
}

/**
 * Detail about an entity in the selective explore result.
 */
export interface EntityDetail {
  id: string;
  name: string;
  type: string;
  description?: string;
}

/**
 * Result of a selective graph exploration.
 */
export interface SelectiveExploreResult {
  center: EntityDetail;
  nodes: Array<{
    entity: EntityDetail;
    depth: number;
    relevanceScore: number;
    path: string[];
  }>;
  edges: Array<{
    source: string;
    target: string;
    relationship: string;
    weight: number;
  }>;
  pruned: number;
}

/**
 * Criteria-driven selective graph exploration.
 *
 * Unlike exploreEntity (fixed-depth BFS), this function scores each
 * neighbor against the given criteria using embedding similarity and
 * only expands relevant branches. This converts fixed-depth BFS into
 * model-directed recursive traversal.
 *
 * Algorithm:
 * 1. Find center entity
 * 2. Embed criteria (unless empty/bypass)
 * 3. BFS level by level, scoring neighbors against criteria
 * 4. Only expand neighbors above relevance threshold
 * 5. Stop at maxDepth or maxNodes
 */
export async function exploreSelective(
  db: Database.Database,
  options: SelectiveExploreOptions,
): Promise<SelectiveExploreResult> {
  const {
    entityName,
    criteria,
    maxDepth = 3,
    maxNodes = 50,
    relevanceThreshold = 0.3,
    relationshipTypes,
  } = options;

  // 1. Find center entity
  const centerEntity = findEntityByNameOrAlias(db, entityName);
  if (!centerEntity) {
    throw new Error(`Entity not found: ${entityName}`);
  }

  const center: EntityDetail = {
    id: centerEntity.id,
    name: centerEntity.name,
    type: centerEntity.type,
    description: centerEntity.description,
  };

  const bypassCriteria = !criteria || criteria.trim().length === 0;

  // 2. Build relevance score map from vector search
  let scoreMap: Map<string, number> | null = null;
  if (!bypassCriteria) {
    const criteriaEmbedding = await embedQuery(criteria);
    // Search broadly — get distances for many entities
    const vectorResults = searchVector(db, "vec_entities", criteriaEmbedding, maxNodes * 5);
    scoreMap = new Map();
    for (const r of vectorResults) {
      // vec_entities is an L2 table over unit vectors: cos = 1 - d²/2
      // (same conversion as resolver/consolidator/remember; `1 - d` is the
      // cosine-distance formula and over-prunes everything below cos 0.5)
      const similarity = Math.max(0, Math.min(1, 1 - (r.distance * r.distance) / 2));
      scoreMap.set(r.id, similarity);
    }
  }

  // 3. BFS with criteria filtering
  const resultNodes: SelectiveExploreResult["nodes"] = [];
  const resultEdges: SelectiveExploreResult["edges"] = [];
  const visited = new Set<string>([centerEntity.id]);
  let pruned = 0;

  // Queue: [entityId, depth, pathSoFar]
  let frontier: Array<{ entityId: string; depth: number; path: string[] }> = [
    { entityId: centerEntity.id, depth: 0, path: [centerEntity.name] },
  ];

  const clampedMaxDepth = Math.min(Math.max(maxDepth, 1), 5);

  while (frontier.length > 0 && resultNodes.length < maxNodes) {
    const nextFrontier: typeof frontier = [];

    for (const current of frontier) {
      if (current.depth >= clampedMaxDepth) continue;
      if (resultNodes.length >= maxNodes) break;

      // Get depth-1 neighbors of current entity
      const neighbors = traverseNeighborhood(
        db,
        current.entityId,
        1,
        relationshipTypes,
      );

      for (const neighbor of neighbors) {
        if (visited.has(neighbor.entityId)) continue;
        visited.add(neighbor.entityId);

        const neighborEntity = getEntity(db, neighbor.entityId);
        if (!neighborEntity) continue;

        // Score against criteria
        let relevanceScore: number;
        if (bypassCriteria) {
          relevanceScore = 1.0;
        } else {
          relevanceScore = scoreMap?.get(neighbor.entityId) ?? 0;
        }

        // Add edge regardless of pruning (edges between visited nodes)
        const sourceEntity = getEntity(db, current.entityId);
        const sourceName = sourceEntity?.name ?? current.entityId;
        const isOutgoing = neighbor.relationship.direction === "outgoing";

        resultEdges.push({
          source: isOutgoing ? sourceName : neighborEntity.name,
          target: isOutgoing ? neighborEntity.name : sourceName,
          relationship: neighbor.relationship.type,
          weight: neighbor.relationship.weight,
        });

        // Filter by relevance
        if (!bypassCriteria && relevanceScore < relevanceThreshold) {
          pruned++;
          continue;
        }

        if (resultNodes.length >= maxNodes) {
          pruned++;
          continue;
        }

        const nodePath = [...current.path, neighborEntity.name];

        resultNodes.push({
          entity: {
            id: neighborEntity.id,
            name: neighborEntity.name,
            type: neighborEntity.type,
            description: neighborEntity.description,
          },
          depth: current.depth + 1,
          relevanceScore,
          path: nodePath,
        });

        // Queue for further expansion
        nextFrontier.push({
          entityId: neighbor.entityId,
          depth: current.depth + 1,
          path: nodePath,
        });
      }
    }

    frontier = nextFrontier;
  }

  // Only keep edges where both endpoints are in the result set (center + nodes)
  const keptIds = new Set([centerEntity.name, ...resultNodes.map((n) => n.entity.name)]);
  const filteredEdges = resultEdges.filter(
    (e) => keptIds.has(e.source) && keptIds.has(e.target),
  );

  return {
    center,
    nodes: resultNodes,
    edges: filteredEdges,
    pruned,
  };
}
