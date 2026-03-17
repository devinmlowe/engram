import type Database from "better-sqlite3";

/**
 * Idempotent migration: adds conversation_count and informativeness
 * columns to the entities table for Entity-IDF scoring.
 */
export function migrateInformativenessColumns(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));

  db.transaction(() => {
    // Create junction table for entity-conversation tracking (idempotent)
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_conversations (
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        first_mentioned INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (entity_id, conversation_id)
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_ec_entity ON entity_conversations(entity_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_ec_conversation ON entity_conversations(conversation_id)");

    // Add columns to entities table
    if (!colNames.has("conversation_count")) {
      db.exec("ALTER TABLE entities ADD COLUMN conversation_count INTEGER DEFAULT 0");
    }
    if (!colNames.has("informativeness")) {
      db.exec("ALTER TABLE entities ADD COLUMN informativeness REAL DEFAULT 0");
    }
  })();
}
