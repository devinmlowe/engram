/**
 * Retroactive cleanup of blocked entities from the knowledge graph.
 *
 * Removes entities whose names match the extraction blocklist,
 * along with their relationships and other dependent records.
 */

import type Database from "better-sqlite3";
import { isBlockedEntityName } from "./extractor.js";

/**
 * Remove all entities whose names match the blocklist, along with
 * their relationships, FTS entries, and vector embeddings.
 * Returns the number of entities removed.
 */
export function cleanBlockedEntities(db: Database.Database): number {
  // Find all blocked entity IDs
  const allEntities = db.prepare("SELECT id, name FROM entities").all() as Array<{ id: string; name: string }>;
  const blockedIds = allEntities
    .filter(e => isBlockedEntityName(e.name))
    .map(e => e.id);

  if (blockedIds.length === 0) return 0;

  const tx = db.transaction(() => {
    for (const id of blockedIds) {
      // Remove relationships referencing this entity
      db.prepare("DELETE FROM relationships WHERE source_entity_id = ? OR target_entity_id = ?").run(id, id);
      // Remove from entity_conversations if table exists
      try { db.prepare("DELETE FROM entity_conversations WHERE entity_id = ?").run(id); } catch {}
      // Remove from bridge_scores
      try { db.prepare("DELETE FROM bridge_scores WHERE entity_id = ?").run(id); } catch {}
      // Remove entity
      db.prepare("DELETE FROM entities WHERE id = ?").run(id);
    }
  });

  tx();
  return blockedIds.length;
}
