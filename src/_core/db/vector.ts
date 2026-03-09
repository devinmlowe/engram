/**
 * Vector (vec0) helpers for embedding storage and similarity search.
 *
 * Handles the Float32Array → Buffer conversion required by sqlite-vec.
 * vec0 virtual tables don't support UPDATE, so inserts always delete first.
 */

import type Database from "better-sqlite3";

/**
 * Convert a number[] embedding to the Buffer format expected by vec0.
 */
function toVecBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/**
 * Insert (or replace) a vector embedding.
 * vec0 doesn't support UPDATE or REPLACE, so we delete then insert.
 */
export function insertVector(
  db: Database.Database,
  table: string,
  id: string,
  embedding: number[],
): void {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  db.prepare(
    `INSERT INTO ${table}(id, embedding) VALUES (?, ?)`,
  ).run(id, toVecBuffer(embedding));
}

/**
 * Search for nearest vectors by cosine/L2 distance.
 * Returns results ordered by distance ascending.
 */
export function searchVector(
  db: Database.Database,
  table: string,
  queryEmbedding: number[],
  limit: number,
): Array<{ id: string; distance: number }> {
  return db
    .prepare(
      `SELECT id, distance FROM ${table} WHERE embedding MATCH ? AND k = ? ORDER BY distance ASC`,
    )
    .all(toVecBuffer(queryEmbedding), limit) as Array<{
    id: string;
    distance: number;
  }>;
}

/**
 * Delete a vector by ID.
 */
export function deleteVector(
  db: Database.Database,
  table: string,
  id: string,
): void {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}
