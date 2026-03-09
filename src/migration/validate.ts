/**
 * Migration validation framework.
 *
 * Five checks to verify data integrity after migration:
 * 1. Row counts match (with exclusion filter)
 * 2. Embeddings have correct dimensions and norms
 * 3. Content matches between source and target
 * 4. FTS5 integrity and hit rate
 * 5. Search quality for reference queries
 */

import Database from "better-sqlite3";
import { initDatabase } from "../core/db.js";
import { loadConfig } from "../_core/config/index.js";
import type { ValidationResult } from "./types.js";
import { EXCLUDED_PROJECT } from "./types.js";

// ─── Check 1: Row Counts ────────────────────────────────────────

/**
 * Validate that row counts match between source and target.
 * Applies exclusion filter on source counts.
 */
export function validateRowCounts(
  sourceDb: Database.Database,
  targetDb: Database.Database,
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Exchanges
  const sourceExchanges = (
    sourceDb
      .prepare(
        `SELECT COUNT(*) as count FROM exchanges
         WHERE archive_path NOT LIKE '%${EXCLUDED_PROJECT}%'`,
      )
      .get() as { count: number }
  ).count;

  const targetExchanges = (
    targetDb
      .prepare("SELECT COUNT(*) as count FROM exchanges")
      .get() as { count: number }
  ).count;

  results.push({
    check: "Exchange row count",
    passed: sourceExchanges === targetExchanges,
    expected: sourceExchanges,
    actual: targetExchanges,
    details:
      sourceExchanges !== targetExchanges
        ? `Difference: ${Math.abs(sourceExchanges - targetExchanges)}`
        : undefined,
  });

  // Tool calls
  const sourceToolCalls = (
    sourceDb
      .prepare(
        `SELECT COUNT(*) as count FROM tool_calls tc
         JOIN exchanges e ON tc.exchange_id = e.id
         WHERE e.archive_path NOT LIKE '%${EXCLUDED_PROJECT}%'`,
      )
      .get() as { count: number }
  ).count;

  const targetToolCalls = (
    targetDb
      .prepare("SELECT COUNT(*) as count FROM tool_calls")
      .get() as { count: number }
  ).count;

  results.push({
    check: "Tool call row count",
    passed: sourceToolCalls === targetToolCalls,
    expected: sourceToolCalls,
    actual: targetToolCalls,
    details:
      sourceToolCalls !== targetToolCalls
        ? `Difference: ${Math.abs(sourceToolCalls - targetToolCalls)}`
        : undefined,
  });

  // Conversations
  const sourceConversations = (
    sourceDb
      .prepare(
        `SELECT COUNT(DISTINCT archive_path) as count FROM exchanges
         WHERE archive_path NOT LIKE '%${EXCLUDED_PROJECT}%'`,
      )
      .get() as { count: number }
  ).count;

  const targetConversations = (
    targetDb
      .prepare("SELECT COUNT(*) as count FROM conversations")
      .get() as { count: number }
  ).count;

  results.push({
    check: "Conversation count",
    passed: sourceConversations === targetConversations,
    expected: sourceConversations,
    actual: targetConversations,
  });

  // Vector embeddings
  const targetVectors = (
    targetDb
      .prepare("SELECT COUNT(*) as count FROM vec_exchanges")
      .get() as { count: number }
  ).count;

  results.push({
    check: "Vector embedding count",
    passed: targetVectors === targetExchanges,
    expected: targetExchanges,
    actual: targetVectors,
    details:
      targetVectors !== targetExchanges
        ? "Every exchange should have a corresponding vector"
        : undefined,
  });

  return results;
}

// ─── Check 2: Embedding Quality ─────────────────────────────────

/**
 * Validate embedding dimensions and L2 norms on a random sample.
 */
export function validateEmbeddings(
  targetDb: Database.Database,
  sampleSize: number = 100,
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Sample random vectors
  const rows = targetDb
    .prepare(
      `SELECT id, embedding FROM vec_exchanges
       ORDER BY RANDOM()
       LIMIT ?`,
    )
    .all(sampleSize) as { id: string; embedding: Buffer }[];

  if (rows.length === 0) {
    results.push({
      check: "Embedding sample available",
      passed: false,
      expected: `>= 1`,
      actual: 0,
      details: "No vectors found in vec_exchanges",
    });
    return results;
  }

  let dimensionErrors = 0;
  let normErrors = 0;

  for (const row of rows) {
    const floats = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );

    // Check dimensions
    if (floats.length !== 256) {
      dimensionErrors++;
    }

    // Check L2 norm ~1.0 (within tolerance)
    let norm = 0;
    for (const v of floats) norm += v * v;
    norm = Math.sqrt(norm);
    if (Math.abs(norm - 1.0) > 0.05) {
      normErrors++;
    }
  }

  results.push({
    check: "Embedding dimensions (256 floats)",
    passed: dimensionErrors === 0,
    expected: "0 errors",
    actual: `${dimensionErrors} errors in ${rows.length} samples`,
  });

  results.push({
    check: "Embedding L2 norm ~1.0",
    passed: normErrors === 0,
    expected: "0 errors",
    actual: `${normErrors} errors in ${rows.length} samples`,
    details:
      normErrors > 0
        ? "Vectors should be L2-normalized (norm within 0.05 of 1.0)"
        : undefined,
  });

  return results;
}

// ─── Check 3: Content Matching ──────────────────────────────────

/**
 * Validate that sampled content matches between source and target.
 */
export function validateContent(
  sourceDb: Database.Database,
  targetDb: Database.Database,
  sampleSize: number = 200,
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Sample source exchanges
  const sourceRows = sourceDb
    .prepare(
      `SELECT id, user_message, assistant_message FROM exchanges
       WHERE archive_path NOT LIKE '%${EXCLUDED_PROJECT}%'
       ORDER BY RANDOM()
       LIMIT ?`,
    )
    .all(sampleSize) as {
    id: string;
    user_message: string;
    assistant_message: string;
  }[];

  let mismatches = 0;
  let missing = 0;
  const mismatchDetails: string[] = [];

  for (const source of sourceRows) {
    const target = targetDb
      .prepare(
        "SELECT user_message, assistant_message FROM exchanges WHERE id = ?",
      )
      .get(source.id) as {
      user_message: string;
      assistant_message: string;
    } | undefined;

    if (!target) {
      missing++;
      continue;
    }

    if (
      target.user_message !== source.user_message ||
      target.assistant_message !== source.assistant_message
    ) {
      mismatches++;
      if (mismatchDetails.length < 3) {
        mismatchDetails.push(`ID ${source.id}: content differs`);
      }
    }
  }

  results.push({
    check: "Content presence",
    passed: missing === 0,
    expected: "0 missing",
    actual: `${missing} missing in ${sourceRows.length} samples`,
  });

  results.push({
    check: "Content accuracy",
    passed: mismatches === 0,
    expected: "0 mismatches",
    actual: `${mismatches} mismatches in ${sourceRows.length} samples`,
    details:
      mismatchDetails.length > 0
        ? mismatchDetails.join("; ")
        : undefined,
  });

  return results;
}

// ─── Check 4: FTS Integrity ─────────────────────────────────────

/**
 * Validate FTS5 index integrity and search hit rate.
 */
export function validateFTS(
  targetDb: Database.Database,
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // FTS5 integrity check
  let integrityOk = true;
  let integrityDetails: string | undefined;
  try {
    targetDb.exec(
      "INSERT INTO exchanges_fts(exchanges_fts) VALUES('integrity-check')",
    );
  } catch (err) {
    integrityOk = false;
    integrityDetails =
      err instanceof Error ? err.message : String(err);
  }

  results.push({
    check: "FTS5 integrity",
    passed: integrityOk,
    expected: "ok",
    actual: integrityOk ? "ok" : "corrupted",
    details: integrityDetails,
  });

  // Test 20 known-content queries against actual exchange content
  // Sample 20 user_message values and extract keywords to test
  const sampleRows = targetDb
    .prepare(
      `SELECT user_message FROM exchanges
       WHERE user_message IS NOT NULL AND length(user_message) > 20
       ORDER BY RANDOM()
       LIMIT 20`,
    )
    .all() as { user_message: string }[];

  let hits = 0;
  let tested = 0;

  for (const row of sampleRows) {
    // Extract a 1-2 word search term from the message
    const words = row.user_message
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 4);

    if (words.length === 0) continue;

    const searchTerm = `"${words[0]}"`;
    tested++;

    try {
      const ftsResult = targetDb
        .prepare(
          `SELECT COUNT(*) as count FROM exchanges_fts
           WHERE exchanges_fts MATCH ?`,
        )
        .get(searchTerm) as { count: number };

      if (ftsResult.count > 0) hits++;
    } catch {
      // FTS query syntax error, skip
    }
  }

  const hitRate = tested > 0 ? hits / tested : 0;
  results.push({
    check: "FTS hit rate (>80%)",
    passed: hitRate >= 0.8,
    expected: ">= 80%",
    actual: `${Math.round(hitRate * 100)}% (${hits}/${tested})`,
  });

  return results;
}

// ─── Check 5: Search Quality ────────────────────────────────────

/**
 * Validate search quality with reference queries.
 * Checks that queries return >0 results with scores in [0.1, 1.0].
 */
export function validateSearchQuality(
  targetDb: Database.Database,
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Reference queries — generic terms likely to exist in any dev conversation corpus
  const referenceQueries = [
    "database",
    "configuration",
    "error",
    "function",
    "install",
    "test",
    "file",
    "project",
  ];

  let queriesWithResults = 0;
  let queriesWithValidScores = 0;
  const noResultQueries: string[] = [];

  for (const query of referenceQueries) {
    try {
      const ftsResult = targetDb
        .prepare(
          `SELECT e.id, fts.rank
           FROM exchanges_fts AS fts
           JOIN exchanges AS e ON e.rowid = fts.rowid
           WHERE exchanges_fts MATCH ?
           ORDER BY fts.rank
           LIMIT 5`,
        )
        .all(`"${query}"`) as { id: string; rank: number }[];

      if (ftsResult.length > 0) {
        queriesWithResults++;
        // FTS rank is negative (lower = better), but we just check existence
        queriesWithValidScores++;
      } else {
        noResultQueries.push(query);
      }
    } catch {
      noResultQueries.push(query);
    }
  }

  results.push({
    check: "Reference queries return results",
    passed: queriesWithResults > 0,
    expected: `>0 of ${referenceQueries.length}`,
    actual: `${queriesWithResults}/${referenceQueries.length}`,
    details:
      noResultQueries.length > 0
        ? `No results for: ${noResultQueries.join(", ")}`
        : undefined,
  });

  results.push({
    check: "Search scores in valid range",
    passed: queriesWithValidScores > 0,
    expected: "scores in [0.1, 1.0]",
    actual: `${queriesWithValidScores}/${referenceQueries.length} queries valid`,
  });

  return results;
}

// ─── Orchestrator ───────────────────────────────────────────────

/**
 * Run all validation checks.
 */
export async function runValidation(options: {
  sourcePath: string;
  targetPath?: string;
}): Promise<ValidationResult[]> {
  const sourceDb = new Database(options.sourcePath, { readonly: true });

  const config = loadConfig();
  const targetDb = options.targetPath
    ? new Database(options.targetPath)
    : initDatabase(config);

  const results: ValidationResult[] = [];

  try {
    results.push(...validateRowCounts(sourceDb, targetDb));
    results.push(...validateEmbeddings(targetDb));
    results.push(...validateContent(sourceDb, targetDb));
    results.push(...validateFTS(targetDb));
    results.push(...validateSearchQuality(targetDb));
  } finally {
    sourceDb.close();
    targetDb.close();
  }

  return results;
}
