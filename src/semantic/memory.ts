/**
 * Semantic memory CRUD operations with FTS5 and vec0 sync.
 *
 * All write operations are transactional — inserts, updates, and
 * deactivations atomically sync the memories table, memories_fts
 * (full-text search), and vec_memories (vector similarity) tables.
 *
 * Follows the same patterns established in src/episodic/store.ts.
 */

import type Database from "better-sqlite3";
import type { Memory, MemoryType, MemorySource, Conflict } from "./types.js";
import {
  insertVector,
  searchVector,
  deleteVector,
  insertFtsRow,
  deleteFtsRow,
} from "../_core/db/index.js";
import { onSuccessfulAccess, onContradiction } from "./decay.js";

// ─── Row Type Helpers ───────────────────────────────────────────

interface MemoryRow {
  id: string;
  type: string;
  content: string;
  context: string | null;
  confidence: number;
  importance: number;
  access_count: number;
  last_accessed: number | null;
  created_at: number;
  updated_at: number | null;
  source_exchanges: string | null;
  superseded_by: string | null;
  is_active: number;
  source: string | null;
  scope: string | null;
  stability: number | null;
}

interface ConflictRow {
  id: string;
  memory_id: string;
  conflicting_memory_id: string;
  description: string | null;
  resolution: string | null;
  resolved_at: number | null;
  created_at: number;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    type: row.type as MemoryType,
    content: row.content,
    context: row.context ?? undefined,
    confidence: row.confidence,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    sourceExchanges: row.source_exchanges
      ? JSON.parse(row.source_exchanges)
      : [],
    supersededBy: row.superseded_by ?? undefined,
    isActive: Boolean(row.is_active),
    source: (row.source as MemorySource) ?? "user",
    scope: row.scope ?? "global",
    stability: row.stability ?? undefined,
  };
}

function rowToConflict(row: ConflictRow): Conflict {
  return {
    id: row.id,
    memoryId: row.memory_id,
    conflictingMemoryId: row.conflicting_memory_id,
    description: row.description ?? "",
    resolution: row.resolution ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at,
  };
}

// ─── Memory CRUD ────────────────────────────────────────────────

/**
 * Insert a memory with its embedding, syncing memories, memories_fts,
 * and vec_memories tables atomically.
 */
export function insertMemory(
  db: Database.Database,
  memory: Memory,
  embedding: number[],
): void {
  const run = db.transaction(() => {
    // 1. Insert into memories table
    db.prepare(`
      INSERT INTO memories
        (id, type, content, context, confidence, importance, access_count,
         last_accessed, created_at, updated_at, source_exchanges, superseded_by, is_active, source, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id,
      memory.type,
      memory.content,
      memory.context ?? null,
      memory.confidence,
      memory.importance,
      memory.accessCount,
      memory.lastAccessed ?? null,
      memory.createdAt,
      memory.updatedAt ?? null,
      JSON.stringify(memory.sourceExchanges),
      memory.supersededBy ?? null,
      memory.isActive ? 1 : 0,
      memory.source ?? "user",
      memory.scope ?? "global",
    );

    // 2. Get rowid and insert into FTS5
    const row = db
      .prepare("SELECT rowid FROM memories WHERE id = ?")
      .get(memory.id) as { rowid: number } | undefined;

    if (row) {
      insertFtsRow(db, "memories_fts", row.rowid, {
        content: memory.content,
        context: memory.context ?? null,
      });
    }

    // 3. Insert into vec_memories (delete first — vec0 doesn't support REPLACE)
    insertVector(db, "vec_memories", memory.id, embedding);
  });

  run();
}

/**
 * Update specified fields of a memory. If content or context changes,
 * the FTS5 index is resynced (delete old + insert new).
 */
export function updateMemory(
  db: Database.Database,
  id: string,
  updates: Partial<Memory>,
): void {
  const run = db.transaction(() => {
    // Fetch current state for FTS sync
    const existing = db
      .prepare("SELECT rowid, content, context FROM memories WHERE id = ?")
      .get(id) as { rowid: number; content: string; context: string | null } | undefined;

    if (!existing) return;

    const needsFtsSync =
      updates.content !== undefined || updates.context !== undefined;

    // If content or context changed, delete old FTS entry
    if (needsFtsSync) {
      deleteFtsRow(db, "memories_fts", existing.rowid, {
        content: existing.content,
        context: existing.context,
      });
    }

    // Build dynamic SET clause
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) {
      setClauses.push("content = ?");
      values.push(updates.content);
    }
    if (updates.context !== undefined) {
      setClauses.push("context = ?");
      values.push(updates.context ?? null);
    }
    if (updates.confidence !== undefined) {
      setClauses.push("confidence = ?");
      values.push(updates.confidence);
    }
    if (updates.importance !== undefined) {
      setClauses.push("importance = ?");
      values.push(updates.importance);
    }
    if (updates.accessCount !== undefined) {
      setClauses.push("access_count = ?");
      values.push(updates.accessCount);
    }
    if (updates.lastAccessed !== undefined) {
      setClauses.push("last_accessed = ?");
      values.push(updates.lastAccessed);
    }
    if (updates.supersededBy !== undefined) {
      setClauses.push("superseded_by = ?");
      values.push(updates.supersededBy);
    }
    if (updates.isActive !== undefined) {
      setClauses.push("is_active = ?");
      values.push(updates.isActive ? 1 : 0);
    }
    if (updates.sourceExchanges !== undefined) {
      setClauses.push("source_exchanges = ?");
      values.push(JSON.stringify(updates.sourceExchanges));
    }

    // Always update updated_at
    setClauses.push("updated_at = unixepoch()");

    if (setClauses.length > 0) {
      values.push(id);
      db.prepare(
        `UPDATE memories SET ${setClauses.join(", ")} WHERE id = ?`,
      ).run(...values);
    }

    // If FTS needs sync, insert new entry
    if (needsFtsSync) {
      const newContent = updates.content ?? existing.content;
      const newContext = updates.context !== undefined
        ? (updates.context ?? null)
        : existing.context;

      insertFtsRow(db, "memories_fts", existing.rowid, {
        content: newContent,
        context: newContext,
      });
    }
  });

  run();
}

/**
 * Deactivate a memory by marking it inactive and recording the superseding memory.
 */
export function deactivateMemory(
  db: Database.Database,
  id: string,
  supersededBy: string,
): void {
  const run = db.transaction(() => {
    db.prepare(
      "UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = unixepoch() WHERE id = ?",
    ).run(supersededBy, id);
  });

  run();
}

/**
 * Get a single memory by ID.
 */
export function getMemory(
  db: Database.Database,
  id: string,
): Memory | null {
  const row = db
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(id) as MemoryRow | undefined;

  if (!row) return null;
  return rowToMemory(row);
}

/**
 * Get all active memories, optionally filtered by type.
 */
export function getActiveMemories(
  db: Database.Database,
  type?: MemoryType,
): Memory[] {
  let rows: MemoryRow[];

  if (type) {
    rows = db
      .prepare("SELECT * FROM memories WHERE is_active = 1 AND type = ?")
      .all(type) as MemoryRow[];
  } else {
    rows = db
      .prepare("SELECT * FROM memories WHERE is_active = 1")
      .all() as MemoryRow[];
  }

  return rows.map(rowToMemory);
}

/**
 * Record an access event — increments access_count and updates last_accessed.
 */
export function recordAccess(
  db: Database.Database,
  id: string,
): void {
  // FSRS reinforcement (ADR-010 upgrade): compute stability growth from the
  // memory's state BEFORE this access, then persist alongside the bump.
  // Immediate transaction: the MCP server and dream daemon share this WAL
  // DB from separate processes, so the read must hold the write lock.
  db.transaction(() => {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    if (!row) return;

    const { stability, importance } = onSuccessfulAccess(rowToMemory(row));
    db.prepare(
      `UPDATE memories
       SET access_count = access_count + 1, last_accessed = unixepoch(),
           stability = ?, importance = ?
       WHERE id = ?`,
    ).run(stability, importance, id);
  }).immediate();
}

/**
 * Persist the contradiction penalty on a memory's stability (FSRS: ×0.8).
 */
export function applyContradiction(
  db: Database.Database,
  id: string,
): void {
  db.transaction(() => {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    if (!row) return;

    const { stability } = onContradiction(rowToMemory(row));
    db.prepare("UPDATE memories SET stability = ? WHERE id = ?").run(stability, id);
  }).immediate();
}

// ─── Conflict Tracking ──────────────────────────────────────────

/**
 * Insert a conflict record between two memories.
 */
export function insertConflict(
  db: Database.Database,
  conflict: Conflict,
): void {
  db.prepare(`
    INSERT INTO conflicts
      (id, memory_id, conflicting_memory_id, description, resolution, resolved_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    conflict.id,
    conflict.memoryId,
    conflict.conflictingMemoryId,
    conflict.description,
    conflict.resolution ?? null,
    conflict.resolvedAt ?? null,
    conflict.createdAt,
  );
}

/**
 * Get all unresolved conflicts (no resolution set).
 */
export function getUnresolvedConflicts(
  db: Database.Database,
): Conflict[] {
  const rows = db
    .prepare("SELECT * FROM conflicts WHERE resolution IS NULL")
    .all() as ConflictRow[];

  return rows.map(rowToConflict);
}

/**
 * Resolve a conflict by setting the resolution text and resolved_at timestamp.
 */
export function resolveConflict(
  db: Database.Database,
  id: string,
  resolution: string,
): void {
  db.prepare(
    "UPDATE conflicts SET resolution = ?, resolved_at = unixepoch() WHERE id = ?",
  ).run(resolution, id);
}

// ─── Vector Search ──────────────────────────────────────────────

/**
 * Find the nearest memories by vector similarity.
 * Returns only active memories, sorted by distance (ascending).
 */
export function findNearestMemories(
  db: Database.Database,
  embedding: number[],
  limit: number = 10,
  scope?: string,
): Array<{ id: string; distance: number }> {
  // The vector index can't filter by active/scope, so candidates are
  // post-filtered from a window that escalates (×4) until `limit` survive or
  // every active memory has been considered. With a scope given, dedup
  // candidates must come from the same tenant scope (ADR-010 — never collapse
  // across scopes), and that tenant's true near-duplicate may sit well below
  // the global top-k.
  const lookup = db.prepare("SELECT is_active, scope FROM memories WHERE id = ?");
  const activeCount = (
    db.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_active = 1").get() as { n: number }
  ).n;

  // sqlite-vec (vec0) has a hard limit of 4096 for the k parameter in
  // kNN queries. Cap the escalation so we never exceed it — if 4096
  // candidates still don't yield enough active+scope-filtered results,
  // we return what we have.
  const VEC_K_MAX = 4096;

  let k = Math.min(limit * 2, VEC_K_MAX);
  let results: Array<{ id: string; distance: number }> = [];

  for (;;) {
    const candidates = searchVector(db, "vec_memories", embedding, k);
    results = [];
    for (const candidate of candidates) {
      if (results.length >= limit) break;

      const memory = lookup.get(candidate.id) as
        | { is_active: number; scope: string | null }
        | undefined;

      if (!memory || !memory.is_active) continue;
      if (scope !== undefined && (memory.scope ?? "global") !== scope) continue;

      results.push({ id: candidate.id, distance: candidate.distance });
    }

    if (results.length >= limit || k >= VEC_K_MAX) break;
    k = Math.min(k * 4, VEC_K_MAX);
  }

  return results;
}
