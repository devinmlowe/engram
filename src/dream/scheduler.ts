/**
 * Dream Scheduler — manages dream run lifecycle, checkpointing, and work prioritization.
 *
 * All checkpoint operations use SQLite transactions for atomicity.
 * Checkpoint inserts are idempotent (INSERT OR IGNORE).
 * The scheduler uses the existing dream_runs and dream_checkpoints tables
 * defined in src/core/db.ts.
 */

import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { DreamPhase, DreamProgress, DreamReport } from "./types.js";
import { insertRow, getById, count } from "../_core/db/index.js";

// ─── Row Type Helpers ───────────────────────────────────────────

interface DreamRunRow {
  id: string;
  started_at: number;
  completed_at: number | null;
  phases_completed: string | null;
  new_memories: number;
  updated_memories: number;
  new_entities: number;
  new_relationships: number;
  conflicts_detected: number;
  memories_pruned: number;
  error: string | null;
}

// ─── Run Lifecycle ──────────────────────────────────────────────

/**
 * Create a new dream run. Inserts a record into dream_runs
 * with a unique ID and the current timestamp.
 * Returns the run ID.
 */
export function createRun(db: Database.Database): string {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  insertRow(db, "dream_runs", { id, started_at: now });

  return id;
}

/**
 * Mark a dream run as successfully completed.
 * Updates all stat fields from the report and records the phases completed.
 */
export function completeRun(
  db: Database.Database,
  runId: string,
  report: DreamReport,
): void {
  const phasesCompleted = JSON.stringify(
    report.phases.map((p) => p.phase),
  );

  db.prepare(`
    UPDATE dream_runs SET
      completed_at = ?,
      phases_completed = ?,
      new_memories = ?,
      updated_memories = ?,
      new_entities = ?,
      new_relationships = ?,
      conflicts_detected = ?,
      memories_pruned = ?
    WHERE id = ?
  `).run(
    report.completedAt,
    phasesCompleted,
    report.newMemories,
    report.updatedMemories,
    report.newEntities,
    report.newRelationships,
    report.conflictsDetected,
    report.memoriesPruned,
    runId,
  );
}

/**
 * Mark a dream run as failed.
 * Records the error message and sets the completion timestamp.
 */
export function failRun(
  db: Database.Database,
  runId: string,
  error: string,
): void {
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    "UPDATE dream_runs SET error = ?, completed_at = ? WHERE id = ?",
  ).run(error, now, runId);
}

/**
 * Find the most recent incomplete dream run (one without a completed_at timestamp).
 * Returns null if all runs are complete or no runs exist.
 * Used for resume-after-crash logic.
 */
export function getIncompleteRun(
  db: Database.Database,
): { id: string; phasesCompleted: DreamPhase[] } | null {
  const row = db
    .prepare(
      "SELECT id, phases_completed FROM dream_runs WHERE completed_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get() as Pick<DreamRunRow, "id" | "phases_completed"> | undefined;

  if (!row) return null;

  const phasesCompleted: DreamPhase[] = row.phases_completed
    ? JSON.parse(row.phases_completed)
    : [];

  return { id: row.id, phasesCompleted };
}

// ─── Checkpointing ──────────────────────────────────────────────

/**
 * Check whether a specific item has been checkpointed for a given phase and run.
 */
export function isCheckpointed(
  db: Database.Database,
  runId: string,
  phase: string,
  itemId: string,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM dream_checkpoints WHERE run_id = ? AND phase = ? AND item_id = ?",
    )
    .get(runId, phase, itemId);

  return row !== undefined;
}

/**
 * Record a checkpoint for a specific item in a given phase and run.
 * Idempotent — uses a unique constraint check to avoid duplicate inserts.
 * The id is a new UUID for each checkpoint record.
 */
export function recordCheckpoint(
  db: Database.Database,
  runId: string,
  phase: string,
  itemId: string,
): void {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Use INSERT OR IGNORE with a conflict check on (run_id, phase, item_id).
  // Since there's no unique index on that combination in the schema,
  // we check existence first and skip if already present.
  const existing = db
    .prepare(
      "SELECT 1 FROM dream_checkpoints WHERE run_id = ? AND phase = ? AND item_id = ?",
    )
    .get(runId, phase, itemId);

  if (!existing) {
    insertRow(db, "dream_checkpoints", {
      id, run_id: runId, phase, item_id: itemId, processed_at: now,
    });
  }
}

/**
 * Get all checkpointed item IDs for a given phase and run.
 * Returns a Set for O(1) lookups during processing.
 */
export function getCheckpointedItems(
  db: Database.Database,
  runId: string,
  phase: string,
): Set<string> {
  const rows = db
    .prepare(
      "SELECT item_id FROM dream_checkpoints WHERE run_id = ? AND phase = ?",
    )
    .all(runId, phase) as Array<{ item_id: string }>;

  return new Set(rows.map((r) => r.item_id));
}

// ─── Work Queue ─────────────────────────────────────────────────

/**
 * Get conversation IDs that have not been checkpointed for the extract phase
 * in the given run. These are conversations that still need processing.
 */
export function getUnprocessedConversations(
  db: Database.Database,
  runId: string,
): string[] {
  const rows = db
    .prepare(`
      SELECT id FROM conversations
      WHERE id NOT IN (
        SELECT item_id FROM dream_checkpoints
        WHERE run_id = ? AND phase = 'extract'
      )
      ORDER BY last_indexed DESC
    `)
    .all(runId) as Array<{ id: string }>;

  return rows.map((r) => r.id);
}

/**
 * Prioritize conversations for processing.
 * Sort by: last_indexed DESC (newest first), then by exchange_count DESC
 * (more content = more valuable for extraction).
 */
export function prioritizeConversations(
  db: Database.Database,
  conversationIds: string[],
): string[] {
  if (conversationIds.length === 0) return [];

  // Build a parameterized IN clause
  const placeholders = conversationIds.map(() => "?").join(", ");

  const rows = db
    .prepare(`
      SELECT id FROM conversations
      WHERE id IN (${placeholders})
      ORDER BY
        COALESCE(last_indexed, 0) DESC,
        COALESCE(exchange_count, 0) DESC
    `)
    .all(...conversationIds) as Array<{ id: string }>;

  return rows.map((r) => r.id);
}

// ─── Progress Tracking ──────────────────────────────────────────

/**
 * Get progress information for a given phase in a run.
 * Counts processed items from checkpoints and total items from the
 * relevant source table (conversations for extract, memories for other phases).
 */
export function getPhaseProgress(
  db: Database.Database,
  runId: string,
  phase: string,
): DreamProgress {
  // Count processed items from checkpoints
  const processedRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM dream_checkpoints WHERE run_id = ? AND phase = ?",
    )
    .get(runId, phase) as { count: number };

  // Count errors (checkpoints with 'error:' prefix in item_id)
  const errorRow = db
    .prepare(
      "SELECT COUNT(*) as count FROM dream_checkpoints WHERE run_id = ? AND phase = ? AND item_id LIKE 'error:%'",
    )
    .get(runId, phase) as { count: number };

  // Total depends on the phase
  let total = 0;
  if (phase === "extract" || phase === "ingest") {
    const totalRow = db
      .prepare("SELECT COUNT(*) as count FROM conversations")
      .get() as { count: number };
    total = totalRow.count;
  } else if (phase === "consolidate" || phase === "prune") {
    const totalRow = db
      .prepare("SELECT COUNT(*) as count FROM memories WHERE is_active = 1")
      .get() as { count: number };
    total = totalRow.count;
  } else if (phase === "reflect") {
    // Reflect is a single operation on the whole graph
    total = 1;
  }

  // Get the run's started_at for this phase
  const runRow = db
    .prepare("SELECT started_at FROM dream_runs WHERE id = ?")
    .get(runId) as { started_at: number } | undefined;

  // Get the most recent checkpoint timestamp for this phase
  const lastCheckpointRow = db
    .prepare(
      "SELECT MAX(processed_at) as last_at FROM dream_checkpoints WHERE run_id = ? AND phase = ?",
    )
    .get(runId, phase) as { last_at: number | null };

  return {
    phase: phase as DreamPhase,
    total,
    processed: processedRow.count,
    errors: errorRow.count,
    startedAt: runRow?.started_at ?? Math.floor(Date.now() / 1000),
    lastCheckpoint: lastCheckpointRow.last_at ?? undefined,
  };
}
