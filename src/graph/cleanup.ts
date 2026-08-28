/**
 * Retroactive cleanup of blocked entities from the knowledge graph.
 *
 * Removes entities whose names match the extraction blocklist,
 * along with their relationships and other dependent records.
 */

import type Database from "better-sqlite3";
import { isBlockedEntityName } from "./extractor.js";
import { deleteEntityCascade } from "./entity.js";

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
      deleteEntityCascade(db, id);
    }
  });

  tx();
  return blockedIds.length;
}
