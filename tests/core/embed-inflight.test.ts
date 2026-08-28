/**
 * Concurrent embedQuery calls for the same text (recall fans one query out
 * to three searches) must share a single model invocation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ modelCalls: 0 }));

vi.mock("@xenova/transformers", () => ({
  layer_norm: vi.fn(),
  pipeline: vi.fn(async (_task: string, model: string) => {
    if (model.includes("nomic")) throw new Error("force MiniLM fallback (no post-processing)");
    return async () => {
      state.modelCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return { data: new Float32Array(384).fill(0.05) };
    };
  }),
}));

import { embedQuery, resetEmbeddings } from "../../src/_core/embeddings/index.js";

describe("embedQuery in-flight coalescing", () => {
  beforeEach(() => {
    resetEmbeddings();
    state.modelCalls = 0;
  });

  it("runs the model once for concurrent identical queries", async () => {
    const [a, b, c] = await Promise.all([
      embedQuery("same query"),
      embedQuery("same query"),
      embedQuery("same query"),
    ]);
    expect(state.modelCalls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    // and the cache serves the next call without touching the model
    await embedQuery("same query");
    expect(state.modelCalls).toBe(1);
  });

  it("still embeds distinct queries separately", async () => {
    await Promise.all([embedQuery("one"), embedQuery("two")]);
    expect(state.modelCalls).toBe(2);
  });
});
