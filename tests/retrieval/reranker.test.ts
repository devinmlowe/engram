import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeScores,
  blendScores,
  rerankResults,
  resetReranker,
  isRerankerAvailable,
} from "../../src/retrieval/reranker.js";
import type { SearchResult } from "../../src/core/types.js";

// ─── Score Normalization Tests ──────────────────────────────────

describe("normalizeScores", () => {
  it("normalizes scores to [0, 1] using min-max scaling", () => {
    const scores = [10, 5, 1];
    const normalized = normalizeScores(scores);

    expect(normalized[0]).toBeCloseTo(1.0);
    expect(normalized[1]).toBeCloseTo(4 / 9); // (5-1)/(10-1)
    expect(normalized[2]).toBeCloseTo(0.0);
  });

  it("returns [1.0] for single score", () => {
    const normalized = normalizeScores([42]);
    expect(normalized).toEqual([1.0]);
  });

  it("returns 0.5 for all identical scores", () => {
    const normalized = normalizeScores([7, 7, 7]);
    expect(normalized).toEqual([0.5, 0.5, 0.5]);
  });

  it("returns empty array for empty input", () => {
    expect(normalizeScores([])).toEqual([]);
  });

  it("handles negative scores", () => {
    const normalized = normalizeScores([-5, 0, 5]);
    expect(normalized[0]).toBeCloseTo(0.0);
    expect(normalized[1]).toBeCloseTo(0.5);
    expect(normalized[2]).toBeCloseTo(1.0);
  });

  it("preserves order for already sorted scores", () => {
    const normalized = normalizeScores([100, 50, 25, 0]);
    for (let i = 0; i < normalized.length - 1; i++) {
      expect(normalized[i]).toBeGreaterThan(normalized[i + 1]);
    }
  });
});

// ─── Score Blending Tests ───────────────────────────────────────

describe("blendScores", () => {
  it("blends with default weight 0.7 reranker + 0.3 original", () => {
    const rerankerScores = [1.0, 0.5, 0.0];
    const originalScores = [0.0, 0.5, 1.0];
    const blended = blendScores(rerankerScores, originalScores, 0.7);

    // first: 0.7*1.0 + 0.3*0.0 = 0.7
    expect(blended[0]).toBeCloseTo(0.7);
    // second: 0.7*0.5 + 0.3*0.5 = 0.5
    expect(blended[1]).toBeCloseTo(0.5);
    // third: 0.7*0.0 + 0.3*1.0 = 0.3
    expect(blended[2]).toBeCloseTo(0.3);
  });

  it("with blendWeight=1.0, uses only reranker scores", () => {
    const rerankerScores = [0.9, 0.1];
    const originalScores = [0.1, 0.9];
    const blended = blendScores(rerankerScores, originalScores, 1.0);

    expect(blended[0]).toBeCloseTo(0.9);
    expect(blended[1]).toBeCloseTo(0.1);
  });

  it("with blendWeight=0.0, uses only original scores", () => {
    const rerankerScores = [0.9, 0.1];
    const originalScores = [0.1, 0.9];
    const blended = blendScores(rerankerScores, originalScores, 0.0);

    expect(blended[0]).toBeCloseTo(0.1);
    expect(blended[1]).toBeCloseTo(0.9);
  });

  it("handles mismatched lengths gracefully", () => {
    const rerankerScores = [0.8, 0.6, 0.4];
    const originalScores = [0.5]; // shorter
    const blended = blendScores(rerankerScores, originalScores, 0.5);

    expect(blended[0]).toBeCloseTo(0.65); // 0.5*0.8 + 0.5*0.5
    expect(blended[1]).toBeCloseTo(0.3); // 0.5*0.6 + 0.5*0
    expect(blended[2]).toBeCloseTo(0.2); // 0.5*0.4 + 0.5*0
  });
});

// ─── Reranker Integration Tests ─────────────────────────────────

function makeCandidate(
  id: string,
  score: number,
  content: string,
): SearchResult {
  return {
    id,
    source: "episodic",
    score,
    content,
    metadata: {},
    tokenEstimate: 50,
  };
}

describe("rerankResults", () => {
  beforeEach(() => {
    resetReranker();
    vi.restoreAllMocks();
  });

  it("returns top K results when reranker is unavailable (graceful degradation)", async () => {
    // Mock the dynamic import to simulate model load failure
    vi.doMock("@xenova/transformers", () => ({
      pipeline: vi.fn().mockRejectedValue(new Error("Model not found")),
    }));

    const candidates = [
      makeCandidate("a", 0.9, "First result"),
      makeCandidate("b", 0.8, "Second result"),
      makeCandidate("c", 0.7, "Third result"),
      makeCandidate("d", 0.6, "Fourth result"),
    ];

    const result = await rerankResults("test query", candidates, { topK: 2 });

    // Should return first 2 in original order (graceful degradation)
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  it("returns empty array for empty candidates", async () => {
    const result = await rerankResults("test query", [], { topK: 5 });
    expect(result).toEqual([]);
  });

  it("respects topK parameter", async () => {
    const candidates = [
      makeCandidate("a", 0.9, "First"),
      makeCandidate("b", 0.8, "Second"),
      makeCandidate("c", 0.7, "Third"),
      makeCandidate("d", 0.6, "Fourth"),
      makeCandidate("e", 0.5, "Fifth"),
    ];

    // Without reranker loaded, should return topK from original order
    const result = await rerankResults("test query", candidates, { topK: 3 });
    expect(result).toHaveLength(3);
  });

  it("isRerankerAvailable returns false before initialization", () => {
    expect(isRerankerAvailable()).toBe(false);
  });
});

// ─── Score Pipeline Integration ─────────────────────────────────

describe("score pipeline (normalize + blend)", () => {
  it("full pipeline: normalize then blend produces valid scores", () => {
    // Simulate raw cross-encoder logits
    const rawLogits = [3.5, 1.2, -0.5, 2.8];
    const originalRrfScores = [0.85, 0.72, 0.65, 0.58];

    // Step 1: Normalize logits
    const normalized = normalizeScores(rawLogits);
    expect(normalized[0]).toBeCloseTo(1.0); // highest logit
    expect(normalized[2]).toBeCloseTo(0.0); // lowest logit

    // Step 2: Blend with original
    const blended = blendScores(normalized, originalRrfScores, 0.7);

    // All blended scores should be in [0, 1]
    for (const score of blended) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }

    // Highest reranker score (index 0) should still be highest after blending
    expect(blended[0]).toBeGreaterThan(blended[2]);
  });

  it("blending with weight 0.5 averages the two score sources", () => {
    const reranker = [1.0, 0.0];
    const original = [0.0, 1.0];
    const blended = blendScores(reranker, original, 0.5);

    expect(blended[0]).toBeCloseTo(0.5);
    expect(blended[1]).toBeCloseTo(0.5);
  });
});
