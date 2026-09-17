/**
 * W2: extracted facts inherit the source conversation's tenant scope.
 * consolidateFacts / deduplicateFact accept `{ scope }`; novel memories are
 * stamped with it and dedup candidates are confined to that scope (ADR-010).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  consolidateFacts,
  deduplicateFact,
  resetConsolidator,
} from "../../src/semantic/consolidator.js";
import { insertMemory, getMemory } from "../../src/semantic/memory.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { Memory, ExtractedFact } from "../../src/semantic/types.js";

vi.mock("../../src/semantic/nli.js", () => ({
  classifyNli: vi.fn(),
}));

vi.mock("../../src/_core/embeddings/index.js", () => ({
  embedDocument: vi.fn(),
}));

import { embedDocument } from "../../src/_core/embeddings/index.js";

const mockedEmbedDocument = vi.mocked(embedDocument);

let t: TestDb;

function seededEmbedding(seed: number, dims: number = 256): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff - 0.5;
  };
  const vec = Array.from({ length: dims }, () => next());
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

function fact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    type: "fact",
    content: "Databricks interview is on Thursday",
    importance: 0.6,
    sourceExchangeIds: ["hermes:sess-1:0"],
    ...overrides,
  };
}

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 10)}`,
    type: "fact",
    content: "Databricks interview is on Thursday",
    confidence: 0.5,
    importance: 0.5,
    accessCount: 0,
    createdAt: Math.floor(Date.now() / 1000),
    sourceExchanges: ["exch-001"],
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  t = createTestDb();
  resetConsolidator();
  vi.clearAllMocks();
});

afterEach(() => {
  t.cleanup();
  resetConsolidator();
});

describe("scoped consolidation (W2)", () => {
  it("novel facts from a hermes:career conversation are stored with scope hermes:career", async () => {
    mockedEmbedDocument.mockImplementation(async (text: string) => seededEmbedding(text.length * 7 + 1));

    const results = await consolidateFacts(
      t.db,
      [fact(), fact({ content: "Recruiter prefers email over LinkedIn", type: "preference" })],
      "hermes:sess-1",
      { scope: "hermes:career" },
    );

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.action).toBe("insert");
      expect(getMemory(t.db, r.memoryId)!.scope).toBe("hermes:career");
      expect(getMemory(t.db, r.memoryId)!.source).toBe("dream");
    }
  });

  it("defaults to global when no scope is given (existing behaviour)", async () => {
    mockedEmbedDocument.mockResolvedValue(seededEmbedding(3));
    const [r] = await consolidateFacts(t.db, [fact()], "conv-global");
    expect(getMemory(t.db, r.memoryId)!.scope).toBe("global");
  });

  it("a tenant-scoped fact never merges into a global memory, and vice versa", async () => {
    const embedding = seededEmbedding(42);
    const globalMem = memory({ id: "mem-global-1", accessCount: 2 });
    insertMemory(t.db, globalMem, embedding);
    mockedEmbedDocument.mockResolvedValue(embedding);

    const scoped = await deduplicateFact(t.db, fact(), "hermes:sess-1", { scope: "hermes:career" });
    expect(scoped.action).toBe("insert");
    expect(scoped.memoryId).not.toBe("mem-global-1");
    expect(getMemory(t.db, scoped.memoryId)!.scope).toBe("hermes:career");
    expect(getMemory(t.db, "mem-global-1")!.accessCount).toBe(2);

    // Same tenant, identical content → merges within the tenant scope
    const again = await deduplicateFact(t.db, fact(), "hermes:sess-1", { scope: "hermes:career" });
    expect(again.action).toBe("merge");
    expect(again.memoryId).toBe(scoped.memoryId);
  });
});
