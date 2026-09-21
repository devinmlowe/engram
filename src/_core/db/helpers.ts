/**
 * Thin typed query helpers for common CRUD patterns.
 *
 * These are simple wrappers around db.prepare().run/get/all.
 * Complex queries (JOINs, subqueries, FTS5 MATCH, CTEs) should
 * remain as raw SQL in the domain modules.
 */

import type Database from "better-sqlite3";

/**
 * Get a single row by ID from a table.
 */
export function getById<T = Record<string, unknown>>(
  db: Database.Database,
  table: string,
  id: string,
): T | undefined {
  return db
    .prepare(`SELECT * FROM ${table} WHERE id = ?`)
    .get(id) as T | undefined;
}

/**
 * Insert a row into a table. Column names are derived from the data object keys.
 * Values are passed as positional parameters.
 */
export function insertRow(
  db: Database.Database,
  table: string,
  data: Record<string, unknown>,
): Database.RunResult {
  const columns = Object.keys(data);
  const placeholders = columns.map(() => "?").join(", ");
  const values = columns.map((col) => data[col]);

  return db
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    )
    .run(...values);
}

/**
 * Count rows in a table with optional WHERE clause.
 */
export function count(
  db: Database.Database,
  table: string,
  where?: Record<string, unknown>,
): number {
  let sql = `SELECT COUNT(*) as count FROM ${table}`;
  const params: unknown[] = [];

  if (where && Object.keys(where).length > 0) {
    const clauses = Object.keys(where).map((col) => {
      params.push(where[col]);
      return `${col} = ?`;
    });
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }

  const result = db.prepare(sql).get(...params) as { count: number };
  return result.count;
}
