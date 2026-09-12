/**
 * When the cross-encoder can't load, rerankResults degrades to
 * candidates.slice(0, topK). The orchestrator must NOT treat that as a
 * successful rerank — otherwise every recall on a machine without the
 * model silently loses results 6..20.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { SearchResult } from "../../src/_core/types/index.js";
import type { EngramConfig } from "../../src/_core/types/index.js";

const semanticResults: SearchResult[] = Array.from({ length: 12 }, (_, i) => ({
  id: `sem-${i}`,
  source: "semantic" as const,
  score: 1 - i * 0.05,
  content: `semantic result ${i}`,
  metadata: {},
  tokenEstimate: 10,
}));

vi.mock("../../src/semantic/search.js", () => ({
  searchSemantic: vi.fn(async () => semanticResults),
}));
// Two sources are needed: single-source recalls short-circuit before reranking
vi.mock("../../src/episodic/search.js", () => ({
  searchEpisodic: vi.fn(async () => ({
    results: Array.from({ length: 4 }, (_, i) => ({
      id: `epi-${i}`,
      source: "episodic" as const,
      score: 0.9 - i * 0.1,
      content: `episodic result ${i}`,
      metadata: {},
      tokenEstimate: 10,
    })),
    tokensUsed: 40,
    totalResults: 4,
    query: "anything",
  })),
}));
vi.mock("../../src/graph/search.js", () => ({
  searchGraph: vi.fn(async () => []),
}));

// vi.mock factories are hoisted; shared state must be hoisted with them
const state = vi.hoisted(() => ({ available: false }));
vi.mock("../../src/_core/search/reranker.js", () => ({
  rerankResults: vi.fn(async (_q: string, candidates: SearchResult[], cfg?: { topK?: number }) =>
    candidates.slice(0, cfg?.topK ?? 5),
  ),
  isRerankerAvailable: () => state.available,
}));

import { searchMultiSource } from "../../src/_core/search/orchestrator.js";

const config = {
  search: { reranker: { enabled: true, topK: 5, blendWeight: 0.7, model: "x" } },
} as unknown as EngramConfig;

afterEach(() => {
  state.available = false;
});

describe("orchestrator reranker degradation", () => {
  it("keeps the full result set when the reranker is unavailable", async () => {
    state.available = false;
    const res = await searchMultiSource({} as Database.Database, {
      query: "anything",
      sources: ["episodic", "semantic"],
      limit: 10,
      budget: 100_000,
    }, config);
    expect(res.results.length).toBe(16);
  });

  it("uses the reranked window (top K + remainder beyond 20) when the model ran", async () => {
    state.available = true;
    const res = await searchMultiSource({} as Database.Database, {
      query: "anything",
      sources: ["episodic", "semantic"],
      limit: 10,
      budget: 100_000,
    }, config);
    // all 16 candidates sit inside the 20-wide rerank window → top 5 only
    expect(res.results.length).toBe(5);
  });
});
