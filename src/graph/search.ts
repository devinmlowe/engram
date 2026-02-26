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
  Entity,
  RelationshipType,
} from "../core/types.js";
import type { ExploreOptions, ExploreResult } from "./types.js";
import { embedQuery } from "../episodic/embeddings.js";
import {
  findNearestEntities,
  ftsSearchEntities,
  getEntity,
  getEntityByName,
  getEntityByAlias,
} from "./entity.js";
import { getRelationshipsForEntity } from "./relationship.js";
import { rrfFuse, normalizeMinMaxFloored } from "../episodic/search.js";

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
  const { entity: entityQuery, depth = 1, relationshipTypes } = options;

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

  // Build neighbor details
  const neighbors: ExploreResult["neighbors"] = [];
  for (const n of rawNeighbors) {
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
 * Bidirectional neighborhood traversal using recursive CTE.
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
  const rows = db
    .prepare(`
      WITH RECURSIVE neighbors(entity_id, depth, rel_id, rel_type, rel_weight, rel_context, direction) AS (
        SELECT ?, 0, NULL, NULL, NULL, NULL, NULL
        UNION ALL
        SELECT
          CASE WHEN r.source_entity_id = n.entity_id
               THEN r.target_entity_id
               ELSE r.source_entity_id END,
          n.depth + 1,
          r.id,
          r.type,
          r.weight,
          r.context,
          CASE WHEN r.source_entity_id = n.entity_id THEN 'outgoing' ELSE 'incoming' END
        FROM neighbors n
        JOIN relationships r
          ON (r.source_entity_id = n.entity_id OR r.target_entity_id = n.entity_id)
        WHERE n.depth < ?
      )
      SELECT DISTINCT entity_id, depth, rel_id, rel_type, rel_weight, rel_context, direction
      FROM neighbors
      WHERE depth > 0
    `)
    .all(entityId, maxDepth) as Array<{
    entity_id: string;
    depth: number;
    rel_id: string;
    rel_type: string;
    rel_weight: number;
    rel_context: string | null;
    direction: string;
  }>;

  // Filter by relationship types if specified
  let filtered = rows;
  if (relationshipTypes && relationshipTypes.length > 0) {
    const typeSet = new Set(relationshipTypes);
    filtered = rows.filter((r) => typeSet.has(r.rel_type as RelationshipType));
  }

  // Deduplicate: keep first occurrence of each entity (shallowest depth)
  const seen = new Set<string>();
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

  // Sort by depth to ensure shallowest first
  filtered.sort((a, b) => a.depth - b.depth);

  for (const row of filtered) {
    // Skip the starting entity if it appears in results
    if (row.entity_id === entityId) continue;

    if (seen.has(row.entity_id)) continue;
    seen.add(row.entity_id);

    results.push({
      entityId: row.entity_id,
      depth: row.depth,
      relationship: {
        type: row.rel_type as RelationshipType,
        weight: row.rel_weight,
        context: row.rel_context ?? undefined,
        direction: row.direction as "outgoing" | "incoming",
      },
    });
  }

  return results;
}
