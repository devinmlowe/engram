/**
 * Dream sequence management — status queries and process lifecycle.
 *
 * Spawns the dream CLI as a detached child process and tracks its state
 * via the dream_runs table and dream.log file.
 */

import type Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resetThresholdCache } from "../data/graph-queries.js";

// ─── Constants ──────────────────────────────────────────────────

const ENGRAM_DIR = join(homedir(), ".local", "share", "engram");
const DREAM_LOG = join(ENGRAM_DIR, "logs", "dream.log");

const DREAM_PHASES = ["ingest", "extract", "consolidate", "reflect", "prune"] as const;

// ─── Process State ──────────────────────────────────────────────

let dreamProcess: ChildProcess | null = null;

export function isDreamRunning(): boolean {
  return dreamProcess !== null;
}

// ─── Dream Status ───────────────────────────────────────────────

export interface DreamStatus {
  running: boolean;
  phase: string | null;
  detail: string | null;
  progress: { processed: number; total: number; errors: number } | null;
  runId: string | null;
  startedAt: number | null;
  lastReport: { newMemories: number; newEntities: number; newRelationships: number; memoriesPruned: number } | null;
}

export function getDreamStatus(db: Database.Database): DreamStatus {
  // Check for active run in DB
  const activeRun = db.prepare(
    "SELECT id, started_at, phases_completed, new_memories, new_entities, new_relationships, memories_pruned FROM dream_runs WHERE completed_at IS NULL AND error IS NULL ORDER BY started_at DESC LIMIT 1"
  ).get() as {
    id: string; started_at: number; phases_completed: string | null;
    new_memories: number; new_entities: number; new_relationships: number; memories_pruned: number;
  } | undefined;

  if (!activeRun && !dreamProcess) {
    // Check most recent completed run for last report
    const lastRun = db.prepare(
      "SELECT new_memories, new_entities, new_relationships, memories_pruned, completed_at FROM dream_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1"
    ).get() as { new_memories: number; new_entities: number; new_relationships: number; memories_pruned: number; completed_at: number } | undefined;

    return {
      running: false, phase: null, detail: null, progress: null, runId: null, startedAt: null,
      lastReport: lastRun ? {
        newMemories: lastRun.new_memories, newEntities: lastRun.new_entities,
        newRelationships: lastRun.new_relationships, memoriesPruned: lastRun.memories_pruned,
      } : null,
    };
  }

  if (!activeRun) {
    return { running: true, phase: "starting", detail: "Initializing...", progress: null, runId: null, startedAt: null, lastReport: null };
  }

  const completedPhases: string[] = activeRun.phases_completed ? JSON.parse(activeRun.phases_completed) : [];

  // Figure out current phase
  let currentPhase = "ingest";
  for (const p of DREAM_PHASES) {
    if (!completedPhases.includes(p)) {
      currentPhase = p;
      break;
    }
  }

  // Get checkpoint progress for current phase
  const checkpointCount = (db.prepare(
    "SELECT COUNT(*) as c FROM dream_checkpoints WHERE run_id = ? AND phase = ? AND status = 'success'"
  ).get(activeRun.id, currentPhase) as { c: number }).c;

  const errorCount = (db.prepare(
    "SELECT COUNT(*) as c FROM dream_checkpoints WHERE run_id = ? AND phase = ? AND status = 'error'"
  ).get(activeRun.id, currentPhase) as { c: number }).c;

  // Estimate total for the phase
  let total = 0;
  if (currentPhase === "extract" || currentPhase === "ingest") {
    total = (db.prepare("SELECT COUNT(*) as c FROM conversations").get() as { c: number }).c;
  } else if (currentPhase === "consolidate" || currentPhase === "prune") {
    total = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE is_active = 1").get() as { c: number }).c;
  } else if (currentPhase === "reflect") {
    total = 1;
  }

  // Read last log line for detail (read only tail of file)
  let detail: string | null = null;
  try {
    if (existsSync(DREAM_LOG)) {
      const stat = statSync(DREAM_LOG);
      const tailSize = Math.min(2048, stat.size);
      const buf = Buffer.alloc(tailSize);
      const fd = openSync(DREAM_LOG, "r");
      readSync(fd, buf, 0, tailSize, stat.size - tailSize);
      closeSync(fd);
      const tail = buf.toString("utf-8");
      const lines = tail.trim().split("\n");
      const last = lines[lines.length - 1];
      if (last) {
        const parsed = JSON.parse(last);
        detail = parsed.message ?? null;
      }
    }
  } catch { /* ignore */ }

  const phaseLabel = currentPhase.charAt(0).toUpperCase() + currentPhase.slice(1);

  return {
    running: true,
    phase: currentPhase,
    detail: detail ?? `${phaseLabel} phase in progress...`,
    progress: { processed: checkpointCount, total, errors: errorCount },
    runId: activeRun.id,
    startedAt: activeRun.started_at,
    lastReport: {
      newMemories: activeRun.new_memories, newEntities: activeRun.new_entities,
      newRelationships: activeRun.new_relationships, memoriesPruned: activeRun.memories_pruned,
    },
  };
}

// ─── Start Dream ────────────────────────────────────────────────

export function startDream(): { ok: boolean; message: string } {
  if (dreamProcess) {
    return { ok: false, message: "Dream already running" };
  }

  const engramBin = join(import.meta.dirname ?? ".", "..", "cli", "index.ts");

  dreamProcess = spawn("npx", ["tsx", engramBin, "dream", "--verbose"], {
    // Repo root: routes/ -> web/ -> interfaces/ -> src/ -> root
    cwd: join(import.meta.dirname ?? ".", "..", "..", "..", ".."),
    stdio: "ignore",
    detached: true,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  dreamProcess.on("exit", (code) => {
    console.log(`Dream process exited with code ${code}`);
    dreamProcess = null;
    resetThresholdCache(); // recompute after dream adds new entities
  });

  dreamProcess.on("error", (err) => {
    console.error(`Dream process error: ${err.message}`);
    dreamProcess = null;
  });

  dreamProcess.unref();

  return { ok: true, message: "Dream sequence initiated" };
}
