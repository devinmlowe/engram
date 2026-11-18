/**
 * eval/src/suites/temporal.ts — thin temporal suite (SPEC-003).
 *
 * Replays `memory_changes` rows, scoring ordering/supersede behavior through
 * Engram's own `searchSemantic` code path. Live store has 18 rows
 * (forget 14, purge 3, restore 1).
 */

import type Database from "better-sqlite3";
import { searchSemantic } from "../../../src/semantic/search.js";
import { orderingCorrectRate } from "../score.js";

export interface TemporalCase {
  changeId: string;
  memoryId: string;
  op: string;
  query: string;
  rankedIds: string[];
  correct: boolean;
}

export interface TemporalSuiteResult {
  n: number;
  orderingCorrectRate: number;
  perCase: TemporalCase[];
}

interface ChangeRow {
  id: string;
  memory_id: string;
  op: string;
  before: string | null;
  after: string | null;
}

/**
 * Score one change row's ordering/supersede behavior:
 * - forget/purge: correct when the `before` content no longer surfaces.
 * - edit: correct when the `after` content outranks the `before` content
 *   (or the before content no longer surfaces).
 * - restore: correct when the `before` content surfaces again.
 */
async function scoreChange(
  db: Database.Database,
  row: ChangeRow,
  k: number,
): Promise<TemporalCase> {
  const query = row.after ?? row.before ?? row.memory_id;
  const results = await searchSemantic(db, { query, limit: k });
  const rankedIds = results.map((r) => r.id);
  const contents = results.map((r) => r.content.toLowerCase());

  const surfaces = (needle: string | null) =>
    needle !== null &&
    contents.some((c) => c.includes(needle.toLowerCase().slice(0, 40)));

  let correct: boolean;
  switch (row.op) {
    case "forget":
    case "purge":
      correct = !surfaces(row.before);
      break;
    case "restore":
      correct = surfaces(row.before);
      break;
    case "edit": {
      const afterIdx = row.after
        ? contents.findIndex((c) => c.includes(row.after!.toLowerCase().slice(0, 40)))
        : -1;
      const beforeIdx = row.before
        ? contents.findIndex((c) => c.includes(row.before.toLowerCase().slice(0, 40)))
        : -1;
      correct = afterIdx !== -1 && (beforeIdx === -1 || afterIdx < beforeIdx) && row.before !== null;
      break;
    }
    default:
      correct = false;
  }

  return {
    changeId: row.id,
    memoryId: row.memory_id,
    op: row.op,
    query,
    rankedIds,
    correct,
  };
}

/** Replay memory_changes rows through the repo's own recall path. */
export async function runTemporalSuite(
  db: Database.Database,
  options: { k?: number } = {},
): Promise<TemporalSuiteResult> {
  const k = options.k ?? 10;
  const rows = db
    .prepare(
      "SELECT id, memory_id, op, before, after FROM memory_changes ORDER BY at ASC",
    )
    .all() as ChangeRow[];

  const perCase: TemporalCase[] = [];
  for (const row of rows) {
    perCase.push(await scoreChange(db, row, k));
  }

  return {
    n: perCase.length,
    orderingCorrectRate: orderingCorrectRate(perCase),
    perCase,
  };
}
