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
 * Get all rows from a table with optional WHERE clause and ORDER BY.
 *
 * @param where - Object of column=value conditions (AND'd together)
 * @param orderBy - e.g. "created_at DESC"
 */
export function getAll<T = Record<string, unknown>>(
  db: Database.Database,
  table: string,
  where?: Record<string, unknown>,
  orderBy?: string,
): T[] {
  let sql = `SELECT * FROM ${table}`;
  const params: unknown[] = [];

  if (where && Object.keys(where).length > 0) {
    const clauses = Object.keys(where).map((col) => {
      params.push(where[col]);
      return `${col} = ?`;
    });
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }

  if (orderBy) {
    sql += ` ORDER BY ${orderBy}`;
  }

  return db.prepare(sql).all(...params) as T[];
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
 * Update a row by ID. Only the provided fields are updated.
 */
export function updateRow(
  db: Database.Database,
  table: string,
  id: string,
  data: Record<string, unknown>,
): Database.RunResult {
  const columns = Object.keys(data);
  const setClauses = columns.map((col) => `${col} = ?`);
  const values = columns.map((col) => data[col]);
  values.push(id);

  return db
    .prepare(
      `UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = ?`,
    )
    .run(...values);
}

/**
 * Upsert a row using INSERT OR REPLACE.
 * The entire row is replaced on conflict with the specified columns.
 */
export function upsertRow(
  db: Database.Database,
  table: string,
  data: Record<string, unknown>,
  conflictColumns: string[],
): Database.RunResult {
  const columns = Object.keys(data);
  const placeholders = columns.map(() => "?").join(", ");
  const values = columns.map((col) => data[col]);

  const updateCols = columns.filter((c) => !conflictColumns.includes(c));
  const updateClauses = updateCols.map((col) => `${col} = excluded.${col}`);

  if (updateClauses.length === 0) {
    // Pure insert-or-ignore
    return db
      .prepare(
        `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
      )
      .run(...values);
  }

  return db
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(${conflictColumns.join(", ")}) DO UPDATE SET ${updateClauses.join(", ")}`,
    )
    .run(...values);
}

/**
 * Delete a row by ID.
 */
export function deleteRow(
  db: Database.Database,
  table: string,
  id: string,
): Database.RunResult {
  return db
    .prepare(`DELETE FROM ${table} WHERE id = ?`)
    .run(id);
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
