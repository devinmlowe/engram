/**
 * Reciprocal Rank Fusion (RRF) and score normalization.
 *
 * Pure math functions used across episodic, semantic, and graph search.
 * Extracted from episodic/search.ts during Phase 1 core extraction.
 */

// ─── Types ───────────────────────────────────────────────────────

export interface RankedItem {
  id: string;
  rank: number;
}

// ─── RRF Fusion ──────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion: merge results from multiple rankings.
 * score = sum(1 / (k + rank_i))
 */
export function rrfFuse(
  vectorResults: RankedItem[],
  ftsResults: RankedItem[],
  k: number = 60,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();

  for (const item of vectorResults) {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + item.rank));
  }
  for (const item of ftsResults) {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + item.rank));
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// ─── Score Normalization ─────────────────────────────────────────

/**
 * Normalize scores to [floor, 1.0] using min-max scaling.
 * Ensures all results show intuitive percentage-style scores.
 */
export function normalizeMinMaxFloored(
  results: { id: string; score: number }[],
  floor: number = 0.1,
): void {
  if (results.length === 0) return;
  if (results.length === 1) {
    results[0].score = 0.85;
    return;
  }

  const max = results[0].score; // assumes pre-sorted descending
  const min = results[results.length - 1].score;
  const range = max - min;

  if (range === 0) {
    for (const r of results) r.score = 0.5;
    return;
  }

  for (const r of results) {
    r.score = floor + (1 - floor) * ((r.score - min) / range);
  }
}
