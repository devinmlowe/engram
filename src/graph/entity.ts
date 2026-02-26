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
import type { Entity, EntityType } from "../core/types.js";

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
 */
export function insertEntity(
  db: Database.Database,
  entity: Entity,
  embedding: number[],
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
        db.prepare(
          "INSERT INTO entities_fts(rowid, name, description) VALUES (?, ?, ?)",
        ).run(row.rowid, entity.name, entity.description ?? null);
      }
    }

    // 3. Insert into vec_entities (delete first — vec0 doesn't support REPLACE)
    db.prepare("DELETE FROM vec_entities WHERE id = ?").run(entity.id);
    db.prepare(
      "INSERT INTO vec_entities(id, embedding) VALUES (?, ?)",
    ).run(entity.id, Buffer.from(new Float32Array(embedding).buffer));
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
      db.prepare(
        "INSERT INTO entities_fts(entities_fts, rowid, name, description) VALUES('delete', ?, ?, ?)",
      ).run(existing.rowid, existing.name, existing.description);
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

      db.prepare(
        "INSERT INTO entities_fts(rowid, name, description) VALUES (?, ?, ?)",
      ).run(existing.rowid, newName, newDescription);
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
  const run = db.transaction(() => {
    db.prepare("DELETE FROM vec_entities WHERE id = ?").run(id);
    db.prepare(
      "INSERT INTO vec_entities(id, embedding) VALUES (?, ?)",
    ).run(id, Buffer.from(new Float32Array(embedding).buffer));
  });

  run();
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
  const row = db
    .prepare("SELECT * FROM entities WHERE lower(name) = lower(?)")
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

    // 1. Repoint relationships where source = mergeId
    db.prepare(
      "UPDATE relationships SET source_entity_id = ? WHERE source_entity_id = ?",
    ).run(keepId, mergeId);

    // 2. Repoint relationships where target = mergeId
    db.prepare(
      "UPDATE relationships SET target_entity_id = ? WHERE target_entity_id = ?",
    ).run(keepId, mergeId);

    // 3. Deduplicate edges: for each (source, target, type) group with duplicates,
    //    keep the one with higher weight and delete the rest
    const duplicates = db
      .prepare(`
        SELECT source_entity_id, target_entity_id, type, COUNT(*) as cnt
        FROM relationships
        WHERE source_entity_id = ? OR target_entity_id = ?
        GROUP BY source_entity_id, target_entity_id, type
        HAVING cnt > 1
      `)
      .all(keepId, keepId) as Array<{
      source_entity_id: string;
      target_entity_id: string;
      type: string;
      cnt: number;
    }>;

    for (const dup of duplicates) {
      // Get all edges in this group, sorted by weight desc
      const edges = db
        .prepare(`
          SELECT id, weight FROM relationships
          WHERE source_entity_id = ? AND target_entity_id = ? AND type = ?
          ORDER BY weight DESC
        `)
        .all(dup.source_entity_id, dup.target_entity_id, dup.type) as Array<{
        id: string;
        weight: number;
      }>;

      // Delete all but the first (highest weight)
      for (let i = 1; i < edges.length; i++) {
        db.prepare("DELETE FROM relationships WHERE id = ?").run(edges[i].id);
      }
    }

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
    const ftsExists = hasFtsTable(db);
    if (ftsExists) {
      const mergeRowid = db
        .prepare("SELECT rowid FROM entities WHERE id = ?")
        .get(mergeId) as { rowid: number } | undefined;

      if (mergeRowid) {
        db.prepare(
          "INSERT INTO entities_fts(entities_fts, rowid, name, description) VALUES('delete', ?, ?, ?)",
        ).run(mergeRowid.rowid, mergeRow.name, mergeRow.description);
      }
    }

    db.prepare("DELETE FROM vec_entities WHERE id = ?").run(mergeId);
    db.prepare("DELETE FROM entities WHERE id = ?").run(mergeId);
  });

  run();
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
  const queryBuf = Buffer.from(new Float32Array(embedding).buffer);

  const results = db
    .prepare(
      "SELECT id, distance FROM vec_entities WHERE embedding MATCH ? AND k = ?",
    )
    .all(queryBuf, limit) as Array<{ id: string; distance: number }>;

  return results;
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

  const rows = db
    .prepare(`
      SELECT e.* FROM entities e
      JOIN entities_fts fts ON e.rowid = fts.rowid
      WHERE entities_fts MATCH ?
      LIMIT ?
    `)
    .all(query, limit) as EntityRow[];

  return rows.map(rowToEntity);
}
