/**
 * `engram validate` — store integrity checks.
 *
 * 1. Embeddings have the expected dimensions and L2 norm
 * 2. FTS5 index integrity and search hit rate
 * 3. Memory index integrity — no vector/FTS rows for forgotten or missing memories (#55)
 */

import Database from "better-sqlite3";
import { initDatabase } from "../../_core/db/index.js";
import { loadConfig } from "../../_core/config/index.js";
import { auditMemoryIndex, repairMemoryIndex, type IndexRepair } from "../../semantic/index-integrity.js";

export interface ValidationResult {
  check: string;
  passed: boolean;
  expected: number | string;
  actual: number | string;
  details?: string;
}

// ─── Check 1: Embedding Quality ─────────────────────────────────

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

// ─── Check 2: FTS Integrity ─────────────────────────────────────

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

// ─── Check 3: Memory index integrity (#55) ──────────────────────

/**
 * vec_memories / memories_fts rows for forgotten (deleted_at set) or missing
 * memories are a failure: `forget` removes them in the same transaction, so
 * a leftover means something bypassed it. With `fix`, orphans are removed
 * (vectors by id; FTS by rebuilding the index and re-unindexing every
 * forgotten memory) and the check re-runs so the report shows the repaired
 * state.
 */
export function validateMemoryIndex(
  targetDb: Database.Database,
  options: { fix?: boolean } = {},
): ValidationResult[] {
  const results: ValidationResult[] = [];
  let audit = auditMemoryIndex(targetDb);
  let repair: IndexRepair | undefined;
  const orphanVectors = audit.orphanVectorsForgotten.length + audit.orphanVectorsMissing.length;
  const orphanFts = audit.orphanFtsForgotten.length + audit.orphanFtsMissing.length;

  if (options.fix && (orphanVectors > 0 || orphanFts > 0)) {
    repair = repairMemoryIndex(targetDb, audit);
    audit = auditMemoryIndex(targetDb);
  }

  const vecNow = audit.orphanVectorsForgotten.length + audit.orphanVectorsMissing.length;
  results.push({
    check: "No vector rows for forgotten or missing memories",
    passed: vecNow === 0,
    expected: 0,
    actual: vecNow,
    details:
      repair && orphanVectors > 0
        ? `Removed ${repair.vectorsDeleted} orphaned vector row(s)`
        : vecNow > 0
          ? `${audit.orphanVectorsForgotten.length} for forgotten memories, ${audit.orphanVectorsMissing.length} for missing memories — run \`engram validate --fix\``
          : undefined,
  });

  const ftsNow = audit.orphanFtsForgotten.length + audit.orphanFtsMissing.length;
  results.push({
    check: "No FTS rows for forgotten or missing memories",
    passed: ftsNow === 0,
    expected: 0,
    actual: ftsNow,
    details:
      repair && orphanFts > 0
        ? `Rebuilt memories_fts and re-removed ${repair.ftsRowsRemoved} forgotten memor${repair.ftsRowsRemoved === 1 ? "y" : "ies"}`
        : ftsNow > 0
          ? `${audit.orphanFtsForgotten.length} for forgotten memories, ${audit.orphanFtsMissing.length} for missing memories — run \`engram validate --fix\``
          : undefined,
  });

  return results;
}

// ─── Orchestrator ───────────────────────────────────────────────

/**
 * Run every integrity check against the configured database (or `targetPath`).
 */
export async function runValidation(options: {
  targetPath?: string;
  /** Repair memory-index orphans (#55) before reporting. */
  fix?: boolean;
} = {}): Promise<ValidationResult[]> {
  const config = loadConfig();
  const targetDb = options.targetPath
    ? new Database(options.targetPath)
    : initDatabase(config);

  const results: ValidationResult[] = [];

  try {
    results.push(...validateEmbeddings(targetDb));
    results.push(...validateFTS(targetDb));
    results.push(...validateMemoryIndex(targetDb, { fix: options.fix }));
  } finally {
    targetDb.close();
  }

  return results;
}
