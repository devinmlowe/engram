import type Database from "better-sqlite3";

/**
 * Idempotent migration: adds conversation_count and informativeness
 * columns to the entities table for Entity-IDF scoring.
 */
export function migrateInformativenessColumns(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));

  db.transaction(() => {
    if (!colNames.has("conversation_count")) {
      db.exec("ALTER TABLE entities ADD COLUMN conversation_count INTEGER DEFAULT 0");
    }
    if (!colNames.has("informativeness")) {
      db.exec("ALTER TABLE entities ADD COLUMN informativeness REAL DEFAULT 0");
    }
  })();
}
