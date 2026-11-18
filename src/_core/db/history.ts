/**
 * memory_history — the append-only trigger-based audit trail over `memories`
 * (docs/memory-history.md, SPEC-001…012).
 *
 * This module owns the per-connection plumbing the triggers need:
 *
 * - `engram_sha256(text)` — sha256 hex of the UTF-8 bytes of a content value,
 *   called from inside the capture triggers. NULL in ⇒ NULL out, which is
 *   what pins the absent-content convention (an absent side is NULL in both
 *   the content and the hash column, never '' and never a digest of '').
 * - `engram_actor()` — the connection-scoped actor currently bracketed by
 *   `withHistoryActor`, or the sentinel `unknown` when no app-path context
 *   exists (dream prune, import, raw statements). Triggers cannot see app
 *   state, so this custom function is the only channel; it never fabricates
 *   an actor — an unstamped write records the sentinel, not a guessed name,
 *   and an actor never leaks past the bracket that set it.
 *
 * Retention of the trail itself is indefinite (see the migration's doc
 * comment in schema.ts); this file holds no purge or TTL path.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** Connection-scoped actor context (custom functions are per-connection). */
const actorByDb = new WeakMap<Database.Database, string>();

/** Sentinel stamped when no app-path actor context is bracketed. */
export const UNKNOWN_ACTOR = "unknown";

/**
 * Register the trigger-support custom functions on one connection. Called
 * from `initDatabase` on every open, before any statement can fire a
 * trigger. Idempotent on the connection (a re-register replaces).
 */
export function registerHistoryFunctions(db: Database.Database): void {
  db.function("engram_sha256", (content: string | null): string | null => {
    if (content === null) return null;
    return createHash("sha256").update(content, "utf8").digest("hex");
  });
  db.function("engram_actor", (): string => actorByDb.get(db) ?? UNKNOWN_ACTOR);
}

/**
 * Bracket a write with an actor context: the triggers on `memories` read
 * `engram_actor()` inside the same transaction `fn` runs, and the context is
 * always cleared afterwards — even on throw — so a later context-free write
 * on the same connection stamps the sentinel, never the previous actor.
 */
export function withHistoryActor<T>(
  db: Database.Database,
  actor: string,
  fn: () => T,
): T {
  actorByDb.set(db, actor);
  try {
    return fn();
  } finally {
    actorByDb.delete(db);
  }
}

/** One row of the trail, as the core read API projects it. */
export interface MemoryHistoryRow {
  id: number;
  memoryId: string;
  mechanism: string;
  beforeContent: string | null;
  afterContent: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  actor: string | null;
  at: number;
}

const SELECT_ROWS = `
  SELECT id,
         memory_id      AS memoryId,
         mechanism,
         before_content AS beforeContent,
         after_content  AS afterContent,
         before_hash    AS beforeHash,
         after_hash     AS afterHash,
         actor,
         at
  FROM memory_history`;

/**
 * Read the trail in export order (id ascending). `opts.sinceId` is an
 * EXCLUSIVE cursor — only rows with id strictly greater are returned — so a
 * paging exporter passes the last id it consumed and nothing is sent twice.
 * Omitted/0 means from the beginning; a cursor at or beyond the last row
 * yields an empty slice.
 */
export function listMemoryHistory(
  db: Database.Database,
  opts: { sinceId?: number } = {},
): MemoryHistoryRow[] {
  if (opts.sinceId && opts.sinceId > 0) {
    return db
      .prepare(`${SELECT_ROWS} WHERE id > ? ORDER BY id ASC`)
      .all(opts.sinceId) as MemoryHistoryRow[];
  }
  return db.prepare(`${SELECT_ROWS} ORDER BY id ASC`).all() as MemoryHistoryRow[];
}
