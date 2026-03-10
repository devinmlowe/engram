/**
 * Shared explore operation — wraps exploreEntity for interface layer.
 *
 * Thin wrapper providing a consistent interface for both CLI and MCP.
 *
 * Phase 3, Task 3.4 implementation.
 */

import type Database from "better-sqlite3";
import type { RelationshipType, ExploreResult } from "../../graph/types.js";
import { exploreEntity, exploreSelective } from "../../graph/search.js";
import type { SelectiveExploreOptions, SelectiveExploreResult } from "../../graph/search.js";

// ─── Types ──────────────────────────────────────────────────────

export interface ExploreParams {
  entity: string;
  depth?: number;
  limit?: number;
  relationshipTypes?: RelationshipType[];
}

// ─── Core Operation ─────────────────────────────────────────────

/**
 * Explore entity connections in the knowledge graph.
 *
 * Wraps exploreEntity() with interface-layer defaults.
 * Default depth: 1. Default limit: 25.
 */
export function explore(
  db: Database.Database,
  params: ExploreParams,
): ExploreResult {
  return exploreEntity(db, {
    entity: params.entity,
    depth: params.depth ?? 1,
    limit: params.limit ?? 25,
    relationshipTypes: params.relationshipTypes,
  });
}

// ─── Selective Explore ───────────────────────────────────────────

export interface ExploreSelectiveParams {
  entity: string;
  criteria: string;
  maxDepth?: number;
  maxNodes?: number;
  relationshipTypes?: RelationshipType[];
}

/**
 * Criteria-driven selective graph exploration.
 *
 * Wraps exploreSelective() with interface-layer defaults.
 * Default maxDepth: 3. Default maxNodes: 50.
 */
export async function exploreSelectiveEntity(
  db: Database.Database,
  params: ExploreSelectiveParams,
): Promise<SelectiveExploreResult> {
  return exploreSelective(db, {
    entityName: params.entity,
    criteria: params.criteria,
    maxDepth: params.maxDepth ?? 3,
    maxNodes: params.maxNodes ?? 50,
    relationshipTypes: params.relationshipTypes,
  });
}

export type { ExploreResult, SelectiveExploreResult };
