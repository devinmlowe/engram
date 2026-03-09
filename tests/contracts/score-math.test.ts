/**
 * Contract: Score Math Stability
 *
 * RRF fusion and score normalization are pure math functions. If their output
 * changes even slightly during extraction to _core/search/, ranking changes,
 * which shifts what memories fit within a token budget. This is the most
 * insidious failure mode: tests pass, but users get different results.
 *
 * These tests pin exact numerical outputs for known inputs.
 */

import { describe, it, expect } from "vitest";
import {
  rrfFuse,
  normalizeMinMaxFloored,
} from "../../src/episodic/search.js";
import { allocateBudget } from "../../src/retrieval/context.js";
import type { SearchResult } from "../../src/_core/types/index.js";

// ── RRF Fusion Pinned Outputs ────────────────────────────────────

describe("RRF Fusion Contract", () => {
  it("produces exact scores for known input (k=60 default)", () => {
    const vector = [
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
      { id: "c", rank: 3 },
    ];
    const fts = [
      { id: "b", rank: 1 },
      { id: "c", rank: 2 },
      { id: "d", rank: 3 },
    ];

    const result = rrfFuse(vector, fts);

    // b appears in both lists: 1/(60+2) + 1/(60+1) = 0.01613 + 0.01639 = 0.03252
    // c appears in both: 1/(60+3) + 1/(60+2) = 0.01587 + 0.01613 = 0.03200
    // a appears once: 1/(60+1) = 0.01639
    // d appears once: 1/(60+3) = 0.01587

    expect(result[0].id).toBe("b");
    expect(result[1].id).toBe("c");
    expect(result[2].id).toBe("a");
    expect(result[3].id).toBe("d");

    // Pin exact scores to 10 decimal places
    expect(result[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(result[1].score).toBeCloseTo(1 / 63 + 1 / 62, 10);
    expect(result[2].score).toBeCloseTo(1 / 61, 10);
    expect(result[3].score).toBeCloseTo(1 / 63, 10);
  });

  it("custom k value changes scores predictably", () => {
    const a = [{ id: "x", rank: 1 }];
    const b = [{ id: "x", rank: 1 }];

    const k30 = rrfFuse(a, b, 30);
    const k60 = rrfFuse(a, b, 60);
    const k120 = rrfFuse(a, b, 120);

    // k=30: 2 * 1/31 = 0.06452
    // k=60: 2 * 1/61 = 0.03279
    // k=120: 2 * 1/121 = 0.01653
    expect(k30[0].score).toBeCloseTo(2 / 31, 10);
    expect(k60[0].score).toBeCloseTo(2 / 61, 10);
    expect(k120[0].score).toBeCloseTo(2 / 121, 10);

    // Higher k compresses scores
    expect(k30[0].score).toBeGreaterThan(k60[0].score);
    expect(k60[0].score).toBeGreaterThan(k120[0].score);
  });

  it("ordering is stable: same-score items maintain insertion order", () => {
    // Two items that only appear in one list each, at same rank
    const vector = [{ id: "first", rank: 5 }];
    const fts = [{ id: "second", rank: 5 }];

    const result = rrfFuse(vector, fts);
    expect(result[0].score).toBe(result[1].score);
    // Map insertion order: "first" entered first
    expect(result[0].id).toBe("first");
    expect(result[1].id).toBe("second");
  });

  it("empty inputs produce empty output", () => {
    expect(rrfFuse([], [])).toEqual([]);
    expect(rrfFuse([{ id: "a", rank: 1 }], [])).toHaveLength(1);
    expect(rrfFuse([], [{ id: "a", rank: 1 }])).toHaveLength(1);
  });

  it("single-item lists fuse correctly", () => {
    const result = rrfFuse(
      [{ id: "only", rank: 1 }],
      [{ id: "only", rank: 1 }],
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("only");
    expect(result[0].score).toBeCloseTo(2 / 61, 10);
  });
});

// ── Score Normalization Pinned Outputs ───────────────────────────

describe("Score Normalization Contract", () => {
  it("normalizes to [floor, 1.0] with exact boundaries", () => {
    const results = [
      { id: "best", score: 0.05 },
      { id: "mid", score: 0.03 },
      { id: "worst", score: 0.01 },
    ];

    normalizeMinMaxFloored(results, 0.1);

    expect(results[0].score).toBeCloseTo(1.0, 10);
    expect(results[2].score).toBeCloseTo(0.1, 10);
    // Mid should be exactly: 0.1 + 0.9 * (0.03 - 0.01) / (0.05 - 0.01) = 0.55
    expect(results[1].score).toBeCloseTo(0.55, 10);
  });

  it("single item gets score 0.85", () => {
    const results = [{ id: "solo", score: 0.42 }];
    normalizeMinMaxFloored(results);
    expect(results[0].score).toBe(0.85);
  });

  it("equal scores all become 0.5", () => {
    const results = [
      { id: "a", score: 0.03 },
      { id: "b", score: 0.03 },
      { id: "c", score: 0.03 },
    ];
    normalizeMinMaxFloored(results);
    for (const r of results) {
      expect(r.score).toBe(0.5);
    }
  });

  it("empty array is a no-op", () => {
    const results: { id: string; score: number }[] = [];
    normalizeMinMaxFloored(results);
    expect(results).toEqual([]);
  });

  it("mutates in place, does not create new array", () => {
    const original = [
      { id: "a", score: 0.1 },
      { id: "b", score: 0.05 },
    ];
    const ref = original;
    normalizeMinMaxFloored(original);
    expect(ref).toBe(original); // same reference
    expect(ref[0].score).toBe(1.0); // mutated
  });

  it("custom floor value works", () => {
    const results = [
      { id: "a", score: 0.1 },
      { id: "b", score: 0.05 },
    ];
    normalizeMinMaxFloored(results, 0.3);
    expect(results[0].score).toBeCloseTo(1.0, 10);
    expect(results[1].score).toBeCloseTo(0.3, 10);
  });
});

// ── Budget Allocation Contract ───────────────────────────────────

describe("Budget Allocation Contract", () => {
  function makeResult(
    id: string,
    source: "episodic" | "semantic" | "graph",
    tokens: number,
    score: number = 0.5,
  ): SearchResult {
    return {
      id,
      source,
      score,
      content: "x".repeat(tokens * 4), // ~tokens
      metadata: {},
      tokenEstimate: tokens,
    };
  }

  it("semantic results are prioritized over episodic at equal scores", () => {
    const results = [
      makeResult("ep1", "episodic", 100, 0.9),
      makeResult("sem1", "semantic", 100, 0.9),
      makeResult("ep2", "episodic", 100, 0.8),
    ];

    const allocated = allocateBudget(results, 200);

    // Semantic gets 1.3x boost, so sem1 should come first
    expect(allocated[0].id).toBe("sem1");
  });

  it("graph results are prioritized over episodic at equal scores", () => {
    const results = [
      makeResult("ep1", "episodic", 100, 0.9),
      makeResult("gr1", "graph", 100, 0.9),
    ];

    const allocated = allocateBudget(results, 200);
    expect(allocated[0].id).toBe("gr1");
  });

  it("budget is respected exactly — no single-token overflow", () => {
    const results = [
      makeResult("a", "semantic", 100, 0.9),
      makeResult("b", "semantic", 100, 0.8),
      makeResult("c", "semantic", 100, 0.7),
    ];

    const allocated = allocateBudget(results, 200);
    const totalTokens = allocated.reduce((sum, r) => sum + r.tokenEstimate, 0);
    expect(totalTokens).toBeLessThanOrEqual(200);
    expect(allocated).toHaveLength(2); // exactly 2 fit
  });

  it("empty results yield empty allocation", () => {
    expect(allocateBudget([], 1000)).toEqual([]);
  });

  it("zero budget yields empty allocation", () => {
    const results = [makeResult("a", "semantic", 50)];
    expect(allocateBudget(results, 0)).toEqual([]);
  });

  it("single result that exceeds budget is excluded", () => {
    const results = [makeResult("a", "semantic", 500)];
    expect(allocateBudget(results, 200)).toEqual([]);
  });

  it("priority ordering: semantic > graph > episodic", () => {
    // All same score — priority boost determines order
    const results = [
      makeResult("ep", "episodic", 50, 0.5),
      makeResult("gr", "graph", 50, 0.5),
      makeResult("sem", "semantic", 50, 0.5),
    ];

    const allocated = allocateBudget(results, 1000);
    expect(allocated[0].id).toBe("sem");
    expect(allocated[1].id).toBe("gr");
    expect(allocated[2].id).toBe("ep");
  });
});
