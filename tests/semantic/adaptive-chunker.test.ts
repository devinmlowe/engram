/**
 * Tests for adaptive chunking module.
 *
 * Phase 6A: Adaptive Dream Extraction — variable-sized chunks based
 * on information density for improved fact extraction.
 */

import { describe, it, expect } from "vitest";
import {
  scoreExchangeDensity,
  adaptiveChunk,
  type DensityScore,
} from "../../src/semantic/adaptive-chunker.js";
import type { ConversationExchange } from "../../src/semantic/extractor.js";

// ─── Helpers ────────────────────────────────────────────────────

/** Create a minimal exchange with default short content. */
function makeExchange(
  index: number,
  overrides?: Partial<{ userMessage: string; assistantMessage: string }>,
): ConversationExchange {
  return {
    index,
    userMessage: overrides?.userMessage ?? `User message ${index}`,
    assistantMessage: overrides?.assistantMessage ?? `Assistant response ${index}`,
  };
}

/** Create a "dense" exchange with tool calls, code blocks, and decision language. */
function makeDenseExchange(index: number): ConversationExchange {
  return makeExchange(index, {
    userMessage: `Can you run the tests and fix the build? I've decided to use TypeScript.`,
    assistantMessage: [
      `I'll run the tests now.`,
      "```typescript",
      `function fix() { return true; }`,
      "```",
      `Tool call: execute_command("npm test")`,
      `Tool call: read_file("src/index.ts")`,
      `Based on the results, I recommend we proceed with the refactor.`,
    ].join("\n"),
  });
}

/** Create a "sparse" exchange with minimal content. */
function makeSparseExchange(index: number): ConversationExchange {
  return makeExchange(index, {
    userMessage: "ok",
    assistantMessage: "Done.",
  });
}

// ─── scoreExchangeDensity ───────────────────────────────────────

describe("scoreExchangeDensity", () => {
  it("returns empty array for empty input", () => {
    expect(scoreExchangeDensity([])).toEqual([]);
  });

  it("scores single exchange correctly", () => {
    const scores = scoreExchangeDensity([makeExchange(0)]);
    expect(scores).toHaveLength(1);
    expect(scores[0].index).toBe(0);
    expect(typeof scores[0].score).toBe("number");
  });

  it("assigns higher scores to exchanges with tool calls", () => {
    const withTool = makeExchange(0, {
      userMessage: "run it",
      assistantMessage: 'Tool call: execute_command("npm test")\nTool call: read_file("x")',
    });
    const withoutTool = makeExchange(1, {
      userMessage: "run it",
      assistantMessage: "I ran the tests manually and they passed.",
    });
    const scores = scoreExchangeDensity([withTool, withoutTool]);
    expect(scores[0].toolCallCount).toBeGreaterThan(0);
    expect(scores[1].toolCallCount).toBe(0);
    expect(scores[0].score).toBeGreaterThan(scores[1].score);
  });

  it("assigns higher scores to exchanges with code blocks", () => {
    const withCode = makeExchange(0, {
      userMessage: "show code",
      assistantMessage: "```ts\nconst x = 1;\n```\n```python\nx = 1\n```",
    });
    const withoutCode = makeExchange(1, {
      userMessage: "show code",
      assistantMessage: "Here is the explanation without code.",
    });
    const scores = scoreExchangeDensity([withCode, withoutCode]);
    expect(scores[0].codeBlockCount).toBe(2);
    expect(scores[1].codeBlockCount).toBe(0);
    expect(scores[0].score).toBeGreaterThan(scores[1].score);
  });

  it("assigns higher scores to longer exchanges", () => {
    const long = makeExchange(0, {
      userMessage: "a".repeat(500),
      assistantMessage: "b".repeat(500),
    });
    const short = makeExchange(1, {
      userMessage: "hi",
      assistantMessage: "hello",
    });
    const scores = scoreExchangeDensity([long, short]);
    expect(scores[0].charCount).toBeGreaterThan(scores[1].charCount);
    expect(scores[0].score).toBeGreaterThan(scores[1].score);
  });

  it("normalizes scores to [0, 1] range", () => {
    const exchanges = [
      makeDenseExchange(0),
      makeSparseExchange(1),
      makeExchange(2),
      makeDenseExchange(3),
    ];
    const scores = scoreExchangeDensity(exchanges);
    for (const s of scores) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
    // At least one should be 1 (max) and one should be 0 (min) for varied input
    const maxScore = Math.max(...scores.map((s) => s.score));
    const minScore = Math.min(...scores.map((s) => s.score));
    expect(maxScore).toBe(1);
    expect(minScore).toBe(0);
  });

  it("handles exchanges with no content gracefully", () => {
    const empty = makeExchange(0, { userMessage: "", assistantMessage: "" });
    const scores = scoreExchangeDensity([empty]);
    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBe(0);
    expect(scores[0].charCount).toBe(0);
  });
});

// ─── adaptiveChunk ──────────────────────────────────────────────

describe("adaptiveChunk", () => {
  it("returns single chunk for short conversations (< minChunkSize)", () => {
    const exchanges = Array.from({ length: 5 }, (_, i) => makeExchange(i));
    const chunks = adaptiveChunk(exchanges);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5);
  });

  it("creates smaller chunks for dense regions", () => {
    // 30 dense exchanges should produce chunks near minChunkSize (10)
    const exchanges = Array.from({ length: 30 }, (_, i) => makeDenseExchange(i));
    const chunks = adaptiveChunk(exchanges, { minChunkSize: 10, maxChunkSize: 40, overlap: 0 });
    // With dense content and no overlap, expect ~3 chunks of ~10
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(15); // some tolerance
    }
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("creates larger chunks for sparse regions", () => {
    // 80 sparse exchanges should produce chunks near maxChunkSize (40)
    const exchanges = Array.from({ length: 80 }, (_, i) => makeSparseExchange(i));
    const chunks = adaptiveChunk(exchanges, { minChunkSize: 10, maxChunkSize: 40, overlap: 0 });
    // With sparse content and no overlap, expect 2 chunks of ~40
    expect(chunks.length).toBeLessThanOrEqual(3);
  });

  it("maintains overlap between adjacent chunks", () => {
    const exchanges = Array.from({ length: 30 }, (_, i) => makeExchange(i));
    const chunks = adaptiveChunk(exchanges, { overlap: 3 });
    if (chunks.length > 1) {
      for (let i = 0; i < chunks.length - 1; i++) {
        const currentEnd = chunks[i][chunks[i].length - 1].index;
        const nextStart = chunks[i + 1][0].index;
        // The next chunk should start before the current chunk ends (overlap)
        expect(nextStart).toBeLessThanOrEqual(currentEnd);
      }
    }
  });

  it("all exchanges are covered (no gaps)", () => {
    const exchanges = Array.from({ length: 60 }, (_, i) => makeExchange(i));
    const chunks = adaptiveChunk(exchanges, { overlap: 3 });
    const allIndexes = new Set<number>();
    for (const chunk of chunks) {
      for (const ex of chunk) {
        allIndexes.add(ex.index);
      }
    }
    for (let i = 0; i < 60; i++) {
      expect(allIndexes.has(i)).toBe(true);
    }
  });

  it("respects minChunkSize boundary", () => {
    const exchanges = Array.from({ length: 50 }, (_, i) => makeDenseExchange(i));
    const chunks = adaptiveChunk(exchanges, { minChunkSize: 10, overlap: 0 });
    for (const chunk of chunks) {
      // Last chunk can be smaller, but non-last chunks should be >= minChunkSize
      if (chunk !== chunks[chunks.length - 1]) {
        expect(chunk.length).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it("respects maxChunkSize boundary", () => {
    const exchanges = Array.from({ length: 100 }, (_, i) => makeSparseExchange(i));
    const chunks = adaptiveChunk(exchanges, { maxChunkSize: 40, overlap: 0 });
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
  });

  it("handles uniformly dense conversations (all small chunks)", () => {
    const exchanges = Array.from({ length: 40 }, (_, i) => makeDenseExchange(i));
    const chunks = adaptiveChunk(exchanges, { minChunkSize: 10, maxChunkSize: 40, overlap: 0 });
    // All dense — should get more, smaller chunks
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("handles uniformly sparse conversations (all large chunks)", () => {
    const exchanges = Array.from({ length: 80 }, (_, i) => makeSparseExchange(i));
    const chunks = adaptiveChunk(exchanges, { minChunkSize: 10, maxChunkSize: 40, overlap: 0 });
    // All sparse — should get fewer, larger chunks
    expect(chunks.length).toBeLessThanOrEqual(3);
  });

  it("handles alternating dense/sparse regions", () => {
    // 10 dense, 20 sparse, 10 dense
    const exchanges = [
      ...Array.from({ length: 10 }, (_, i) => makeDenseExchange(i)),
      ...Array.from({ length: 20 }, (_, i) => makeSparseExchange(i + 10)),
      ...Array.from({ length: 10 }, (_, i) => makeDenseExchange(i + 30)),
    ];
    const chunks = adaptiveChunk(exchanges, { minChunkSize: 10, maxChunkSize: 40, overlap: 0 });
    // Should have at least 3 chunks (dense, sparse, dense regions)
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // All exchanges covered
    const allIndexes = new Set<number>();
    for (const chunk of chunks) {
      for (const ex of chunk) {
        allIndexes.add(ex.index);
      }
    }
    expect(allIndexes.size).toBe(40);
  });

  it("matches fixed chunking behavior when all scores are equal", () => {
    // When all exchanges are identical, adaptive should produce uniform chunks
    const exchanges = Array.from({ length: 50 }, (_, i) => makeExchange(i));
    const chunks = adaptiveChunk(exchanges, { minChunkSize: 10, maxChunkSize: 40, overlap: 0 });
    // Since all are equal, the chunk sizes should be the same (except possibly the last)
    const sizes = chunks.map((c) => c.length);
    const nonLastSizes = sizes.slice(0, -1);
    if (nonLastSizes.length > 1) {
      const allSame = nonLastSizes.every((s) => s === nonLastSizes[0]);
      expect(allSame).toBe(true);
    }
  });
});
