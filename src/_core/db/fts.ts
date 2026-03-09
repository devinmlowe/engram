/**
 * FTS5 full-text search helpers.
 *
 * Handles rebuild, sync (delete old + insert new), and basic search
 * against FTS5 virtual tables.
 */

import type Database from "better-sqlite3";

/**
 * Rebuild an FTS5 index from its content table.
 * Call after bulk inserts to sync the FTS index.
 */
export function rebuildFts(
  db: Database.Database,
  ftsTable: string,
): void {
  db.exec(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('rebuild')`);
}

/**
 * Insert a row into an FTS5 index by rowid.
 * The columns should match the FTS5 table definition.
 */
export function insertFtsRow(
  db: Database.Database,
  ftsTable: string,
  rowid: number,
  columns: Record<string, unknown>,
): void {
  const colNames = Object.keys(columns);
  const placeholders = ["?", ...colNames.map(() => "?")].join(", ");
  const values = [rowid, ...colNames.map((c) => columns[c])];

  db.prepare(
    `INSERT INTO ${ftsTable}(rowid, ${colNames.join(", ")}) VALUES (${placeholders})`,
  ).run(...values);
}

/**
 * Delete a row from an FTS5 index using the FTS5 delete command.
 * The column values must match the currently indexed content.
 */
export function deleteFtsRow(
  db: Database.Database,
  ftsTable: string,
  rowid: number,
  columns: Record<string, unknown>,
): void {
  const colNames = Object.keys(columns);
  const placeholders = ["'delete'", "?", ...colNames.map(() => "?")].join(", ");
  const values = [rowid, ...colNames.map((c) => columns[c])];

  db.prepare(
    `INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colNames.join(", ")}) VALUES (${placeholders})`,
  ).run(...values);
}

/**
 * Sync an FTS5 entry: delete old values, insert new values.
 * Use when updating content in the source table.
 */
export function syncFts(
  db: Database.Database,
  ftsTable: string,
  rowid: number,
  oldColumns: Record<string, unknown>,
  newColumns: Record<string, unknown>,
): void {
  deleteFtsRow(db, ftsTable, rowid, oldColumns);
  insertFtsRow(db, ftsTable, rowid, newColumns);
}
