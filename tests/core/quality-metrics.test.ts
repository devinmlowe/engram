/**
 * Unit tests for computeQualityMetrics — Phase 7A.2.
 */

import { describe, it, expect } from "vitest";
import { computeQualityMetrics } from "../../src/_core/search/session.js";
import type { SearchResult } from "../../src/_core/types/index.js";

function makeResult(score: number): SearchResult {
  return {
    id: crypto.randomUUID(),
    source: "semantic",
    score,
    content: "test content",
    metadata: {},
    tokenEstimate: 50,
  };
}

describe("computeQualityMetrics", () => {
  it("returns zeros and 'done' for empty results", () => {
    const metrics = computeQualityMetrics([]);
    expect(metrics).toEqual({
      averageScore: 0,
      scoreSpread: 0,
      topResultStrength: 0,
      recommendAction: "done",
    });
  });

  it("recommends 'drill' for a single high-score result", () => {
    const metrics = computeQualityMetrics([makeResult(0.8)]);
    expect(metrics.topResultStrength).toBe(0.8);
    expect(metrics.scoreSpread).toBe(0);
    expect(metrics.averageScore).toBe(0.8);
    expect(metrics.recommendAction).toBe("drill");
  });

  it("recommends 'drill' for tight cluster of high scores", () => {
    const metrics = computeQualityMetrics([
      makeResult(0.7),
      makeResult(0.75),
      makeResult(0.8),
    ]);
    expect(metrics.topResultStrength).toBe(0.8);
    expect(metrics.scoreSpread).toBeCloseTo(0.1, 5);
    expect(metrics.averageScore).toBeCloseTo(0.75, 5);
    expect(metrics.recommendAction).toBe("drill");
  });

  it("recommends 'refine' for wide spread (noisy results)", () => {
    const metrics = computeQualityMetrics([
      makeResult(0.1),
      makeResult(0.5),
      makeResult(0.9),
    ]);
    expect(metrics.topResultStrength).toBe(0.9);
    expect(metrics.scoreSpread).toBeCloseTo(0.8, 5);
    expect(metrics.recommendAction).toBe("refine");
  });

  it("recommends 'refine' for low scores", () => {
    const metrics = computeQualityMetrics([
      makeResult(0.1),
      makeResult(0.2),
    ]);
    expect(metrics.topResultStrength).toBe(0.2);
    expect(metrics.scoreSpread).toBeCloseTo(0.1, 5);
    expect(metrics.recommendAction).toBe("refine");
  });

  it("returns 'done' for budget-exhausted scenario (empty refinement)", () => {
    // When refinement returns no results, same as empty
    const metrics = computeQualityMetrics([]);
    expect(metrics.recommendAction).toBe("done");
  });

  it("calculates averageScore and scoreSpread correctly", () => {
    const metrics = computeQualityMetrics([
      makeResult(0.2),
      makeResult(0.4),
      makeResult(0.6),
      makeResult(0.8),
    ]);
    expect(metrics.averageScore).toBeCloseTo(0.5, 5);
    expect(metrics.scoreSpread).toBeCloseTo(0.6, 5);
    expect(metrics.topResultStrength).toBe(0.8);
  });
});
