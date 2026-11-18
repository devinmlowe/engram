/**
 * eval/src/score.ts — pure metric functions (SPEC-002/003/004).
 */

/** One scored conflict-replay case. Rank is 1-based; Infinity = not ranked. */
export interface ConflictCase {
  survivingRank: number;
  staleRank: number;
  surfacedStale: boolean;
}

/** Fraction of cases where the stale fact outranked (or masked) the survivor. */
export function staleSurfacingRate(cases: ConflictCase[]): number {
  if (cases.length === 0) return 0;
  return cases.filter((c) => c.surfacedStale).length / cases.length;
}

/** Fraction of cases where the surviving memory appears within the top-k. */
export function recallAtK(
  cases: Array<{ survivingRank: number }>,
  k: number,
): number {
  if (cases.length === 0) return 0;
  return cases.filter((c) => c.survivingRank >= 1 && c.survivingRank <= k)
    .length / cases.length;
}

/** One redaction case: did recall surface content matching a suppressed hash? */
export interface RedactionCase {
  hash: string;
  surfaced: boolean;
}

/** Fraction of suppressed contents whose hash leaked through recall. */
export function redactionLeakageRate(cases: RedactionCase[]): number {
  if (cases.length === 0) return 0;
  return cases.filter((c) => c.surfaced).length / cases.length;
}

/** Fraction of temporal-change cases whose ordering/supersede behavior is correct. */
export function orderingCorrectRate(cases: Array<{ correct: boolean }>): number {
  if (cases.length === 0) return 0;
  return cases.filter((c) => c.correct).length / cases.length;
}
