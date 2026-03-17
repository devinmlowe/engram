/**
 * Backfill entity_conversations junction table from historical exchange data.
 *
 * Strategy: For each entity, use FTS5 search on exchanges to find conversations
 * that mention the entity name. Falls back to LIKE search if FTS is unavailable.
 *
 * This is idempotent — uses INSERT OR IGNORE.
 */

import type Database from "better-sqlite3";

export function backfillEntityConversations(
  db: Database.Database,
): { linked: number; entities: number; skipped: number } {
  const entities = db.prepare(
    "SELECT id, name FROM entities WHERE length(name) > 2 ORDER BY mention_count DESC"
  ).all() as Array<{ id: string; name: string }>;

  // Check if FTS table exists AND has a working index.
  // Content-external FTS5 tables may exist but have an empty index
  // if rebuild has not been run. We probe with a dummy MATCH to verify.
  const ftsTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='exchanges_fts'"
  ).get();
  let hasFts = false;
  if (ftsTable) {
    try {
      // Try a MATCH that should return rows if index is populated.
      // If the FTS index is empty, MATCH returns nothing even though
      // content table has rows — so we fall back to LIKE.
      const probe = db.prepare(
        "SELECT rowid FROM exchanges_fts WHERE exchanges_fts MATCH '*' LIMIT 1"
      ).get();
      hasFts = !!probe;
    } catch {
      hasFts = false;
    }
  }

  const insert = db.prepare(
    "INSERT OR IGNORE INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)"
  );

  let linked = 0;
  let skipped = 0;

  // Use FTS5 MATCH for speed, falling back to LIKE
  const searchFts = hasFts
    ? db.prepare(`
        SELECT DISTINCT e.conversation_id
        FROM exchanges_fts fts
        JOIN exchanges e ON e.rowid = fts.rowid
        WHERE exchanges_fts MATCH ?
      `)
    : null;

  const searchLike = db.prepare(`
    SELECT DISTINCT conversation_id
    FROM exchanges
    WHERE user_message LIKE ? OR assistant_message LIKE ?
  `);

  db.transaction(() => {
    for (const entity of entities) {
      try {
        let conversations: Array<{ conversation_id: string }>;

        if (searchFts) {
          // FTS5 query — quote the name to handle special chars
          const ftsQuery = '"' + entity.name.replace(/"/g, '""') + '"';
          conversations = searchFts.all(ftsQuery) as Array<{ conversation_id: string }>;
        } else {
          const pattern = "%" + entity.name + "%";
          conversations = searchLike.all(pattern, pattern) as Array<{ conversation_id: string }>;
        }

        for (const conv of conversations) {
          if (conv.conversation_id) {
            insert.run(entity.id, conv.conversation_id);
            linked++;
          }
        }
      } catch {
        skipped++;
      }
    }
  })();

  return { linked, entities: entities.length, skipped };
}
