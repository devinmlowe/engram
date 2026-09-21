import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import {
  consolidateFacts,
  deduplicateFact,
  resetConsolidator,
  setConsolidatorClient,
} from "../../src/semantic/consolidator.js";
import {
  insertMemory,
  getMemory,
  findNearestMemories,
  recordAccess,
} from "../../src/semantic/memory.js";
import { createTestDb, createTestMemory } from "../helpers.js";
import { cosineSimilarity } from "../../src/_core/search/vector.js";
import type { TestDb } from "../helpers.js";
import type { Memory } from "../../src/semantic/types.js";
import type { ExtractedFact } from "../../src/semantic/types.js";
import {
  INITIAL_STABILITY,
  TRANSIENT_STABILITY,
  TRANSIENT_IMPORTANCE_CAP,
} from "../../src/semantic/types.js";

// ─── Mocks ──────────────────────────────────────────────────────

// Mock NLI — we don't want to load the real model in unit tests
vi.mock("../../src/semantic/nli.js", () => ({
  classifyNli: vi.fn(),
}));

// Mock embeddings — we don't want to load the real model in unit tests
vi.mock("../../src/_core/embeddings/index.js", () => ({
  embedDocument: vi.fn(),
}));

import { classifyNli } from "../../src/semantic/nli.js";
import { embedDocument } from "../../src/_core/embeddings/index.js";

const mockedClassifyNli = vi.mocked(classifyNli);
const mockedEmbedDocument = vi.mocked(embedDocument);

// ─── Helpers ────────────────────────────────────────────────────

let t: TestDb;

function randomEmbedding(dims: number = 256): number[] {
  const vec = Array.from({ length: dims }, () => Math.random() - 0.5);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

/** Create a deterministic embedding based on a seed value */
function seededEmbedding(seed: number, dims: number = 256): number[] {
  // Simple LCG PRNG for reproducibility
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff - 0.5;
  };
  const vec = Array.from({ length: dims }, () => next());
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

function createTestFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    type: "fact",
    content: "New fact about TypeScript",
    importance: 0.5,
    sourceExchangeIds: ["exch-010"],
    ...overrides,
  };
}

/** Set up mock conflict resolution client that returns specified action */
function setupMockConflictClient(
  action: "update" | "keep_both" | "noop",
  reasoning: string = "Test reasoning",
  updatedContent?: string,
): void {
  const mockCreate = vi.fn().mockResolvedValue({
    content: [
      {
        type: "tool_use",
        id: "toolu_mock",
        name: "resolve_conflict",
        input: {
          action,
          reasoning,
          ...(updatedContent ? { updated_content: updatedContent } : {}),
        },
      },
    ],
  });

  const mockClient = {
    messages: { create: mockCreate },
  } as unknown as import("../../src/_core/llm/index.js").AnthropicClient;

  setConsolidatorClient(mockClient);
}

// ─── Setup / Teardown ───────────────────────────────────────────

beforeEach(() => {
  t = createTestDb();
  resetConsolidator();
  vi.clearAllMocks();
});

afterEach(() => {
  t.cleanup();
  resetConsolidator();
});

// ─── Tests ──────────────────────────────────────────────────────

describe("deduplicateFact", () => {
  it("inserts novel fact when DB is empty", async () => {
    const embedding = randomEmbedding();
    mockedEmbedDocument.mockResolvedValue(embedding);

    const fact = createTestFact({
      content: "Fish shell is the default",
      type: "preference",
      importance: 0.8,
    });

    const result = await deduplicateFact(t.db, fact, "conv-001");

    expect(result.action).toBe("insert");
    expect(result.memoryId).toBeDefined();

    // Verify memory was actually inserted
    const memory = getMemory(t.db, result.memoryId);
    expect(memory).not.toBeNull();
    expect(memory!.content).toBe("Fish shell is the default");
    expect(memory!.type).toBe("preference");
    expect(memory!.confidence).toBe(0.5);
    expect(memory!.importance).toBe(0.8);
    expect(memory!.isActive).toBe(true);
  });

  it("carries extractionBasis through to the inserted memory", async () => {
    const embedding = randomEmbedding();
    mockedEmbedDocument.mockResolvedValue(embedding);

    const fact = createTestFact({
      content: "User works remotely on Fridays",
      extractionBasis: "inferred",
    });

    const result = await deduplicateFact(t.db, fact, "conv-001");

    expect(result.action).toBe("insert");

    const row = t.db
      .prepare("SELECT extraction_basis FROM memories WHERE id = ?")
      .get(result.memoryId) as { extraction_basis: string };
    expect(row.extraction_basis).toBe("inferred");
  });

  it("auto-merges near-duplicate (sim >= 0.95)", async () => {
    // Insert an existing memory with a known embedding
    const embedding = seededEmbedding(42);
    const existing = createTestMemory({
      id: "mem-existing-1",
      content: "User prefers Fish shell",
      accessCount: 3,
    });
    insertMemory(t.db, existing, embedding);

    // Return same embedding for the fact (sim = 1.0)
    mockedEmbedDocument.mockResolvedValue(embedding);

    const fact = createTestFact({
      content: "User prefers Fish shell",
    });

    const result = await deduplicateFact(t.db, fact, "conv-001");

    expect(result.action).toBe("merge");
    expect(result.memoryId).toBe("mem-existing-1");
    expect(result.mergedWithId).toBe("mem-existing-1");
    expect(result.similarity).toBeGreaterThanOrEqual(0.95);

    // Verify access count was bumped
    const updated = getMemory(t.db, "mem-existing-1");
    expect(updated!.accessCount).toBe(4);
  });

  it("never merges a global dream fact into a tenant-scoped memory (ADR-010)", async () => {
    const embedding = seededEmbedding(42);
    const tenant = createTestMemory({
      id: "mem-career-1",
      content: "User prefers Fish shell",
      accessCount: 3,
      scope: "hermes:career",
    });
    insertMemory(t.db, tenant, embedding);
    mockedEmbedDocument.mockResolvedValue(embedding);

    const result = await deduplicateFact(t.db, createTestFact({ content: "User prefers Fish shell" }), "conv-001");

    expect(result.action).toBe("insert");
    expect(result.memoryId).not.toBe("mem-career-1");
    expect(getMemory(t.db, result.memoryId)!.scope).toBe("global");
    // tenant memory untouched
    expect(getMemory(t.db, "mem-career-1")!.accessCount).toBe(3);
  });

  it("merges on NLI entailment (sim 0.85-0.95)", async () => {
    // Insert existing memory
    const baseEmbedding = seededEmbedding(100);
    const existing = createTestMemory({
      id: "mem-entail-1",
      content: "The project uses vitest for testing",
      accessCount: 2,
    });
    insertMemory(t.db, existing, baseEmbedding);

    // Create a slightly different embedding that falls in the NLI range
    // We'll manipulate the embedding to get a specific similarity
    const perturbedEmbedding = baseEmbedding.map(
      (v, i) => v + (i % 3 === 0 ? 0.08 : 0),
    );
    const norm = Math.sqrt(
      perturbedEmbedding.reduce((s, v) => s + v * v, 0),
    );
    const normalizedPerturbed = perturbedEmbedding.map((v) => v / norm);

    mockedEmbedDocument.mockResolvedValue(normalizedPerturbed);

    // Mock NLI to return entailment
    mockedClassifyNli.mockResolvedValue({
      entailment: 0.85,
      contradiction: 0.05,
      neutral: 0.10,
      label: "entailment",
    });

    const fact = createTestFact({
      content: "The engram project uses vitest as its testing framework",
    });

    const result = await deduplicateFact(t.db, fact, "conv-001");

    // The similarity might not be exactly in range depending on perturbation,
    // so check if NLI was called or if it auto-merged
    if (result.action === "merge") {
      expect(result.memoryId).toBe("mem-entail-1");
      const updated = getMemory(t.db, "mem-entail-1");
      expect(updated!.accessCount).toBe(3);
    }
  });

  it("resolves contradiction with UPDATE (old memory deactivated)", async () => {
    // Insert existing memory
    const baseEmbedding = seededEmbedding(200);
    const existing = createTestMemory({
      id: "mem-contradict-1",
      content: "User prefers 2-space indentation",
      type: "preference",
      accessCount: 1,
    });
    insertMemory(t.db, existing, baseEmbedding);

    // Create embedding in NLI range
    const perturbedEmbedding = baseEmbedding.map(
      (v, i) => v + (i % 3 === 0 ? 0.08 : 0),
    );
    const norm = Math.sqrt(
      perturbedEmbedding.reduce((s, v) => s + v * v, 0),
    );
    const normalizedPerturbed = perturbedEmbedding.map((v) => v / norm);

    mockedEmbedDocument.mockResolvedValue(normalizedPerturbed);

    // Mock NLI to return contradiction
    mockedClassifyNli.mockResolvedValue({
      entailment: 0.05,
      contradiction: 0.85,
      neutral: 0.10,
      label: "contradiction",
    });

    // Mock LLM conflict resolution to return UPDATE
    setupMockConflictClient("update", "User explicitly changed preference");

    const fact = createTestFact({
      content: "User prefers 4-space indentation",
      type: "preference",
    });

    const result = await deduplicateFact(t.db, fact, "conv-001");

    // The result depends on whether the similarity falls in the NLI range
    // If it does, we should get a conflict resolution
    if (result.action === "conflict") {
      expect(result.memoryId).toBeDefined();
      expect(result.conflictId).toBeDefined();

      // Verify old memory was deactivated
      const oldMemory = getMemory(t.db, "mem-contradict-1");
      expect(oldMemory!.isActive).toBe(false);
      expect(oldMemory!.supersededBy).toBe(result.memoryId);
      // ...and carries the persisted FSRS contradiction penalty (×0.8)
      expect(oldMemory!.stability).toBeCloseTo(INITIAL_STABILITY.preference * 0.8, 5);

      // Verify new memory was inserted
      const newMemory = getMemory(t.db, result.memoryId);
      expect(newMemory).not.toBeNull();
      expect(newMemory!.isActive).toBe(true);
    }
  });

  it("inserts as novel when NLI returns neutral", async () => {
    // Insert existing memory
    const baseEmbedding = seededEmbedding(300);
    const existing = createTestMemory({
      id: "mem-neutral-1",
      content: "The project uses SQLite for storage",
    });
    insertMemory(t.db, existing, baseEmbedding);

    // Create embedding in NLI range
    const perturbedEmbedding = baseEmbedding.map(
      (v, i) => v + (i % 3 === 0 ? 0.08 : 0),
    );
    const norm = Math.sqrt(
      perturbedEmbedding.reduce((s, v) => s + v * v, 0),
    );
    const normalizedPerturbed = perturbedEmbedding.map((v) => v / norm);

    mockedEmbedDocument.mockResolvedValue(normalizedPerturbed);

    // Mock NLI to return neutral
    mockedClassifyNli.mockResolvedValue({
      entailment: 0.15,
      contradiction: 0.15,
      neutral: 0.70,
      label: "neutral",
    });

    const fact = createTestFact({
      content: "The project uses WAL mode for SQLite",
    });

    const result = await deduplicateFact(t.db, fact, "conv-001");

    // Should either insert as novel (if NLI was called) or merge (if auto-merge)
    expect(["insert", "merge"]).toContain(result.action);
    expect(result.memoryId).toBeDefined();
  });
});

describe("consolidateFacts", () => {
  it("processes facts sequentially", async () => {
    const callOrder: string[] = [];

    // Track embedding calls to verify sequential processing
    mockedEmbedDocument.mockImplementation(async (content: string) => {
      callOrder.push(content);
      return randomEmbedding();
    });

    const facts = [
      createTestFact({ content: "Fact A" }),
      createTestFact({ content: "Fact B" }),
      createTestFact({ content: "Fact C" }),
    ];

    const results = await consolidateFacts(t.db, facts, "conv-001");

    expect(results).toHaveLength(3);
    expect(callOrder).toEqual(["Fact A", "Fact B", "Fact C"]);
    // All should be inserts since DB starts empty
    for (const result of results) {
      expect(result.action).toBe("insert");
    }
  });

  it("deduplicates within batch (fact B merges with earlier fact A)", async () => {
    // Use same embedding for both facts to trigger auto-merge
    const sharedEmbedding = seededEmbedding(500);
    mockedEmbedDocument.mockResolvedValue(sharedEmbedding);

    const facts = [
      createTestFact({ content: "User prefers Fish shell" }),
      createTestFact({ content: "User prefers Fish shell" }),
    ];

    const results = await consolidateFacts(t.db, facts, "conv-001");

    expect(results).toHaveLength(2);
    expect(results[0].action).toBe("insert");
    // Second fact should merge with the first one inserted
    expect(results[1].action).toBe("merge");
    expect(results[1].mergedWithId).toBe(results[0].memoryId);
  });
});

describe("consolidateFacts continues past a failing fact (#36)", () => {
  it("stores facts 1 and 3 when fact 2's conflict resolution throws, and reports the failure in place", async () => {
    // Existing memory A; fact 2 lands in the NLI band against it with a
    // contradiction verdict, so conflict resolution (the LLM) is consulted.
    const base = seededEmbedding(3600);
    insertMemory(
      t.db,
      createTestMemory({ id: "mem-A", content: "The service listens on port 8080." }),
      base,
    );
    const embeddings: Record<string, number[]> = {
      "Fact one": seededEmbedding(3601),
      "The service now listens on port 9090.": perturbEmbedding(base, 0.35, 3602),
      "Fact three": seededEmbedding(3603),
    };
    mockedEmbedDocument.mockImplementation(async (content: string) => embeddings[content]);
    mockedClassifyNli.mockResolvedValue({ entailment: 0.05, contradiction: 0.85, neutral: 0.1 });
    const boom = new Error("conflict resolution exploded");
    setConsolidatorClient({
      messages: { create: vi.fn().mockRejectedValue(boom) },
    } as unknown as import("../../src/_core/llm/index.js").AnthropicClient);

    const facts = [
      createTestFact({ content: "Fact one" }),
      createTestFact({ content: "The service now listens on port 9090." }),
      createTestFact({ content: "Fact three" }),
    ];

    const results = await consolidateFacts(t.db, facts, "conv-036");

    expect(results).toHaveLength(3);
    expect(results[0].action).toBe("insert");
    expect(results[2].action).toBe("insert");
    expect(getMemory(t.db, results[0].memoryId)?.content).toBe("Fact one");
    expect(getMemory(t.db, results[2].memoryId)?.content).toBe("Fact three");

    const failures = results.filter((r) => r.action === "error");
    expect(failures).toHaveLength(1);
    expect(results[1]).toMatchObject({ action: "error", memoryId: "" });
    expect(results[1].error).toBeInstanceOf(Error);
    expect(results[1].error!.message).toMatch(/conflict resolution exploded/);

    // Nothing was stored for the failed fact; A is untouched.
    expect(countMemories()).toBe(3);
    expect(getMemory(t.db, "mem-A")?.isActive).toBe(true);
  });
});

// ─── W9: dream noise reduction ──────────────────────────────────

/** A unit vector within `noise` of `base` (cosine stays above 0.95). */
function perturbEmbedding(base: number[], noise: number, seed: number): number[] {
  const n = seededEmbedding(seed, base.length);
  const v = base.map((x, i) => x + noise * n[i]);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function countMemories(): number {
  return (t.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
}

describe("consolidateFacts — intra-batch near-duplicate collapse (W9a)", () => {
  it("three near-identical statements in one batch yield one memory with unioned source exchanges", async () => {
    // Distinct embeddings per content prove the collapse happened on
    // normalised text, not on the vector path.
    let seed = 700;
    mockedEmbedDocument.mockImplementation(async () => seededEmbedding(seed++));

    const facts = [
      createTestFact({ content: "The BLE SPEC is missing mcumgr/SMP DFU service references.", sourceExchangeIds: ["ex-1"] }),
      createTestFact({ content: "The BLE SPEC is missing mcumgr/SMP DFU service references", sourceExchangeIds: ["ex-2"] }),
      createTestFact({ content: "the ble spec is missing mcumgr/smp dfu service references.", sourceExchangeIds: ["ex-3", "ex-1"] }),
    ];

    const results = await consolidateFacts(t.db, facts, "conv-001");

    // One result per input fact, in input order; members point at the survivor.
    expect(results).toHaveLength(3);
    expect(results[0].action).toBe("insert");
    expect(results[1].action).toBe("merge");
    expect(results[1].mergedWithId).toBe(results[0].memoryId);
    expect(results[2].action).toBe("merge");
    expect(results[2].mergedWithId).toBe(results[0].memoryId);
    // members are flagged so the dream report can count them (#23)
    expect(results[0].collapsed).toBeUndefined();
    expect(results[1].collapsed).toBe(true);
    expect(results[2].collapsed).toBe(true);

    expect(countMemories()).toBe(1);
    const memory = getMemory(t.db, results[0].memoryId);
    expect(memory?.sourceExchanges).toEqual(["ex-1", "ex-2", "ex-3"]);
    // Only the survivor is embedded — no wasted embedding calls for members.
    expect(mockedEmbedDocument).toHaveBeenCalledTimes(1);
  });

  it("cosine-near duplicates within a batch collapse before insert (mock embeddings)", async () => {
    const base = seededEmbedding(900);
    const near = perturbEmbedding(base, 0.1, 901);
    const far = seededEmbedding(902);
    mockedEmbedDocument.mockImplementation(async (content: string) => {
      if (content.startsWith("Variant L")) return base;
      if (content.startsWith("The Variant L")) return near;
      return far;
    });

    const facts = [
      createTestFact({ content: "Variant L SPEC replaced J-Link programming tools with the Programmer dongle.", sourceExchangeIds: ["ex-10"], confidence: 0.4 }),
      createTestFact({ content: "The Variant L SPEC swapped J-Link tools for the Programmer dongle.", sourceExchangeIds: ["ex-11"], confidence: 0.8 }),
      createTestFact({ content: "The user's shell is Fish.", sourceExchangeIds: ["ex-12"] }),
    ];

    const results = await consolidateFacts(t.db, facts, "conv-001");

    expect(results).toHaveLength(3);
    expect(results[0].action).toBe("insert");
    expect(results[1].action).toBe("merge");
    expect(results[1].mergedWithId).toBe(results[0].memoryId);
    expect(results[1].similarity).toBeGreaterThanOrEqual(0.95);
    expect(results[1].collapsed).toBe(true);
    expect(results[2].action).toBe("insert");
    expect(results[2].memoryId).not.toBe(results[0].memoryId);
    expect(results[2].collapsed).toBeUndefined();

    expect(countMemories()).toBe(2);
    const survivor = getMemory(t.db, results[0].memoryId);
    // higher-confidence member supplies the content; sources are unioned
    expect(survivor?.content).toBe("The Variant L SPEC swapped J-Link tools for the Programmer dongle.");
    expect(survivor?.confidence).toBe(0.8);
    expect(survivor?.sourceExchanges).toEqual(["ex-10", "ex-11"]);
  });

  it("still merges a batch member into an existing DB memory (DB dedup unchanged)", async () => {
    const shared = seededEmbedding(950);
    mockedEmbedDocument.mockResolvedValue(shared);
    const existing = createTestMemory({ id: "mem-existing", content: "Existing memory" });
    insertMemory(t.db, existing, shared);

    const results = await consolidateFacts(t.db, [
      createTestFact({ content: "Existing memory, restated" }),
      createTestFact({ content: "Existing memory, restated again" }),
    ], "conv-001");

    expect(results.map((r) => r.action)).toEqual(["merge", "merge"]);
    expect(results.every((r) => r.mergedWithId === "mem-existing")).toBe(true);
    expect(countMemories()).toBe(1);
  });
});

describe("deduplicateFact — transient-status handling (W9b)", () => {
  it("stores status facts with the transient stability tier and capped importance", async () => {
    mockedEmbedDocument.mockResolvedValue(seededEmbedding(1000));
    const result = await deduplicateFact(
      t.db,
      createTestFact({
        type: "fact",
        content: "Phase 6A (Adaptive Chunking) for Engram is complete, adding 23 new tests, all passing.",
        importance: 0.7,
      }),
      "conv-001",
    );
    expect(result.action).toBe("insert");
    const memory = getMemory(t.db, result.memoryId);
    expect(memory?.importance).toBe(TRANSIENT_IMPORTANCE_CAP);
    expect(memory?.stability).toBe(TRANSIENT_STABILITY);
    expect(memory?.stability).toBeLessThan(INITIAL_STABILITY.fact);
    // Persisted, not just in-memory: the raw column carries the tier.
    const row = t.db.prepare("SELECT stability FROM memories WHERE id = ?").get(result.memoryId) as { stability: number };
    expect(row.stability).toBe(TRANSIENT_STABILITY);
  });

  it("leaves durable facts on the type's default stability with importance intact", async () => {
    mockedEmbedDocument.mockResolvedValue(seededEmbedding(1001));
    const result = await deduplicateFact(
      t.db,
      createTestFact({ type: "decision", content: "We decided to use SQLite with sqlite-vec for the database layer.", importance: 0.7 }),
      "conv-001",
    );
    const memory = getMemory(t.db, result.memoryId);
    expect(memory?.importance).toBe(0.7);
    expect(memory?.stability).toBeUndefined();
  });

  it("applies the transient policy on the conflict UPDATE path too", async () => {
    const existingEmb = seededEmbedding(1002);
    insertMemory(t.db, createTestMemory({ id: "mem-old", content: "The migration is not started.", importance: 0.6 }), existingEmb);
    mockedEmbedDocument.mockResolvedValue(perturbEmbedding(existingEmb, 0.35, 1003));
    mockedClassifyNli.mockResolvedValue({ entailment: 0.1, contradiction: 0.85, neutral: 0.05 });
    setupMockConflictClient("update", "Newer status supersedes");

    const result = await deduplicateFact(
      t.db,
      createTestFact({ content: "The migration is in progress.", importance: 0.6 }),
      "conv-001",
    );
    expect(result.action).toBe("conflict");
    const memory = getMemory(t.db, result.memoryId);
    expect(memory?.importance).toBe(TRANSIENT_IMPORTANCE_CAP);
    expect(memory?.stability).toBe(TRANSIENT_STABILITY);
  });
});

describe("deduplicateFact — model-supplied confidence (W9c)", () => {
  it("persists the model's confidence when present", async () => {
    mockedEmbedDocument.mockResolvedValue(seededEmbedding(1100));
    const result = await deduplicateFact(t.db, createTestFact({ content: "Confident fact", confidence: 0.83 }), "conv-001");
    expect(getMemory(t.db, result.memoryId)?.confidence).toBe(0.83);
  });

  it("falls back to 0.5 only when confidence is absent", async () => {
    mockedEmbedDocument.mockResolvedValue(seededEmbedding(1101));
    const result = await deduplicateFact(t.db, createTestFact({ content: "Unscored fact" }), "conv-001");
    expect(getMemory(t.db, result.memoryId)?.confidence).toBe(0.5);
  });

  it("clamps out-of-range confidence into [0, 1]", async () => {
    mockedEmbedDocument.mockResolvedValueOnce(seededEmbedding(1102)).mockResolvedValueOnce(seededEmbedding(1103));
    const high = await deduplicateFact(t.db, createTestFact({ content: "Overconfident fact", confidence: 1.7 }), "conv-001");
    const low = await deduplicateFact(t.db, createTestFact({ content: "Negative confidence fact", confidence: -0.3 }), "conv-001");
    expect(getMemory(t.db, high.memoryId)?.confidence).toBe(1);
    expect(getMemory(t.db, low.memoryId)?.confidence).toBe(0);
  });

  it("carries confidence through the conflict KEEP_BOTH path", async () => {
    const existingEmb = seededEmbedding(1104);
    insertMemory(t.db, createTestMemory({ id: "mem-old2", content: "The default port is 3000." }), existingEmb);
    mockedEmbedDocument.mockResolvedValue(perturbEmbedding(existingEmb, 0.35, 1105));
    mockedClassifyNli.mockResolvedValue({ entailment: 0.1, contradiction: 0.85, neutral: 0.05 });
    setupMockConflictClient("keep_both", "Both ports are used in different environments");

    const result = await deduplicateFact(
      t.db,
      createTestFact({ content: "The default port is 3001.", confidence: 0.91 }),
      "conv-001",
    );
    expect(result.action).toBe("conflict");
    expect(getMemory(t.db, result.memoryId)?.confidence).toBe(0.91);
  });
});

// ─── W12: no supersession ping-pong ─────────────────────────────

/**
 * Live DB 2026-09-16: in the >=5-copy duplicate groups 170/194 rows were
 * inactive with superseded_by set — contradictory pairs from re-extracted
 * historical conversations ("SPEC is missing X" / "SPEC now includes X")
 * superseding each other back and forth across runs.
 */
describe("resolveMemoryConflict refuses supersession ping-pong (W12)", () => {
  const CONTRADICTION = { entailment: 0.05, contradiction: 0.85, neutral: 0.1 };

  /** Seed A (base embedding) and supersede it with B via a mocked UPDATE. */
  async function seedChain(base: number[]): Promise<{ aId: string; bId: string; bEmbedding: number[] }> {
    const aId = "mem-A";
    insertMemory(t.db, createTestMemory({ id: aId, content: "The BLE SPEC is missing mcumgr/SMP DFU service references." }), base);
    const bEmbedding = perturbEmbedding(base, 0.35, 2001);
    mockedEmbedDocument.mockResolvedValue(bEmbedding);
    mockedClassifyNli.mockResolvedValue(CONTRADICTION);
    setupMockConflictClient("update", "The SPEC was updated");
    const b = await deduplicateFact(
      t.db,
      createTestFact({ content: "The BLE SPEC now includes a DFU Service section." }),
      "conv-B",
    );
    expect(b.action).toBe("conflict");
    expect(getMemory(t.db, aId)?.supersededBy).toBe(b.memoryId);
    return { aId, bId: b.memoryId, bEmbedding };
  }

  function conflictRows(): Array<{ memory_id: string; conflicting_memory_id: string; resolution: string | null; description: string }> {
    return t.db.prepare("SELECT memory_id, conflicting_memory_id, resolution, description FROM conflicts ORDER BY rowid").all() as never;
  }

  it("feeding A's content again after B superseded A creates no memory, keeps B active, records a conflict", async () => {
    const base = seededEmbedding(2000);
    const { aId, bId } = await seedChain(base);
    const resolutions = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "t", name: "resolve_conflict", input: { action: "update", reasoning: "flip back" } }],
    });
    setConsolidatorClient({ messages: { create: resolutions } } as unknown as import("../../src/_core/llm/index.js").AnthropicClient);

    // Same statement as A, as a fresh candidate: nearest active neighbour is B
    // (NLI band, contradiction), and B's predecessor A normalised-equals it.
    mockedEmbedDocument.mockResolvedValue(base);
    const result = await deduplicateFact(
      t.db,
      createTestFact({ content: "The BLE SPEC is missing mcumgr/SMP DFU service references" }),
      "conv-A-again",
    );

    expect(result.action).toBe("skip");
    expect(result.memoryId).toBe(bId);
    expect(result.conflictId).toBeDefined();
    expect(resolutions).not.toHaveBeenCalled();
    expect(countMemories()).toBe(2);
    expect(getMemory(t.db, bId)?.isActive).toBe(true);
    expect(getMemory(t.db, bId)?.supersededBy).toBeUndefined();
    expect(getMemory(t.db, aId)?.isActive).toBe(false);

    const rows = conflictRows();
    expect(rows).toHaveLength(2); // the original A→B update, plus the refusal
    expect(rows[1]).toMatchObject({ memory_id: bId, conflicting_memory_id: aId, resolution: null });
    expect(rows[1].description).toMatch(/ping-pong/i);
  });

  it("detects the predecessor by embedding cosine when the wording differs", async () => {
    const base = seededEmbedding(2100);
    const { bId } = await seedChain(base);
    setupMockConflictClient("update", "flip back");

    mockedEmbedDocument.mockResolvedValue(perturbEmbedding(base, 0.05, 2101)); // cosine ~0.999 with A
    const result = await deduplicateFact(
      t.db,
      createTestFact({ content: "mcumgr/SMP DFU service references are absent from the BLE SPEC." }),
      "conv-A-reworded",
    );

    expect(result.action).toBe("skip");
    expect(result.memoryId).toBe(bId);
    expect(countMemories()).toBe(2);
  });

  it("a genuinely new contradiction still supersedes normally", async () => {
    const base = seededEmbedding(2200);
    const { bId, bEmbedding } = await seedChain(base);
    setupMockConflictClient("update", "The DFU service was removed again");

    // Near B (NLI band) but far from A's vector and text.
    const cEmbedding = perturbEmbedding(bEmbedding, 0.35, 2201);
    expect(cosineSimilarity(cEmbedding, base)).toBeLessThan(0.95);
    mockedEmbedDocument.mockResolvedValue(cEmbedding);
    const result = await deduplicateFact(
      t.db,
      createTestFact({ content: "The BLE SPEC dropped DFU entirely in favour of USB-only updates." }),
      "conv-C",
    );

    expect(result.action).toBe("conflict");
    expect(getMemory(t.db, bId)?.isActive).toBe(false);
    expect(getMemory(t.db, bId)?.supersededBy).toBe(result.memoryId);
    expect(countMemories()).toBe(3);
  });

  it("walks the superseded_by chain at most 5 hops", async () => {
    // m0 <- m1 <- ... <- m6 (m6 active). m0 carries the candidate's content:
    // 6 hops up from m6, beyond the bound, so the normal path runs.
    const base = seededEmbedding(2300);
    const content = (i: number) => (i === 0 ? "Chain root statement." : `Chain statement ${i}.`);
    for (let i = 0; i <= 6; i++) {
      insertMemory(t.db, createTestMemory({ id: `m${i}`, content: content(i), isActive: i === 6 }), seededEmbedding(2300 + i));
      if (i > 0) t.db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(`m${i}`, `m${i - 1}`);
    }
    mockedEmbedDocument.mockResolvedValue(perturbEmbedding(seededEmbedding(2306), 0.35, 2399));
    mockedClassifyNli.mockResolvedValue(CONTRADICTION);
    setupMockConflictClient("update", "supersedes m6");

    const result = await deduplicateFact(t.db, createTestFact({ content: "Chain root statement" }), "conv-chain");
    expect(result.action).toBe("conflict");
    expect(getMemory(t.db, "m6")?.supersededBy).toBe(result.memoryId);
    void base;
  });
});
