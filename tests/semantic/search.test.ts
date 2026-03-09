import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchSemantic } from "../../src/semantic/search.js";
import {
  insertMemory,
  deactivateMemory,
} from "../../src/semantic/memory.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { Memory } from "../../src/semantic/types.js";

// ─── Mock embeddings to avoid loading the real model ────────────

vi.mock("../../src/_core/embeddings/index.js", () => ({
  embedQuery: vi.fn(),
}));

import { embedQuery } from "../../src/_core/embeddings/index.js";

const mockedEmbedQuery = vi.mocked(embedQuery);

// ─── Helpers ────────────────────────────────────────────────────

let t: TestDb;

function randomEmbedding(dims: number = 256): number[] {
  const vec = Array.from({ length: dims }, () => Math.random() - 0.5);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

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

function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  const id =
    overrides.id ?? `mem-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    type: "fact",
    content: "Default test memory content",
    confidence: 0.5,
    importance: 0.5,
    accessCount: 0,
    createdAt: Math.floor(Date.now() / 1000),
    sourceExchanges: ["exch-001"],
    isActive: true,
    ...overrides,
  };
}

// ─── Setup / Teardown ───────────────────────────────────────────

beforeEach(() => {
  t = createTestDb();
  vi.clearAllMocks();
});

afterEach(() => {
  t.cleanup();
});

// ─── Tests ──────────────────────────────────────────────────────

describe("searchSemantic", () => {
  it("returns memories matching query", async () => {
    // Insert test memories with known embeddings
    const fishEmb = seededEmbedding(10);
    const sqliteEmb = seededEmbedding(20);

    const fishMem = createTestMemory({
      id: "mem-fish",
      content: "User prefers Fish shell and uses tmux always",
      type: "preference",
      importance: 0.8,
    });
    const sqliteMem = createTestMemory({
      id: "mem-sqlite",
      content: "The project uses SQLite with WAL mode",
      type: "decision",
      importance: 0.7,
    });

    insertMemory(t.db, fishMem, fishEmb);
    insertMemory(t.db, sqliteMem, sqliteEmb);

    // Return embedding close to the fish memory
    mockedEmbedQuery.mockResolvedValue(fishEmb);

    const results = await searchSemantic(t.db, {
      query: "Fish shell preference",
    });

    expect(results.length).toBeGreaterThan(0);
    // The fish memory should be in the results since we queried with its embedding
    const fishResult = results.find((r) => r.id === "mem-fish");
    expect(fishResult).toBeDefined();
    expect(fishResult!.source).toBe("semantic");
  });

  it("results include type, confidence, importance in metadata", async () => {
    const emb = seededEmbedding(30);
    const mem = createTestMemory({
      id: "mem-meta",
      content: "TypeScript uses structural typing",
      type: "fact",
      confidence: 0.7,
      importance: 0.9,
      context: "Discussed during code review",
    });

    insertMemory(t.db, mem, emb);
    mockedEmbedQuery.mockResolvedValue(emb);

    const results = await searchSemantic(t.db, { query: "typing" });

    expect(results.length).toBeGreaterThan(0);
    const result = results.find((r) => r.id === "mem-meta");
    expect(result).toBeDefined();

    const meta = result!.metadata as Record<string, unknown>;
    expect(meta.type).toBe("fact");
    expect(meta.confidence).toBe(0.7);
    expect(meta.importance).toBe(0.9);
    expect(meta.context).toBe("Discussed during code review");
  });

  it("excludes deactivated memories", async () => {
    const emb = seededEmbedding(40);
    const activeMem = createTestMemory({
      id: "mem-active",
      content: "Active memory content",
    });
    const inactiveMem = createTestMemory({
      id: "mem-inactive",
      content: "Inactive memory content",
    });

    insertMemory(t.db, activeMem, emb);
    insertMemory(t.db, inactiveMem, emb);
    deactivateMemory(t.db, "mem-inactive", "mem-active");

    mockedEmbedQuery.mockResolvedValue(emb);

    const results = await searchSemantic(t.db, {
      query: "memory content",
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain("mem-active");
    expect(ids).not.toContain("mem-inactive");
  });

  it("type filter works", async () => {
    const prefEmb = seededEmbedding(50);
    const factEmb = seededEmbedding(51);

    const prefMem = createTestMemory({
      id: "mem-pref",
      content: "User prefers dark mode",
      type: "preference",
    });
    const factMem = createTestMemory({
      id: "mem-fact",
      content: "The sky is blue",
      type: "fact",
    });

    insertMemory(t.db, prefMem, prefEmb);
    insertMemory(t.db, factMem, factEmb);

    // Query close to both
    mockedEmbedQuery.mockResolvedValue(prefEmb);

    const results = await searchSemantic(t.db, {
      query: "user preference",
      types: ["preference"],
    });

    // All results should be preferences
    for (const r of results) {
      const meta = r.metadata as Record<string, unknown>;
      expect(meta.type).toBe("preference");
    }
  });

  it("scores normalized to [0.1, 1.0]", async () => {
    // Insert multiple memories
    for (let i = 0; i < 5; i++) {
      const emb = seededEmbedding(60 + i);
      const mem = createTestMemory({
        id: `mem-norm-${i}`,
        content: `Memory content number ${i}`,
        importance: 0.5 + i * 0.1,
      });
      insertMemory(t.db, mem, emb);
    }

    mockedEmbedQuery.mockResolvedValue(seededEmbedding(60));

    const results = await searchSemantic(t.db, {
      query: "memory content",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);

    for (const result of results) {
      expect(result.score).toBeGreaterThanOrEqual(0.1);
      expect(result.score).toBeLessThanOrEqual(1.0);
    }
  });

  it("empty query returns empty results", async () => {
    const emb = seededEmbedding(70);
    const mem = createTestMemory({
      id: "mem-empty-q",
      content: "Some content",
    });
    insertMemory(t.db, mem, emb);

    const results = await searchSemantic(t.db, { query: "" });
    expect(results).toEqual([]);
  });

  it("returns empty when no memories exist", async () => {
    mockedEmbedQuery.mockResolvedValue(seededEmbedding(80));

    const results = await searchSemantic(t.db, {
      query: "nonexistent topic",
    });

    expect(results).toEqual([]);
  });
});
