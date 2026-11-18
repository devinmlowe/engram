/**
 * eval/src/store.ts — store-path resolution, usability guard, read-only open.
 *
 * SPEC-001: resolution goes through Engram's own config logic
 * (src/_core/config/index.ts) or an explicit --db flag; assertUsableStore
 * hard-fails with StoreGuardError on missing / 0-byte / non-SQLite files.
 * SPEC-003: openStoreReadonly is the single open path every suite uses,
 * pinned to better-sqlite3 `{ readonly: true }` + the sqlite-vec extension.
 */

import { statSync, openSync, readSync, closeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { resolveDefaultDataDir } from "../../src/_core/config/index.js";

/** Raised when the resolved store is not a usable SQLite database. */
export class StoreGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreGuardError";
  }
}

const SQLITE_HEADER = "SQLite format 3\0";

export interface ResolveStorePathOptions {
  /** Explicit --db flag; wins over environment resolution. */
  dbFlag?: string;
  /** Environment used for Engram's own default-data-dir resolution. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the store path the same way Engram itself does: --db wins, then
 * Engram's config logic (ENGRAM_DATA_DIR / XDG semantics → <dataDir>/engram.db).
 */
export function resolveStorePath(options: ResolveStorePathOptions = {}): string {
  if (options.dbFlag) {
    const db = options.dbFlag;
    return isAbsolute(db) ? db : resolve(db);
  }
  const env = options.env ?? process.env;
  // Same precedence as Engram's loadConfig(): ENGRAM_DATA_DIR first, then
  // resolveDefaultDataDir (XDG semantics → historical ~/.local/share/engram).
  const trimmed = env.ENGRAM_DATA_DIR?.trim();
  const dataDir = trimmed && trimmed.length > 0 ? trimmed : resolveDefaultDataDir(env);
  return join(dataDir, "engram.db");
}

/** Assert the file at `path` is a present, non-empty, real SQLite database. */
export function assertUsableStore(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new StoreGuardError(`store not found (missing): ${path}`);
  }
  if (size === 0) {
    throw new StoreGuardError(`store is 0 bytes (empty): ${path}`);
  }
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    const read = readSync(fd, buf, 0, 16, 0);
    if (read < 16 || !buf.equals(Buffer.from(SQLITE_HEADER, "utf8"))) {
      throw new StoreGuardError(
        `store is not a SQLite database (bad header): ${path}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Open a SQLite store strictly read-only. This is the one open path all
 * suites share (SPEC-003 pin): better-sqlite3 `readonly: true` — writes throw.
 */
export function openStoreReadonly(path: string): Database.Database {
  assertUsableStore(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    sqliteVec.load(db);
  } catch (err) {
    db.close();
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `eval: failed to load the sqlite-vec extension for ` +
        `${process.platform}-${process.arch}: ${detail}`,
    );
  }
  return db;
}
