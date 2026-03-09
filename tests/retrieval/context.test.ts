import { describe, it, expect } from "vitest";
import { allocateBudget, estimateTokens } from "../../src/_core/search/budget.js";
import type { SearchResult } from "../../src/_core/types/index.js";

function makeResult(
  id: string,
  source: "semantic" | "graph" | "episodic",
  score: number,
  tokenEstimate: number,
): SearchResult {
  return {
    id,
    source,
    score,
    content: `Content for ${id}`,
    metadata: {},
    tokenEstimate,
  };
}

describe("estimateTokens", () => {
  it("estimates tokens as chars/4 with 1.1x safety factor", () => {
    // 100 chars → 100/4 * 1.1 = 27.5 → ceil → 28
    const text = "a".repeat(100);
    expect(estimateTokens(text)).toBe(28);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("allocateBudget", () => {
  it("returns empty array for empty input", () => {
    expect(allocateBudget([], 1000)).toEqual([]);
  });

  it("returns empty array for zero budget", () => {
    const results = [makeResult("r1", "semantic", 0.9, 100)];
    expect(allocateBudget(results, 0)).toEqual([]);
  });

  it("prioritizes semantic results via 1.3x boost", () => {
    const results = [
      makeResult("ep1", "episodic", 0.9, 100), // boosted: 0.9 * 1.0 = 0.9
      makeResult("sem1", "semantic", 0.8, 100), // boosted: 0.8 * 1.3 = 1.04
    ];
    const budgeted = allocateBudget(results, 500);
    expect(budgeted[0].id).toBe("sem1");
    expect(budgeted[1].id).toBe("ep1");
  });

  it("prioritizes graph results over episodic via 1.1x boost", () => {
    const results = [
      makeResult("ep1", "episodic", 0.85, 100), // boosted: 0.85 * 1.0 = 0.85
      makeResult("g1", "graph", 0.8, 100), // boosted: 0.8 * 1.1 = 0.88
    ];
    const budgeted = allocateBudget(results, 500);
    expect(budgeted[0].id).toBe("g1");
    expect(budgeted[1].id).toBe("ep1");
  });

  it("respects token budget — excludes results that exceed remaining budget", () => {
    const results = [
      makeResult("sem1", "semantic", 0.9, 600),
      makeResult("sem2", "semantic", 0.8, 600),
      makeResult("ep1", "episodic", 0.7, 300),
    ];
    // Budget = 1000. sem1 (600) fits, sem2 (600) doesn't (total 1200), ep1 (300) fits (900)
    const budgeted = allocateBudget(results, 1000);
    expect(budgeted).toHaveLength(2);
    expect(budgeted.map((r) => r.id)).toEqual(["sem1", "ep1"]);
  });

  it("handles mixed result types with correct priority ordering", () => {
    const results = [
      makeResult("ep1", "episodic", 0.95, 200),
      makeResult("sem1", "semantic", 0.7, 200),
      makeResult("g1", "graph", 0.85, 200),
      makeResult("ep2", "episodic", 0.6, 200),
      makeResult("sem2", "semantic", 0.5, 200),
    ];
    // Boosted scores:
    // sem1: 0.7 * 1.3 = 0.91
    // g1:   0.85 * 1.1 = 0.935
    // ep1:  0.95 * 1.0 = 0.95
    // sem2: 0.5 * 1.3 = 0.65
    // ep2:  0.6 * 1.0 = 0.6
    // Order: ep1 (0.95), g1 (0.935), sem1 (0.91), sem2 (0.65), ep2 (0.6)
    const budgeted = allocateBudget(results, 2000);
    expect(budgeted.map((r) => r.id)).toEqual([
      "ep1",
      "g1",
      "sem1",
      "sem2",
      "ep2",
    ]);
  });

  it("selects no results if all exceed budget", () => {
    const results = [
      makeResult("r1", "semantic", 0.9, 500),
      makeResult("r2", "graph", 0.8, 500),
    ];
    const budgeted = allocateBudget(results, 100);
    expect(budgeted).toHaveLength(0);
  });

  it("supports custom priority boosts", () => {
    const results = [
      makeResult("ep1", "episodic", 0.5, 100), // boosted: 0.5 * 2.0 = 1.0
      makeResult("sem1", "semantic", 0.8, 100), // boosted: 0.8 * 1.0 = 0.8
    ];
    const budgeted = allocateBudget(results, 500, {
      priorityBoosts: { episodic: 2.0, semantic: 1.0 },
    });
    expect(budgeted[0].id).toBe("ep1");
  });

  it("can recalculate tokens from content", () => {
    const result: SearchResult = {
      id: "r1",
      source: "semantic",
      score: 0.9,
      content: "a".repeat(400), // estimateTokens → ceil(400/4 * 1.1) = 110
      metadata: {},
      tokenEstimate: 50, // Intentionally wrong stored estimate
    };
    // With recalculate, should use 110 not 50
    const budgeted = allocateBudget([result], 100, {
      recalculateTokens: true,
    });
    expect(budgeted).toHaveLength(0); // 110 > 100, should be excluded

    // Without recalculate, uses stored 50
    const budgeted2 = allocateBudget([result], 100);
    expect(budgeted2).toHaveLength(1);
  });
});
