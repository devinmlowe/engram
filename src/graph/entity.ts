/**
 * Entity CRUD operations with FTS5 and vec0 sync.
 *
 * All multi-table write operations are transactional — inserts, updates,
 * and merges atomically sync the entities table, entities_fts (full-text
 * search, when present), and vec_entities (vector similarity) tables.
 *
 * Follows the same patterns established in src/semantic/memory.ts.
 */

import type Database from "better-sqlite3";
import type { Entity, EntityType } from "./types.js";
import {
  insertVector,
  searchVector,
  deleteVector,
  insertFtsRow,
  deleteFtsRow,
} from "../_core/db/index.js";

// ─── Row Type Helpers ───────────────────────────────────────────

interface EntityRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
  aliases: string | null;
  first_seen: number | null;
  last_seen: number | null;
  mention_count: number;
  created_at: number;
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    name: row.name,
    type: row.type as EntityType,
    description: row.description ?? undefined,
    aliases: row.aliases ? JSON.parse(row.aliases) : [],
    firstSeen: row.first_seen ?? row.created_at,
    lastSeen: row.last_seen ?? row.created_at,
    mentionCount: row.mention_count,
    createdAt: row.created_at,
  };
}

/**
 * Check whether the entities_fts table exists in the database.
 * Stream D will add this table; until then, FTS operations are skipped.
 */
function hasFtsTable(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entities_fts'",
    )
    .get();
  return !!row;
}

// ─── Entity CRUD ────────────────────────────────────────────────

/**
 * Insert an entity with its embedding, syncing entities, entities_fts
 * (when present), and vec_entities tables atomically.
 *
 * Pass `null` for entities that must not take part in vector search
 * (file-structure entities): a zero vector is NOT neutral — it sits at L2
 * distance 1.0 from every unit query, ahead of most real entities.
 */
export function insertEntity(
  db: Database.Database,
  entity: Entity,
  embedding: number[] | null,
): void {
  const run = db.transaction(() => {
    // 1. Insert into entities table
    db.prepare(`
      INSERT INTO entities
        (id, name, type, description, aliases, first_seen, last_seen,
         mention_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entity.id,
      entity.name,
      entity.type,
      entity.description ?? null,
      JSON.stringify(entity.aliases),
      entity.firstSeen,
      entity.lastSeen,
      entity.mentionCount,
      entity.createdAt,
    );

    // 2. Insert into FTS5 if the table exists
    if (hasFtsTable(db)) {
      const row = db
        .prepare("SELECT rowid FROM entities WHERE id = ?")
        .get(entity.id) as { rowid: number } | undefined;

      if (row) {
        insertFtsRow(db, "entities_fts", row.rowid, {
          name: entity.name,
          description: entity.description ?? null,
        });
      }
    }

    // 3. Insert into vec_entities (delete first — vec0 doesn't support REPLACE)
    if (embedding) {
      insertVector(db, "vec_entities", entity.id, embedding);
    } else {
      deleteVector(db, "vec_entities", entity.id);
    }
  });

  run();
}

/**
 * Update specified fields of an entity. If name or description changes,
 * the FTS5 index is resynced (delete old + insert new).
 */
export function updateEntity(
  db: Database.Database,
  id: string,
  updates: Partial<Entity>,
): void {
  const run = db.transaction(() => {
    // Fetch current state for FTS sync
    const existing = db
      .prepare("SELECT rowid, name, description FROM entities WHERE id = ?")
      .get(id) as
      | { rowid: number; name: string; description: string | null }
      | undefined;

    if (!existing) return;

    const ftsExists = hasFtsTable(db);
    const needsFtsSync =
      ftsExists &&
      (updates.name !== undefined || updates.description !== undefined);

    // If name or description changed, delete old FTS entry
    if (needsFtsSync) {
      deleteFtsRow(db, "entities_fts", existing.rowid, {
        name: existing.name,
        description: existing.description,
      });
    }

    // Build dynamic SET clause
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      values.push(updates.name);
    }
    if (updates.type !== undefined) {
      setClauses.push("type = ?");
      values.push(updates.type);
    }
    if (updates.description !== undefined) {
      setClauses.push("description = ?");
      values.push(updates.description ?? null);
    }
    if (updates.aliases !== undefined) {
      setClauses.push("aliases = ?");
      values.push(JSON.stringify(updates.aliases));
    }
    if (updates.firstSeen !== undefined) {
      setClauses.push("first_seen = ?");
      values.push(updates.firstSeen);
    }
    if (updates.lastSeen !== undefined) {
      setClauses.push("last_seen = ?");
      values.push(updates.lastSeen);
    }
    if (updates.mentionCount !== undefined) {
      setClauses.push("mention_count = ?");
      values.push(updates.mentionCount);
    }

    if (setClauses.length > 0) {
      values.push(id);
      db.prepare(
        `UPDATE entities SET ${setClauses.join(", ")} WHERE id = ?`,
      ).run(...values);
    }

    // If FTS needs sync, insert new entry
    if (needsFtsSync) {
      const newName = updates.name ?? existing.name;
      const newDescription =
        updates.description !== undefined
          ? (updates.description ?? null)
          : existing.description;

      insertFtsRow(db, "entities_fts", existing.rowid, {
        name: newName,
        description: newDescription,
      });
    }
  });

  run();
}

/**
 * Update the embedding for an entity in vec_entities.
 * Uses delete+insert because vec0 doesn't support UPDATE.
 */
export function updateEntityEmbedding(
  db: Database.Database,
  id: string,
  embedding: number[],
): void {
  // insertVector handles delete+insert atomically
  insertVector(db, "vec_entities", id, embedding);
}

/**
 * Get a single entity by ID.
 */
export function getEntity(
  db: Database.Database,
  id: string,
): Entity | null {
  const row = db
    .prepare("SELECT * FROM entities WHERE id = ?")
    .get(id) as EntityRow | undefined;

  if (!row) return null;
  return rowToEntity(row);
}

/**
 * Get an entity by name (case-insensitive).
 */
export function getEntityByName(
  db: Database.Database,
  name: string,
): Entity | null {
  // `name = ? COLLATE NOCASE` is satisfied by idx_entities_name_lower;
  // `lower(name) = lower(?)` forced a full scan on the dream hot path
  const row = db
    .prepare("SELECT * FROM entities WHERE name = ? COLLATE NOCASE")
    .get(name) as EntityRow | undefined;

  if (!row) return null;
  return rowToEntity(row);
}

/**
 * Get an entity by alias (case-insensitive).
 * Scans the JSON aliases array stored as a string.
 */
export function getEntityByAlias(
  db: Database.Database,
  alias: string,
): Entity | null {
  // Aliases are stored as JSON arrays, e.g. '["ts","TS"]'.
  // We use a LIKE pattern to find the alias within the JSON string.
  // The lower() call on both sides ensures case-insensitive matching.
  const row = db
    .prepare(
      `SELECT * FROM entities WHERE aliases LIKE '%"' || lower(?) || '"%'`,
    )
    .get(alias) as EntityRow | undefined;

  if (!row) return null;

  // Verify the alias actually matches case-insensitively in the parsed array
  // (the LIKE approach can have false positives with substring matches)
  const entity = rowToEntity(row);
  const lowerAlias = alias.toLowerCase();
  const found = entity.aliases.some((a) => a.toLowerCase() === lowerAlias);
  if (!found) return null;

  return entity;
}

/**
 * Get all entities, optionally filtered by type.
 */
export function getAllEntities(
  db: Database.Database,
  type?: EntityType,
): Entity[] {
  let rows: EntityRow[];

  if (type) {
    rows = db
      .prepare("SELECT * FROM entities WHERE type = ?")
      .all(type) as EntityRow[];
  } else {
    rows = db.prepare("SELECT * FROM entities").all() as EntityRow[];
  }

  return rows.map(rowToEntity);
}

/**
 * Record an entity mention — increments mention_count and updates last_seen.
 */
export function recordEntityMention(
  db: Database.Database,
  id: string,
): void {
  db.prepare(
    "UPDATE entities SET mention_count = mention_count + 1, last_seen = unixepoch() WHERE id = ?",
  ).run(id);
}

/**
 * Record that an entity appeared in a conversation.
 * Idempotent — INSERT OR IGNORE on the composite primary key.
 */
export function recordEntityConversation(
  db: Database.Database,
  entityId: string,
  conversationId: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)"
  ).run(entityId, conversationId);
}

/**
 * Merge two entities: keep one (keepId), transfer data from the other (mergeId),
 * and delete the merged entity. This is transactional and handles:
 * 1. Repointing relationships from mergeId to keepId
 * 2. Deduplicating edges (same source, target, type) keeping higher weight
 * 3. Transferring aliases from merged entity
 * 4. Adding merged entity's name as an alias of keep entity
 * 5. Summing mention counts
 * 6. Using min(first_seen), max(last_seen)
 * 7. Deleting merged entity from entities, entities_fts, vec_entities
 */
export function mergeEntities(
  db: Database.Database,
  keepId: string,
  mergeId: string,
): void {
  const run = db.transaction(() => {
    const keepRow = db
      .prepare("SELECT * FROM entities WHERE id = ?")
      .get(keepId) as EntityRow | undefined;
    const mergeRow = db
      .prepare("SELECT * FROM entities WHERE id = ?")
      .get(mergeId) as EntityRow | undefined;

    if (!keepRow || !mergeRow) return;

    const keepEntity = rowToEntity(keepRow);
    const mergeEntity = rowToEntity(mergeRow);

    // 1. Pre-dedup: delete merge entity's edges that would conflict with
    //    keep entity's existing edges after repointing (unique constraint).
    //    For each mergeId edge, check if keepId already has an equivalent edge
    //    (same target/source and type). If so, delete the lower-weight one.

    // Outgoing edges from mergeId that would conflict with keepId's outgoing
    const mergeOutgoing = db
      .prepare(
        "SELECT id, target_entity_id, type, weight FROM relationships WHERE source_entity_id = ?",
      )
      .all(mergeId) as Array<{ id: string; target_entity_id: string; type: string; weight: number }>;

    for (const edge of mergeOutgoing) {
      const keepEdge = db
        .prepare(
          "SELECT id, weight FROM relationships WHERE source_entity_id = ? AND target_entity_id = ? AND type = ?",
        )
        .get(keepId, edge.target_entity_id, edge.type) as { id: string; weight: number } | undefined;

      if (keepEdge) {
        // Conflict: delete the lower-weight edge
        if (edge.weight > keepEdge.weight) {
          db.prepare("DELETE FROM relationships WHERE id = ?").run(keepEdge.id);
        } else {
          db.prepare("DELETE FROM relationships WHERE id = ?").run(edge.id);
        }
      }
    }

    // Incoming edges to mergeId that would conflict with keepId's incoming
    const mergeIncoming = db
      .prepare(
        "SELECT id, source_entity_id, type, weight FROM relationships WHERE target_entity_id = ?",
      )
      .all(mergeId) as Array<{ id: string; source_entity_id: string; type: string; weight: number }>;

    for (const edge of mergeIncoming) {
      const keepEdge = db
        .prepare(
          "SELECT id, weight FROM relationships WHERE source_entity_id = ? AND target_entity_id = ? AND type = ?",
        )
        .get(edge.source_entity_id, keepId, edge.type) as { id: string; weight: number } | undefined;

      if (keepEdge) {
        // Conflict: delete the lower-weight edge
        if (edge.weight > keepEdge.weight) {
          db.prepare("DELETE FROM relationships WHERE id = ?").run(keepEdge.id);
        } else {
          db.prepare("DELETE FROM relationships WHERE id = ?").run(edge.id);
        }
      }
    }

    // 2. Repoint remaining relationships where source = mergeId
    db.prepare(
      "UPDATE relationships SET source_entity_id = ? WHERE source_entity_id = ?",
    ).run(keepId, mergeId);

    // 3. Repoint remaining relationships where target = mergeId
    db.prepare(
      "UPDATE relationships SET target_entity_id = ? WHERE target_entity_id = ?",
    ).run(keepId, mergeId);

    // 4. Transfer aliases from merged entity and add merged name as alias
    const combinedAliases = new Set([
      ...keepEntity.aliases.map((a) => a.toLowerCase()),
    ]);
    for (const alias of mergeEntity.aliases) {
      combinedAliases.add(alias.toLowerCase());
    }
    // Add the merged entity's name as an alias (if not already the keep name)
    if (mergeEntity.name.toLowerCase() !== keepEntity.name.toLowerCase()) {
      combinedAliases.add(mergeEntity.name.toLowerCase());
    }
    // Remove the keep entity's own name from aliases if present
    combinedAliases.delete(keepEntity.name.toLowerCase());

    const newAliases = Array.from(combinedAliases);

    // 5. Sum mention counts
    const newMentionCount =
      keepEntity.mentionCount + mergeEntity.mentionCount;

    // 6. Use min(first_seen), max(last_seen)
    const newFirstSeen = Math.min(keepEntity.firstSeen, mergeEntity.firstSeen);
    const newLastSeen = Math.max(keepEntity.lastSeen, mergeEntity.lastSeen);

    // Update keep entity
    db.prepare(`
      UPDATE entities SET
        aliases = ?,
        mention_count = ?,
        first_seen = ?,
        last_seen = ?
      WHERE id = ?
    `).run(
      JSON.stringify(newAliases),
      newMentionCount,
      newFirstSeen,
      newLastSeen,
      keepId,
    );

    // 7. Delete merged entity from all tables
    const mergeRowid = db
      .prepare("SELECT rowid FROM entities WHERE id = ?")
      .get(mergeId) as { rowid: number } | undefined;
    if (mergeRowid) {
      deleteEntityFtsRow(db, mergeRowid.rowid, mergeRow.name, mergeRow.description);
    }

    deleteVector(db, "vec_entities", mergeId);
    db.prepare("DELETE FROM entities WHERE id = ?").run(mergeId);
  });

  run();
}

/**
 * True if entities_fts actually indexes this row. entities_fts is an
 * external-content table: issuing the 'delete' command for a row that was
 * never indexed (raw insert, or inserted before the FTS table existed —
 * createFtsIfNeeded does not rebuild) corrupts the index.
 */
function ftsRowIndexed(
  db: Database.Database,
  rowid: number,
  name: string,
  description: string | null,
): boolean {
  for (const text of [name, description]) {
    if (!text || !text.trim()) continue;
    const phrase = `"${text.replace(/"/g, "")}"`;
    try {
      const hit = db
        .prepare("SELECT rowid FROM entities_fts WHERE entities_fts MATCH ? AND rowid = ?")
        .get(phrase, rowid);
      if (hit) return true;
    } catch {
      // unparseable phrase — try the other column
    }
  }
  return false;
}

/**
 * Remove an entity's tokens from entities_fts, but only when they are
 * provably there (see ftsRowIndexed).
 */
function deleteEntityFtsRow(
  db: Database.Database,
  rowid: number,
  name: string,
  description: string | null,
): void {
  if (!hasFtsTable(db)) return;
  if (!ftsRowIndexed(db, rowid, name, description)) return;
  deleteFtsRow(db, "entities_fts", rowid, { name, description });
}

/**
 * Delete an entity and everything that references it: relationships,
 * entity_conversations, bridge_scores (no ON DELETE CASCADE), its
 * entities_fts tokens and its vec_entities row. Runs in a transaction.
 *
 * A bare `DELETE FROM entities` leaves ghost ids in vector search, stale
 * FTS tokens under a rowid SQLite will reuse, and FK failures on bridge rows.
 */
export function deleteEntityCascade(
  db: Database.Database,
  id: string,
): boolean {
  const run = db.transaction((): boolean => {
    const row = db
      .prepare("SELECT rowid, name, description FROM entities WHERE id = ?")
      .get(id) as { rowid: number; name: string; description: string | null } | undefined;
    if (!row) return false;

    db.prepare(
      "DELETE FROM relationships WHERE source_entity_id = ? OR target_entity_id = ?",
    ).run(id, id);
    db.prepare("DELETE FROM entity_conversations WHERE entity_id = ?").run(id);
    db.prepare("DELETE FROM bridge_scores WHERE entity_id = ?").run(id);

    deleteEntityFtsRow(db, row.rowid, row.name, row.description);
    deleteVector(db, "vec_entities", id);
    db.prepare("DELETE FROM entities WHERE id = ?").run(id);
    return true;
  });

  return run();
}

// ─── Vector Search ──────────────────────────────────────────────

/**
 * Find the nearest entities by vector similarity.
 * Returns entities sorted by distance (ascending).
 */
export function findNearestEntities(
  db: Database.Database,
  embedding: number[],
  limit: number = 10,
): Array<{ id: string; distance: number }> {
  return searchVector(db, "vec_entities", embedding, limit);
}

// ─── Full-Text Search ───────────────────────────────────────────

/**
 * Search entities using FTS5 full-text search.
 * Returns empty array if entities_fts table does not exist.
 */
export function ftsSearchEntities(
  db: Database.Database,
  query: string,
  limit: number = 10,
): Entity[] {
  if (!hasFtsTable(db)) return [];

  // Same sanitizer as semantic/episodic FTS: strip quotes, quote each term,
  // OR-join — so punctuation in a user query can't become FTS5 syntax
  const sanitized = query
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" OR ");

  if (!sanitized) return [];

  try {
    const rows = db
      .prepare(`
        SELECT e.* FROM entities e
        JOIN entities_fts fts ON e.rowid = fts.rowid
        WHERE entities_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `)
      .all(sanitized, limit) as EntityRow[];

    return rows.map(rowToEntity);
  } catch {
    return [];
  }
}
