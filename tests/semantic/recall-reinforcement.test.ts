/**
 * W8 — retrieval strengthens memories.
 *
 * Every recall path (unifiedSearch / recall_session / recall_drill) must
 * call recordAccess for the semantic memories it actually RETURNS, so FSRS
 * stability grows on retrieval (decay.ts: S' = S * (1 + rate * (1 - R))).
 * Candidates that were searched but not returned are untouched, the
 * `reinforce: false` opt-out leaves the store read-only, and a failure
 * inside reinforcement never fails the recall.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { insertMemory } from "../../src/semantic/memory.js";
import {
  unifiedSearch,
  createOrRefineRecallSession,
  drillRecallResult,
  reinforceRecalledMemories,
} from "../../src/interfaces/shared/search.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { Memory } from "../../src/semantic/types.js";
import { INITIAL_STABILITY, STABILITY_GROWTH_RATE } from "../../src/semantic/types.js";
import type { SearchResult } from "../../src/_core/types/index.js";

vi.mock("../../src/_core/embeddings/index.js", () => ({
  embedQuery: vi.fn(),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

// recordAccess is wrapped so a single test can make it throw without
// disturbing insertMemory or the other real exports.
const failure = vi.hoisted(() => ({ throwOnAccess: false, calls: 0 }));
vi.mock("../../src/semantic/memory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/semantic/memory.js")>();
  return {
    ...actual,
    recordAccess: (db: Parameters<typeof actual.recordAccess>[0], id: string) => {
      failure.calls += 1;
      if (failure.throwOnAccess) throw new Error("simulated recordAccess failure");
      return actual.recordAccess(db, id);
    },
  };
});

import { embedQuery } from "../../src/_core/embeddings/index.js";
const mockedEmbedQuery = vi.mocked(embedQuery);

// ─── Helpers ────────────────────────────────────────────────────

let t: TestDb;

function seededEmbedding(seed: number, dims = 256): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff - 0.5;
  };
  const vec = Array.from({ length: dims }, () => next());
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

const SIXTY_DAYS_AGO = Math.floor(Date.now() / 1000) - 60 * 86400;

function mem(id: string, content: string): Memory {
  return {
    id,
    type: "fact",
    content,
    confidence: 0.9,
    importance: 0.5,
    accessCount: 0,
    createdAt: SIXTY_DAYS_AGO - 30 * 86400,
    lastAccessed: SIXTY_DAYS_AGO, // R = 0.9^(60/30) = 0.81 -> growth on access
    sourceExchanges: [],
    isActive: true,
  };
}

interface Stats {
  access_count: number;
  last_accessed: number | null;
  stability: number | null;
  importance: number;
}

function stats(id: string): Stats {
  return t.db
    .prepare("SELECT access_count, last_accessed, stability, importance FROM memories WHERE id = ?")
    .get(id) as Stats;
}

/** Expected FSRS growth from a memory last accessed 60 days ago (fact, S=30). */
const EXPECTED_FIRST_STABILITY =
  INITIAL_STABILITY.fact * (1 + STABILITY_GROWTH_RATE * (1 - Math.pow(0.9, 60 / 30)));

function seedThree() {
  insertMemory(t.db, mem("m-1", "launchd plist daemon notes"), seededEmbedding(1));
  insertMemory(t.db, mem("m-2", "launchd plist daemon notes two"), seededEmbedding(2));
  insertMemory(t.db, mem("m-3", "launchd plist daemon notes three"), seededEmbedding(3));
  // Query embedding == m-1's embedding, so m-1 is the top hit.
  mockedEmbedQuery.mockResolvedValue(seededEmbedding(1));
}

beforeEach(() => {
  t = createTestDb();
  vi.clearAllMocks();
  failure.throwOnAccess = false;
  failure.calls = 0;
});

afterEach(() => {
  t.cleanup();
});

// ─── unifiedSearch (recall) ─────────────────────────────────────

describe("recall reinforces returned memories (W8)", () => {
  it("recall returns M -> access_count +1, last_accessed updated, stability grown per formula", async () => {
    seedThree();
    const before = stats("m-1");
    expect(before.access_count).toBe(0);
    expect(before.stability).toBeNull();

    const response = await unifiedSearch(t.db, {
      query: "launchd plist",
      sources: ["semantic"],
      limit: 10,
    });
    const returned = response.results.map((r) => r.id);
    expect(returned).toContain("m-1");

    const after = stats("m-1");
    expect(after.access_count).toBe(1);
    expect(after.last_accessed).toBeGreaterThan(SIXTY_DAYS_AGO);
    expect(after.stability).toBeCloseTo(EXPECTED_FIRST_STABILITY, 3);
    expect(after.stability!).toBeGreaterThan(INITIAL_STABILITY.fact);
    expect(after.importance).toBeCloseTo(0.52, 5);
  });

  it("recall twice -> access_count 2, stability monotonic; second increment <= first (R ~ 1 right after access)", async () => {
    seedThree();
    const params = { query: "launchd plist", sources: ["semantic"] as const, limit: 10 };

    await unifiedSearch(t.db, { ...params, sources: ["semantic"] });
    const first = stats("m-1");
    await unifiedSearch(t.db, { ...params, sources: ["semantic"] });
    const second = stats("m-1");

    expect(first.access_count).toBe(1);
    expect(second.access_count).toBe(2);
    const firstIncrement = first.stability! - INITIAL_STABILITY.fact;
    const secondIncrement = second.stability! - first.stability!;
    expect(firstIncrement).toBeGreaterThan(0);
    expect(second.stability!).toBeGreaterThanOrEqual(first.stability!);
    // Immediately after an access R -> 1, so (1 - R) -> 0 and growth is ~0.
    expect(secondIncrement).toBeLessThanOrEqual(firstIncrement);
    expect(secondIncrement).toBeLessThan(0.01);
  });

  it("reinforce: false -> no change to any returned memory", async () => {
    seedThree();
    const response = await unifiedSearch(t.db, {
      query: "launchd plist",
      sources: ["semantic"],
      limit: 10,
      reinforce: false,
    });
    expect(response.results.length).toBeGreaterThan(0);

    for (const id of ["m-1", "m-2", "m-3"]) {
      const s = stats(id);
      expect(s.access_count).toBe(0);
      expect(s.last_accessed).toBe(SIXTY_DAYS_AGO);
      expect(s.stability).toBeNull();
    }
    expect(failure.calls).toBe(0);
  });

  it("candidates that were NOT returned are untouched", async () => {
    seedThree();
    const response = await unifiedSearch(t.db, {
      query: "launchd plist",
      sources: ["semantic"],
      limit: 1,
    });
    expect(response.results.map((r) => r.id)).toEqual(["m-1"]);

    expect(stats("m-1").access_count).toBe(1);
    for (const id of ["m-2", "m-3"]) {
      const s = stats(id);
      expect(s.access_count).toBe(0);
      expect(s.last_accessed).toBe(SIXTY_DAYS_AGO);
      expect(s.stability).toBeNull();
    }
  });

  it("a thrown error inside reinforcement does not fail the recall", async () => {
    seedThree();
    failure.throwOnAccess = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await unifiedSearch(t.db, {
      query: "launchd plist",
      sources: ["semantic"],
      limit: 10,
    });

    expect(response.results.map((r) => r.id)).toContain("m-1");
    expect(failure.calls).toBeGreaterThan(0);
    expect(stats("m-1").access_count).toBe(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("reinforceRecalledMemories dedupes ids and ignores non-semantic results", () => {
    seedThree();
    const hit = (id: string, source: SearchResult["source"]): SearchResult => ({
      id,
      source,
      score: 1,
      content: "",
      metadata: {},
      tokenEstimate: 1,
    });
    reinforceRecalledMemories(t.db, [
      hit("m-1", "semantic"),
      hit("m-1", "semantic"),
      hit("m-2", "episodic"),
      hit("m-3", "graph"),
    ]);
    expect(stats("m-1").access_count).toBe(1);
    expect(stats("m-2").access_count).toBe(0);
    expect(stats("m-3").access_count).toBe(0);
    expect(failure.calls).toBe(1);
  });
});

// ─── recall_session / recall_drill ──────────────────────────────

describe("recall_session and recall_drill reinforce (W8)", () => {
  it("recall_session reinforces returned memories; reinforce:false does not", async () => {
    seedThree();
    const result = await createOrRefineRecallSession(t.db, {
      query: "launchd plist",
      sources: ["semantic"],
    });
    expect(result.results.map((r) => r.id)).toContain("m-1");
    expect(stats("m-1").access_count).toBe(1);
    expect(stats("m-1").stability).toBeCloseTo(EXPECTED_FIRST_STABILITY, 3);

    // Refinement with reinforce:false leaves counts alone
    const refined = await createOrRefineRecallSession(t.db, {
      query: "launchd daemon",
      sessionId: result.sessionId,
      sources: ["semantic"],
      reinforce: false,
    });
    expect(refined.sessionId).toBe(result.sessionId);
    expect(stats("m-1").access_count).toBe(1);
  });

  it("recall_drill reinforces the drilled semantic memory", async () => {
    seedThree();
    const session = await createOrRefineRecallSession(t.db, {
      query: "launchd plist",
      sources: ["semantic"],
      reinforce: false,
    });
    const idx = session.results.findIndex((r) => r.id === "m-1");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(stats("m-1").access_count).toBe(0);

    const drill = await drillRecallResult(t.db, session.sessionId, idx);
    expect(drill.resultId).toBe("m-1");
    expect(stats("m-1").access_count).toBe(1);
    expect(stats("m-1").stability).toBeCloseTo(EXPECTED_FIRST_STABILITY, 3);

    await drillRecallResult(t.db, session.sessionId, idx, { reinforce: false });
    expect(stats("m-1").access_count).toBe(1);
  });
});
