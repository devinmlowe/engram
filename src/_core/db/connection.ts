/**
 * Database connection management — singleton pattern with lazy init.
 *
 * Provides `getDatabase()` as the single entry point for obtaining a DB
 * connection, replacing direct `initDatabase()` calls in consumers.
 */

import type Database from "better-sqlite3";
import type { EngramConfig } from "../types/index.js";
import { loadConfig } from "../config/index.js";
import { initDatabase } from "./schema.js";

// ─── Singleton State ─────────────────────────────────────────────

let _db: Database.Database | null = null;
let _config: EngramConfig | null = null;

/**
 * Get (or create) the singleton database connection.
 *
 * On first call, loads config and initializes the database.
 * Subsequent calls return the same connection.
 *
 * @param config - Optional config override. If not provided, uses loadConfig().
 */
export function getDatabase(config?: EngramConfig): Database.Database {
  if (_db) return _db;

  _config = config ?? loadConfig();
  _db = initDatabase(_config);
  return _db;
}

/**
 * Close the singleton database connection and reset state.
 * Safe to call even if no connection exists.
 */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
    _config = null;
  }
}

/**
 * Reset singleton state without closing. Used in tests to allow
 * a fresh getDatabase() call after manual db.close().
 */
export function resetDatabaseState(): void {
  _db = null;
  _config = null;
}

/**
 * Execute a function within a SQLite transaction.
 * Automatically commits on success, rolls back on error.
 *
 * @param db - Database connection
 * @param fn - Function to execute within the transaction
 * @returns The return value of fn
 */
export function withTransaction<T>(
  db: Database.Database,
  fn: () => T,
): T {
  const wrapped = db.transaction(fn);
  return wrapped();
}
