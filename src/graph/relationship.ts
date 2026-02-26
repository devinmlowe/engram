/**
 * Relationship CRUD operations with weight management.
 *
 * All multi-table write operations are transactional. The weight
 * computation uses a multi-factor formula aligned with FSRS decay
 * characteristics for recency scoring.
 *
 * Follows the same patterns established in src/semantic/memory.ts.
 */

import type Database from "better-sqlite3";
import type { Relationship, RelationshipType } from "../core/types.js";
import type { EdgeWeightFactors } from "./types.js";

// ─── Row Type Helpers ───────────────────────────────────────────

interface RelationshipRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  type: string;
  weight: number;
  context: string | null;
  source_memories: string | null;
  created_at: number;
  updated_at: number | null;
}

function rowToRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    type: row.type as RelationshipType,
    weight: row.weight,
    context: row.context ?? undefined,
    sourceMemories: row.source_memories
      ? JSON.parse(row.source_memories)
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  };
}

// ─── Relationship CRUD ──────────────────────────────────────────

/**
 * Insert a relationship. Uses INSERT OR IGNORE to respect any
 * UNIQUE constraints without throwing on duplicates.
 */
export function insertRelationship(
  db: Database.Database,
  rel: Relationship,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO relationships
      (id, source_entity_id, target_entity_id, type, weight, context,
       source_memories, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rel.id,
    rel.sourceEntityId,
    rel.targetEntityId,
    rel.type,
    rel.weight,
    rel.context ?? null,
    JSON.stringify(rel.sourceMemories),
    rel.createdAt,
    rel.updatedAt ?? null,
  );
}

/**
 * Update specified fields of a relationship. Always sets updated_at.
 */
export function updateRelationship(
  db: Database.Database,
  id: string,
  updates: Partial<Relationship>,
): void {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.weight !== undefined) {
    setClauses.push("weight = ?");
    values.push(updates.weight);
  }
  if (updates.context !== undefined) {
    setClauses.push("context = ?");
    values.push(updates.context ?? null);
  }
  if (updates.sourceMemories !== undefined) {
    setClauses.push("source_memories = ?");
    values.push(JSON.stringify(updates.sourceMemories));
  }
  if (updates.type !== undefined) {
    setClauses.push("type = ?");
    values.push(updates.type);
  }

  // Always update updated_at
  setClauses.push("updated_at = unixepoch()");

  if (setClauses.length > 0) {
    values.push(id);
    db.prepare(
      `UPDATE relationships SET ${setClauses.join(", ")} WHERE id = ?`,
    ).run(...values);
  }
}

/**
 * Get a single relationship by ID.
 */
export function getRelationship(
  db: Database.Database,
  id: string,
): Relationship | null {
  const row = db
    .prepare("SELECT * FROM relationships WHERE id = ?")
    .get(id) as RelationshipRow | undefined;

  if (!row) return null;
  return rowToRelationship(row);
}

/**
 * Get all relationships for an entity (both incoming and outgoing).
 */
export function getRelationshipsForEntity(
  db: Database.Database,
  entityId: string,
): Relationship[] {
  const rows = db
    .prepare(
      "SELECT * FROM relationships WHERE source_entity_id = ? OR target_entity_id = ?",
    )
    .all(entityId, entityId) as RelationshipRow[];

  return rows.map(rowToRelationship);
}

/**
 * Get all relationships between two specific entities (in either direction).
 */
export function getRelationshipsBetween(
  db: Database.Database,
  entityA: string,
  entityB: string,
): Relationship[] {
  const rows = db
    .prepare(`
      SELECT * FROM relationships
      WHERE (source_entity_id = ? AND target_entity_id = ?)
         OR (source_entity_id = ? AND target_entity_id = ?)
    `)
    .all(entityA, entityB, entityB, entityA) as RelationshipRow[];

  return rows.map(rowToRelationship);
}

/**
 * Find an existing relationship or create a new one. This is the primary
 * write entry point for relationships.
 *
 * If an edge with the same (source, target, type) exists:
 *   - Appends memoryId to source_memories (if provided and not already present)
 *   - Updates updated_at
 *
 * If no matching edge exists:
 *   - Creates a new relationship
 */
export function findOrCreateRelationship(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  type: RelationshipType,
  context?: string,
  memoryId?: string,
): Relationship {
  const run = db.transaction(() => {
    // Check for existing edge
    const existing = db
      .prepare(`
        SELECT * FROM relationships
        WHERE source_entity_id = ? AND target_entity_id = ? AND type = ?
      `)
      .get(sourceId, targetId, type) as RelationshipRow | undefined;

    if (existing) {
      // Append memoryId to source_memories if not already present
      if (memoryId) {
        const memories: string[] = existing.source_memories
          ? JSON.parse(existing.source_memories)
          : [];

        if (!memories.includes(memoryId)) {
          memories.push(memoryId);
          db.prepare(
            "UPDATE relationships SET source_memories = ?, updated_at = unixepoch() WHERE id = ?",
          ).run(JSON.stringify(memories), existing.id);
        }
      } else {
        db.prepare(
          "UPDATE relationships SET updated_at = unixepoch() WHERE id = ?",
        ).run(existing.id);
      }

      // Return the updated relationship
      return db
        .prepare("SELECT * FROM relationships WHERE id = ?")
        .get(existing.id) as RelationshipRow;
    }

    // Create new relationship
    const id = `rel-${Math.random().toString(36).slice(2, 10)}`;
    const now = Math.floor(Date.now() / 1000);
    const sourceMemories = memoryId ? [memoryId] : [];

    db.prepare(`
      INSERT INTO relationships
        (id, source_entity_id, target_entity_id, type, weight, context,
         source_memories, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sourceId,
      targetId,
      type,
      1.0,
      context ?? null,
      JSON.stringify(sourceMemories),
      now,
      null,
    );

    return db
      .prepare("SELECT * FROM relationships WHERE id = ?")
      .get(id) as RelationshipRow;
  });

  const row = run();
  return rowToRelationship(row);
}

/**
 * Update the weight of a relationship.
 */
export function updateRelationshipWeight(
  db: Database.Database,
  id: string,
  weight: number,
): void {
  db.prepare(
    "UPDATE relationships SET weight = ?, updated_at = unixepoch() WHERE id = ?",
  ).run(weight, id);
}

// ─── Weight Computation ─────────────────────────────────────────

/**
 * Compute a multi-factor edge weight using the following formula:
 *
 *   freq(35%):    log2(1 + mentionCount) / log2(11)  -- normalized to ~1.0 at 10 mentions
 *   recency(25%): 0.9 ^ (daysSinceLastSeen / 90)    -- aligned with FSRS decay
 *   conf(20%):    confidence                          -- direct passthrough
 *   imp(20%):     (sourceImportance + targetImportance) / 2
 *
 *   weight = 0.35*freq + 0.25*recency + 0.20*conf + 0.20*imp
 *
 * Floored at 0.01 to prevent zero-weight edges.
 */
export function computeEdgeWeight(
  factors: EdgeWeightFactors,
  now?: number,
): number {
  const currentTime = now ?? Math.floor(Date.now() / 1000);

  // Frequency: log2(1 + mentionCount) / log2(11), capped at 1.0
  const freq = Math.min(
    Math.log2(1 + factors.mentionCount) / Math.log2(11),
    1.0,
  );

  // Recency: 0.9 ^ (daysSinceLastSeen / 90)
  const daysSince = (currentTime - factors.lastSeen) / 86400;
  const recency = Math.pow(0.9, daysSince / 90);

  // Confidence: direct passthrough, clamped to [0, 1]
  const conf = Math.max(0, Math.min(1, factors.confidence));

  // Importance: average of source and target, clamped to [0, 1]
  const imp = Math.max(
    0,
    Math.min(1, (factors.sourceImportance + factors.targetImportance) / 2),
  );

  // Weighted combination
  const weight = 0.35 * freq + 0.25 * recency + 0.20 * conf + 0.20 * imp;

  // Floor at 0.01
  return Math.max(0.01, weight);
}
