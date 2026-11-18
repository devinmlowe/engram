/**
 * eval/src/suites/conflicts.ts — the primary conflict-replay suite (SPEC-002).
 *
 * Samples `conflicts` rows (+ their `memories` rows), replays recall through
 * Engram's own `searchSemantic` code path (never a reimplementation), and
 * scores whether the SURVIVING fact outranks the stale one.
 */

import type Database from "better-sqlite3";
import { searchSemantic } from "../../../src/semantic/search.js";
import {
  staleSurfacingRate,
  recallAtK,
  type ConflictCase,
} from "../score.js";

export interface ConflictCaseDetail extends ConflictCase {
  conflictId: string;
  query: string;
  rankedIds: string[];
  survivingId: string;
  staleId: string;
  survivingRank: number;
  staleRank: number;
  surfacedStale: boolean;
}

export interface ConflictSuiteOptions {
  /** Max top-k reported; recall is computed at k = 1, 3, 10 (capped here). */
  k?: number;
  /** Max conflicts sampled from the store (live runs). */
  sample?: number;
}

export interface ConflictSuiteResult {
  n: number;
  staleSurfacingRate: number;
  recallAtK: Array<{ k: number; value: number }>;
  perCase: ConflictCaseDetail[];
}

interface ConflictRow {
  id: string;
  memory_id: string;
  conflicting_memory_id: string;
  description: string | null;
  resolution: string | null;
}

interface MemoryRow {
  id: string;
  content: string;
  is_active: number;
}

interface RunCase {
  result: ConflictCaseDetail;
  survivingContent: string;
  description: string;
}

/** Build the plain query: surviving-memory content keywords (settled decision 2). */
function plainQuery(survivingContent: string): string {
  return survivingContent;
}

/** Build the conditioned query: conflict description + surviving content + temporal qualifiers. */
function conditionedQuery(survivingContent: string, description: string): string {
  return `${description} ${survivingContent} latest current version supersedes the older statement`;
}

async function replayCase(
  db: Database.Database,
  conflict: ConflictRow,
  surviving: MemoryRow,
  stale: MemoryRow,
  query: string,
  k: number,
): Promise<RunCase> {
  const results = await searchSemantic(db, { query, limit: k });
  const rankedIds = results.map((r) => r.id);
  const survivingRank = rankedIds.indexOf(surviving.id) + 1 || Infinity;
  const staleRank = rankedIds.indexOf(stale.id) + 1 || Infinity;
  return {
    result: {
      conflictId: conflict.id,
      query,
      rankedIds,
      survivingId: surviving.id,
      staleId: stale.id,
      survivingRank,
      staleRank,
      surfacedStale:
        staleRank < survivingRank ||
        (survivingRank === Infinity && staleRank !== Infinity),
    },
    survivingContent: surviving.content,
    description: conflict.description ?? "",
  };
}

/**
 * Replay conflict rows through the repo's own recall path.
 * Both the plain-query and query-conditioned slices are computed per case.
 */
export async function runConflictSuite(
  db: Database.Database,
  options: ConflictSuiteOptions = {},
): Promise<ConflictSuiteResult> {
  const k = options.k ?? 10;
  const sample = options.sample ?? 50;
  const conflicts = db
    .prepare(
      `SELECT id, memory_id, conflicting_memory_id, description, resolution
       FROM conflicts ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sample) as ConflictRow[];

  const getMemory = db.prepare(
    "SELECT id, content, is_active FROM memories WHERE id = ?",
  );

  const cases: ConflictCaseDetail[] = [];
  const plainRuns: RunCase[] = [];
  const conditionedRuns: RunCase[] = [];

  for (const conflict of conflicts) {
    const a = getMemory.get(conflict.memory_id) as MemoryRow | undefined;
    const b = getMemory.get(conflict.conflicting_memory_id) as
      | MemoryRow
      | undefined;
    if (!a || !b) continue;
    // Surviving = whichever row is still active; stale = the other.
    const surviving = a.is_active ? a : b;
    const stale = a.is_active ? b : a;

    plainRuns.push(
      await replayCase(db, conflict, surviving, stale, plainQuery(surviving.content), k),
    );
    conditionedRuns.push(
      await replayCase(
        db,
        conflict,
        surviving,
        stale,
        conditionedQuery(surviving.content, conflict.description ?? ""),
        k,
      ),
    );
    cases.push(conditionedRuns[conditionedRuns.length - 1].result);
  }

  return {
    n: cases.length,
    staleSurfacingRate: staleSurfacingRate(cases),
    recallAtK: [1, 3, 10].map((kk) => ({
      k: kk,
      value: recallAtK(cases, Math.min(kk, k)),
    })),
    perCase: cases,
    // Comparison slice exposed separately for the report (see buildReport).
    ...({ plainRuns, conditionedRuns } as object),
  } as ConflictSuiteResult & {
    plainRuns: RunCase[];
    conditionedRuns: RunCase[];
  };
}

/**
 * Compute the query-conditioned vs plain-query comparison slice from a suite
 * run's internal replay data (settled decision 2: always reported side by side).
 */
export function conflictSlice(run: ConflictSuiteResult & {
  plainRuns: RunCase[];
  conditionedRuns: RunCase[];
}): {
  plain: { n: number; staleSurfacingRate: number; recallAt3: number };
  conditioned: { n: number; staleSurfacingRate: number; recallAt3: number };
} {
  const summarize = (runs: RunCase[]) => ({
    n: runs.length,
    staleSurfacingRate: staleSurfacingRate(runs.map((r: RunCase) => r.result)),
    recallAt3: recallAtK(runs.map((r: RunCase) => r.result), 3),
  });
  return { plain: summarize(run.plainRuns), conditioned: summarize(run.conditionedRuns) };
}
