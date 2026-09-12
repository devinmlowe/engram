/**
 * Regression: the reranker must feed (query, passage) pairs through the
 * tokenizer's `text_pair` option and read one logit per pair from a
 * sequence-classification model.
 *
 * Before the fix it called the `text-classification` pipeline with an array
 * of `{text, text_pair}` objects. In @xenova/transformers v2 that pipeline
 * only accepts strings, so every recall logged
 * "Reranking failed: text.split is not a function" and returned the
 * unranked RRF window — the reranker never ran in production.
 *
 * The fake tokenizer below enforces the real contract: any non-string
 * element throws exactly the error the library throws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SearchResult } from "../../src/_core/types/index.js";

type TokCall = { text: unknown; options: Record<string, unknown> };
const state = vi.hoisted(() => ({
  tokCalls: [] as TokCall[],
  logitsFor: (pairs: number) => ({ dims: [pairs, 1], data: new Float32Array(pairs) }),
}));

vi.mock("@xenova/transformers", () => {
  const tokenizer = (text: unknown, options: Record<string, unknown>) => {
    const assertStrings = (v: unknown, label: string) => {
      const arr = Array.isArray(v) ? v : [v];
      for (const el of arr) {
        if (typeof el !== "string") {
          // mirrors PreTrainedTokenizer: it calls `.split` on each input
          throw new TypeError("text.split is not a function");
        }
      }
      if (Array.isArray(v) && arr.length === 0) throw new Error(`${label}: empty`);
    };
    assertStrings(text, "text");
    if (options.text_pair !== undefined) assertStrings(options.text_pair, "text_pair");
    state.tokCalls.push({ text, options });
    const n = Array.isArray(text) ? text.length : 1;
    return { input_ids: { dims: [n, 4] }, attention_mask: { dims: [n, 4] } };
  };
  const model = async (inputs: { input_ids: { dims: number[] } }) => ({
    logits: state.logitsFor(inputs.input_ids.dims[0]),
  });
  return {
    AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizer) },
    AutoModelForSequenceClassification: { from_pretrained: vi.fn(async () => model) },
  };
});

import {
  rerankResults,
  resetReranker,
  isRerankerAvailable,
  logitsToScores,
  createCrossEncoder,
} from "../../src/_core/search/reranker.js";

function candidate(id: string, score: number, content: string): SearchResult {
  return { id, source: "semantic", score, content, metadata: {}, tokenEstimate: 10 };
}

/** The exact shape the orchestrator passes: top-20 RRF window, verbatim query. */
const window = Array.from({ length: 20 }, (_, i) =>
  candidate(`m-${i}`, 1 - i * 0.04, `memory ${i}: ${i === 17 ? "Paris is the capital of France" : "unrelated"}`),
);

describe("reranker pair contract", () => {
  beforeEach(() => {
    resetReranker();
    state.tokCalls = [];
    state.logitsFor = (n) => ({ dims: [n, 1], data: new Float32Array(n) });
  });
  afterEach(() => resetReranker());

  it("tokenizes query/passage pairs as parallel string arrays (never objects)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await rerankResults("capital of france?", window, { topK: 5, blendWeight: 1 });
    expect(isRerankerAvailable()).toBe(true);
    expect(warn).not.toHaveBeenCalled(); // no "Reranking failed" line
    expect(state.tokCalls).toHaveLength(1);
    const call = state.tokCalls[0];
    expect(call.text).toEqual(Array(20).fill("capital of france?"));
    expect(call.options.text_pair).toEqual(window.map((c) => c.content));
    expect(call.options).toMatchObject({ padding: true, truncation: true });
    warn.mockRestore();
  });

  it("orders results by the model's logits, not by input order", async () => {
    state.logitsFor = (n) => {
      const data = new Float32Array(n).fill(-8);
      data[17] = 9; // "Paris" memory is the relevant one
      data[3] = 2;
      return { dims: [n, 1], data };
    };
    const out = await rerankResults("capital of france?", window, { topK: 3, blendWeight: 1 });
    expect(out.map((r) => r.id)).toEqual(["m-17", "m-3", "m-0"]);
    expect(out[0].score).toBeCloseTo(1); // normalized max
  });

  it("passes a long multi-line query verbatim (plugin prefetch sends the whole message)", async () => {
    const query = "line one\n[System note: gateway restarted]\n\nwhat did we decide about the FTS join?";
    await rerankResults(query, window.slice(0, 2), { topK: 2 });
    expect(state.tokCalls[0].text).toEqual([query, query]);
  });

  it("degrades to the original window when the model throws", async () => {
    state.logitsFor = () => {
      throw new Error("ONNX session failed");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await rerankResults("q", window, { topK: 4 });
    expect(out.map((r) => r.id)).toEqual(["m-0", "m-1", "m-2", "m-3"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Reranking failed"));
    warn.mockRestore();
  });
});

describe("logitsToScores / createCrossEncoder", () => {
  it("reads one score per row for a [n,1] tensor", () => {
    expect(logitsToScores({ dims: [3, 1], data: [0.5, -1, 2] })).toEqual([0.5, -1, 2]);
  });

  it("takes the last column for a multi-label head", () => {
    expect(logitsToScores({ dims: [2, 2], data: [1, 9, 3, 4] })).toEqual([9, 4]);
  });

  it("rejects mismatched query/passage lengths and short outputs", async () => {
    const enc = createCrossEncoder(
      () => ({}),
      async () => ({ logits: { dims: [1, 1], data: [0] } }),
    );
    await expect(enc.score(["a", "b"], ["x"])).rejects.toThrow(/queries vs/);
    await expect(enc.score(["a", "b"], ["x", "y"])).rejects.toThrow(/expected 2 scores/);
    await expect(enc.score([], [])).resolves.toEqual([]);
  });
});
