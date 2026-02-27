import type { SearchResult, SearchSource } from "../core/types.js";

// ─── Priority Boost Factors ─────────────────────────────────────
// Higher priority sources get multiplicative boost to their scores
// before greedy fill, ensuring they're selected first.

const PRIORITY_BOOSTS: Record<SearchSource, number> = {
  semantic: 1.3,
  graph: 1.1,
  episodic: 1.0,
};

// ─── Token Estimation ───────────────────────────────────────────

/** Estimate token count from character length: chars/4 with 1.1x safety factor */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.1);
}

// ─── Budget Options ─────────────────────────────────────────────

export interface BudgetOptions {
  /** Override default priority boosts per source */
  priorityBoosts?: Partial<Record<SearchSource, number>>;
  /** If true, recalculate tokenEstimate using estimateTokens() instead of trusting result.tokenEstimate */
  recalculateTokens?: boolean;
}

// ─── Budget Allocation ──────────────────────────────────────────

/**
 * Allocate a token budget across search results using priority-weighted greedy fill.
 *
 * Algorithm:
 * 1. Apply priority boost to each result's score based on its source type
 * 2. Sort by boosted score descending (semantic first, then graph, then episodic)
 * 3. Greedily fill results until budget is exhausted
 *
 * Priority classes (default boosts):
 * - semantic: 1.3x (highest signal density — extracted knowledge)
 * - graph: 1.1x (compact entity summaries)
 * - episodic: 1.0x (raw conversation exchanges)
 */
export function allocateBudget(
  results: SearchResult[],
  budget: number,
  options?: BudgetOptions,
): SearchResult[] {
  if (results.length === 0 || budget <= 0) return [];

  const boosts = { ...PRIORITY_BOOSTS, ...options?.priorityBoosts };

  // Build sortable list with boosted scores
  const scored = results.map((result) => ({
    result,
    boostedScore: result.score * (boosts[result.source] ?? 1.0),
  }));

  // Sort by boosted score descending
  scored.sort((a, b) => b.boostedScore - a.boostedScore);

  // Greedy fill
  const selected: SearchResult[] = [];
  let used = 0;

  for (const { result } of scored) {
    const tokens = options?.recalculateTokens
      ? estimateTokens(result.content)
      : result.tokenEstimate;

    if (used + tokens > budget) continue;
    selected.push(result);
    used += tokens;
  }

  return selected;
}
