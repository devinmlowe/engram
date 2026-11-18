/**
 * eval/src/suites/redaction.ts — redaction axis (SPEC-004).
 *
 * Iterates `memory_suppressions` rows and scores whether recall surfaces the
 * suppressed content hash (hash-leakage rate), through Engram's own
 * `searchSemantic` code path.
 */

import type Database from "better-sqlite3";
import { searchSemantic } from "../../../src/semantic/search.js";
import { contentHash } from "../../../src/semantic/forget.js";
import { redactionLeakageRate, type RedactionCase } from "../score.js";

export interface RedactionCaseDetail extends RedactionCase {
  memoryId: string | null;
  scope: string;
  query: string;
  rankedIds: string[];
}

export interface RedactionSuiteResult {
  n: number;
  leakageRate: number;
  perCase: RedactionCaseDetail[];
}

interface SuppressionRow {
  content_hash: string;
  memory_id: string | null;
  scope: string;
}

/**
 * For each suppression row, query recall with keywords from the suppressed
 * content and check whether the suppressed hash appears in the results.
 * The hash is computed with Engram's own contentHash().
 */
export async function runRedactionSuite(
  db: Database.Database,
  options: { k?: number } = {},
): Promise<RedactionSuiteResult> {
  const k = options.k ?? 10;
  const rows = db
    .prepare(
      "SELECT content_hash, memory_id, scope FROM memory_suppressions",
    )
    .all() as SuppressionRow[];
  const getMemory = db.prepare("SELECT content FROM memories WHERE id = ?");

  const perCase: RedactionCaseDetail[] = [];
  for (const row of rows) {
    const memory = row.memory_id
      ? (getMemory.get(row.memory_id) as { content: string } | undefined)
      : undefined;
    if (!memory) {
      perCase.push({
        hash: row.content_hash,
        memoryId: row.memory_id,
        scope: row.scope,
        query: "",
        rankedIds: [],
        surfaced: false,
      });
      continue;
    }
    const query = memory.content;
    const results = await searchSemantic(db, { query, limit: k });
    const rankedIds = results.map((r) => r.id);
    const surfaced = results.some((r) => contentHash(r.content) === row.content_hash);
    perCase.push({
      hash: row.content_hash,
      memoryId: row.memory_id,
      scope: row.scope,
      query,
      rankedIds,
      surfaced,
    });
  }

  return { n: perCase.length, leakageRate: redactionLeakageRate(perCase), perCase };
}
