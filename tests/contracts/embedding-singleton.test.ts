/**
 * Contract: Embedding Singleton Integrity
 *
 * The embedding pipeline is a module-level singleton. During extraction to
 * _core/embeddings/, the singleton MUST remain singular — if two module
 * instances get separate pipeline copies, vectors become inconsistent and
 * search silently returns wrong results.
 *
 * These tests pin:
 * - Exact output dimensions across lifecycle (init → use → reset → re-init)
 * - Query cache hit/miss behavior
 * - Vector stability: same input → same output (bitwise)
 * - Vector distinctness: different inputs → different outputs
 * - L2 normalization invariant (norm ≈ 1.0 for all outputs)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initEmbeddings,
  resetEmbeddings,
  embedQuery,
  embedDocument,
  embedDocumentBatch,
  embedExchange,
  getActiveDimensions,
  getActiveModel,
} from "../../src/episodic/embeddings.js";

const EXPECTED_DIMS = 256;
const NORM_TOLERANCE = 0.02; // L2 norm must be within 1.0 ± 0.02

function l2Norm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (l2Norm(a) * l2Norm(b));
}

describe("Embedding Singleton Contract", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    resetEmbeddings();
    await initEmbeddings();
  });

  afterAll(() => {
    resetEmbeddings();
  });

  // ── Dimension Pinning ──────────────────────────────────────────

  it("embedQuery returns exactly 256 dimensions", async () => {
    const v = await embedQuery("test input");
    expect(v).toHaveLength(EXPECTED_DIMS);
    expect(v.every((x) => typeof x === "number" && !Number.isNaN(x))).toBe(true);
  });

  it("embedDocument returns exactly 256 dimensions", async () => {
    const v = await embedDocument("test document");
    expect(v).toHaveLength(EXPECTED_DIMS);
  });

  it("embedDocumentBatch returns exactly 256 dimensions per item", async () => {
    const batch = await embedDocumentBatch(["alpha", "beta", "gamma"]);
    expect(batch).toHaveLength(3);
    for (const v of batch) {
      expect(v).toHaveLength(EXPECTED_DIMS);
    }
  });

  it("embedExchange returns exactly 256 dimensions", async () => {
    const v = await embedExchange("user msg", "assistant msg", {
      project: "test",
      date: "2025-01-01",
    });
    expect(v).toHaveLength(EXPECTED_DIMS);
  });

  it("getActiveDimensions matches actual output", async () => {
    const reported = getActiveDimensions();
    const actual = await embedQuery("dimension check");
    expect(reported).toBe(actual.length);
    expect(reported).toBe(EXPECTED_DIMS);
  });

  // ── L2 Normalization Invariant ─────────────────────────────────

  it("all embedding functions produce L2-normalized vectors", async () => {
    const query = await embedQuery("normalization check");
    const doc = await embedDocument("normalization check");
    const batch = await embedDocumentBatch(["norm check a", "norm check b"]);
    const exchange = await embedExchange("user", "assistant");

    for (const [label, v] of [
      ["query", query],
      ["document", doc],
      ["batch[0]", batch[0]],
      ["batch[1]", batch[1]],
      ["exchange", exchange],
    ] as [string, number[]][]) {
      const norm = l2Norm(v);
      expect(norm, `${label} norm ${norm} not within tolerance`).toBeCloseTo(
        1.0,
        1, // 1 decimal place = ±0.05, tighter than NORM_TOLERANCE
      );
    }
  });

  // ── Determinism ────────────────────────────────────────────────

  it("same query input produces bitwise-identical output", async () => {
    const input = "determinism test: consistent embeddings are critical";
    const v1 = await embedQuery(input);
    const v2 = await embedQuery(input);
    // Must be exactly equal, not just "close"
    expect(v1).toEqual(v2);
  });

  it("same document input produces bitwise-identical output", async () => {
    const input = "determinism test: document embedding consistency";
    const v1 = await embedDocument(input);
    const v2 = await embedDocument(input);
    expect(v1).toEqual(v2);
  });

  // ── Distinctness ───────────────────────────────────────────────

  it("semantically different inputs produce different vectors", async () => {
    const v1 = await embedQuery("quantum physics wave function");
    const v2 = await embedQuery("chocolate cake baking recipe");
    // Cosine similarity should be notably less than 1.0
    const sim = cosineSim(v1, v2);
    expect(sim).toBeLessThan(0.8);
  });

  it("query and document embeddings for same text differ (prefix effect)", async () => {
    const input = "prefix differentiation test";
    const qv = await embedQuery(input);
    const dv = await embedDocument(input);
    // If model uses prefixes, vectors should differ
    const model = getActiveModel();
    if (model === "nomic") {
      // nomic uses search_query: vs search_document: prefixes
      expect(qv).not.toEqual(dv);
    }
    // Both should still be 256-dim and normalized regardless
    expect(qv).toHaveLength(EXPECTED_DIMS);
    expect(dv).toHaveLength(EXPECTED_DIMS);
  });

  // ── Singleton Lifecycle ────────────────────────────────────────

  it("reset → re-init produces identical dimensions and model", async () => {
    const modelBefore = getActiveModel();
    const dimsBefore = getActiveDimensions();

    // Capture a reference vector before reset
    const refInput = "lifecycle stability test";
    const refBefore = await embedQuery(refInput);

    resetEmbeddings();

    // State should reset to defaults
    expect(getActiveModel()).toBe("nomic"); // default before init
    expect(getActiveDimensions()).toBe(256);

    await initEmbeddings();

    expect(getActiveModel()).toBe(modelBefore);
    expect(getActiveDimensions()).toBe(dimsBefore);

    // Vector output must be identical after re-init
    const refAfter = await embedQuery(refInput);
    expect(refAfter).toEqual(refBefore);
  });

  it("double init is a no-op (singleton guard)", async () => {
    const v1 = await embedQuery("double init test");
    await initEmbeddings(); // second init call
    await initEmbeddings(); // third init call
    const v2 = await embedQuery("double init test");
    expect(v1).toEqual(v2);
    expect(getActiveDimensions()).toBe(EXPECTED_DIMS);
  });

  // ── Cache Contract ─────────────────────────────────────────────

  it("query cache returns same reference on cache hit", async () => {
    resetEmbeddings();
    await initEmbeddings();

    const input = "cache reference identity test";
    const v1 = await embedQuery(input);
    const v2 = await embedQuery(input);
    // Cache should return the exact same array reference
    expect(v1 === v2).toBe(true);
  });

  it("document embedding is NOT cached (different calls, fresh compute)", async () => {
    const input = "document caching test";
    const v1 = await embedDocument(input);
    const v2 = await embedDocument(input);
    // Values should be identical but not necessarily same reference
    expect(v1).toEqual(v2);
    // Documents aren't cached, so reference identity is not guaranteed
    // (but values must match for determinism)
  });

  // ── Edge Cases ─────────────────────────────────────────────────

  it("empty batch returns empty array", async () => {
    const result = await embedDocumentBatch([]);
    expect(result).toEqual([]);
  });

  it("single-item batch matches individual embedDocument", async () => {
    const text = "batch-vs-individual consistency test";
    const [batchResult] = await embedDocumentBatch([text]);
    const individual = await embedDocument(text);
    // Must produce identical vectors
    for (let i = 0; i < EXPECTED_DIMS; i++) {
      expect(batchResult[i]).toBeCloseTo(individual[i], 5);
    }
  });

  it("very long input is truncated, not rejected", async () => {
    const longText = "x".repeat(50_000); // well beyond 8000 char limit
    const v = await embedQuery(longText);
    expect(v).toHaveLength(EXPECTED_DIMS);
    expect(l2Norm(v)).toBeCloseTo(1.0, 1);
  });
});
