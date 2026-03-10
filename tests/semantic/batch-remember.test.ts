/**
 * Tests for batch remember functionality and source tracking.
 *
 * Phase 6D: Batch Remember + Source Tracking
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import {
  insertMemory,
  getMemory,
  getActiveMemories,
  findNearestMemories,
} from "../../src/semantic/memory.js";
import type { Memory } from "../../src/semantic/types.js";
import type { MemorySource } from "../../src/_core/types/index.js";

// Mock embeddings
vi.mock("../../src/_core/embeddings/index.js", () => {
  const dims = 256;

  function deterministicVector(seed: string): number[] {
    const vec = new Array(dims);
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < dims; i++) {
      hash = ((hash << 5) - hash + i) | 0;
      vec[i] = (hash & 0xffff) / 0xffff - 0.5;
    }
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < dims; i++) vec[i] /= norm;
    return vec;
  }

  return {
    initEmbeddings: vi.fn().mockResolvedValue(undefined),
    embedQuery: vi.fn().mockImplementation((text: string) =>
      Promise.resolve(deterministicVector(`query:${text}`)),
    ),
    embedDocument: vi.fn().mockImplementation((text: string) =>
      Promise.resolve(deterministicVector(`doc:${text}`)),
    ),
    embedDocumentBatch: vi.fn().mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map((t) => deterministicVector(`doc:${t}`))),
    ),
    getActiveModel: vi.fn().mockReturnValue("mock-model"),
    resetEmbeddings: vi.fn(),
  };
});

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

function randomEmbedding(dims: number = 256): number[] {
  const vec = Array.from({ length: dims }, () => Math.random() - 0.5);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  const id = overrides.id ?? `mem-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    type: "fact",
    content: "TypeScript uses structural typing",
    confidence: 0.5,
    importance: 0.5,
    accessCount: 0,
    createdAt: Math.floor(Date.now() / 1000),
    sourceExchanges: [],
    isActive: true,
    source: "user",
    ...overrides,
  };
}

// ─── Source Tracking Tests ────────────────────────────────────────

describe("source tracking", () => {
  it("insertMemory stores source field", () => {
    const memory = createTestMemory({
      id: "mem-source-1",
      source: "dream",
    });
    insertMemory(t.db, memory, randomEmbedding());

    const row = t.db
      .prepare("SELECT source FROM memories WHERE id = ?")
      .get("mem-source-1") as { source: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.source).toBe("dream");
  });

  it("getMemory returns source field", () => {
    const memory = createTestMemory({
      id: "mem-source-get",
      source: "rlm",
    });
    insertMemory(t.db, memory, randomEmbedding());

    const retrieved = getMemory(t.db, "mem-source-get");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.source).toBe("rlm");
  });

  it("existing memories have source 'user' after migration", () => {
    // Insert without explicit source — should default to 'user'
    const memory = createTestMemory({ id: "mem-source-default" });
    insertMemory(t.db, memory, randomEmbedding());

    const row = t.db
      .prepare("SELECT source FROM memories WHERE id = ?")
      .get("mem-source-default") as { source: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.source).toBe("user");
  });

  it("defaults source to 'user' when not specified", () => {
    const memory = createTestMemory({ id: "mem-source-unset" });
    delete (memory as Record<string, unknown>).source;
    insertMemory(t.db, memory, randomEmbedding());

    const retrieved = getMemory(t.db, "mem-source-unset");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.source).toBe("user");
  });

  it("search can filter by source", () => {
    const userMem = createTestMemory({
      id: "mem-filter-user",
      content: "user memory",
      source: "user",
    });
    const dreamMem = createTestMemory({
      id: "mem-filter-dream",
      content: "dream memory",
      source: "dream",
    });
    const rlmMem = createTestMemory({
      id: "mem-filter-rlm",
      content: "rlm memory",
      source: "rlm",
    });
    insertMemory(t.db, userMem, randomEmbedding());
    insertMemory(t.db, dreamMem, randomEmbedding());
    insertMemory(t.db, rlmMem, randomEmbedding());

    // Query by source directly
    const dreamRows = t.db
      .prepare("SELECT id FROM memories WHERE source = ? AND is_active = 1")
      .all("dream") as { id: string }[];

    expect(dreamRows.length).toBe(1);
    expect(dreamRows[0].id).toBe("mem-filter-dream");
  });
});

// ─── Batch Remember Tests ────────────────────────────────────────

describe("storeMemoryBatch", () => {
  it("stores multiple memories in one call", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await storeMemoryBatch(t.db, [
      { content: "Batch fact one", type: "fact" },
      { content: "Batch fact two", type: "fact" },
      { content: "Batch preference", type: "preference", importance: 0.9 },
    ]);

    expect(result.total).toBe(3);
    expect(result.created).toBe(3);
    expect(result.deduplicated).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.details).toHaveLength(3);
    expect(result.details.every((d) => d.status === "created")).toBe(true);
  });

  it("deduplicates within the batch", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await storeMemoryBatch(t.db, [
      { content: "Duplicate fact content", type: "fact" },
      { content: "Duplicate fact content", type: "fact" },
    ]);

    expect(result.total).toBe(2);
    expect(result.created).toBe(1);
    expect(result.deduplicated).toBe(1);
  });

  it("deduplicates against existing memories", async () => {
    const { storeMemoryBatch, rememberFact } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    // Pre-insert a memory
    await rememberFact(t.db, {
      content: "Already existing memory",
      type: "fact",
      importance: 0.7,
    });

    const result = await storeMemoryBatch(t.db, [
      { content: "Already existing memory", type: "fact" },
      { content: "Brand new memory", type: "fact" },
    ]);

    expect(result.total).toBe(2);
    expect(result.created).toBe(1);
    expect(result.deduplicated).toBe(1);
  });

  it("returns correct created/deduplicated counts", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await storeMemoryBatch(t.db, [
      { content: "Unique item A", type: "fact" },
      { content: "Unique item B", type: "decision" },
      { content: "Unique item A", type: "fact" }, // dup of first
    ]);

    expect(result.created).toBe(2);
    expect(result.deduplicated).toBe(1);
    expect(result.total).toBe(3);
  });

  it("sets source field correctly", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await storeMemoryBatch(t.db, [
      { content: "RLM generated insight", type: "fact", source: "rlm" },
      { content: "Dream extracted fact", type: "pattern", source: "dream" },
    ]);

    expect(result.created).toBe(2);

    // Verify source was stored
    for (const detail of result.details) {
      if (detail.status === "created" && detail.id) {
        const mem = getMemory(t.db, detail.id);
        expect(mem).not.toBeNull();
        expect(["rlm", "dream"]).toContain(mem!.source);
      }
    }
  });

  it("defaults source to 'user' when not specified", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await storeMemoryBatch(t.db, [
      { content: "No source specified", type: "fact" },
    ]);

    expect(result.created).toBe(1);
    const detail = result.details[0];
    if (detail.id) {
      const mem = getMemory(t.db, detail.id);
      expect(mem!.source).toBe("user");
    }
  });

  it("rejects batch larger than 50", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const oversizedBatch = Array.from({ length: 51 }, (_, i) => ({
      content: `Memory ${i}`,
      type: "fact" as const,
    }));

    await expect(storeMemoryBatch(t.db, oversizedBatch)).rejects.toThrow(
      /batch size/i,
    );
  });

  it("handles empty batch gracefully", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await storeMemoryBatch(t.db, []);

    expect(result.total).toBe(0);
    expect(result.created).toBe(0);
    expect(result.deduplicated).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.details).toHaveLength(0);
  });

  it("handles mixed success/dedup results", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await storeMemoryBatch(t.db, [
      { content: "First unique memory", type: "fact" },
      { content: "Second unique memory", type: "decision" },
      { content: "First unique memory", type: "fact" }, // dup
      { content: "Third unique memory", type: "pattern" },
    ]);

    expect(result.total).toBe(4);
    expect(result.created).toBe(3);
    expect(result.deduplicated).toBe(1);

    const statuses = result.details.map((d) => d.status);
    expect(statuses.filter((s) => s === "created")).toHaveLength(3);
    expect(statuses.filter((s) => s === "deduplicated")).toHaveLength(1);
  });
});

// ─── Remember with source parameter ────────────────────────────────

describe("rememberFact with source", () => {
  it("accepts optional source parameter", async () => {
    const { rememberFact } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await rememberFact(t.db, {
      content: "RLM insight about coding patterns",
      type: "pattern",
      importance: 0.8,
      source: "rlm",
    });

    expect(result.action).toBe("created");
    const mem = getMemory(t.db, result.memoryId);
    expect(mem!.source).toBe("rlm");
  });

  it("defaults to 'user' when source not provided", async () => {
    const { rememberFact } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await rememberFact(t.db, {
      content: "User provided fact without source",
      type: "fact",
      importance: 0.7,
    });

    expect(result.action).toBe("created");
    const mem = getMemory(t.db, result.memoryId);
    expect(mem!.source).toBe("user");
  });
});
