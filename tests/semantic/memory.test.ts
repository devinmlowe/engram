import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  insertMemory,
  updateMemory,
  deactivateMemory,
  getMemory,
  getActiveMemories,
  recordAccess,
  insertConflict,
  getUnresolvedConflicts,
  resolveConflict,
  findNearestMemories,
} from "../../src/semantic/memory.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { Memory, Conflict } from "../../src/semantic/types.js";

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
    sourceExchanges: ["exch-001"],
    isActive: true,
    ...overrides,
  };
}

function createTestConflict(overrides: Partial<Conflict> = {}): Conflict {
  return {
    id: `conflict-${Math.random().toString(36).slice(2, 10)}`,
    memoryId: "mem-001",
    conflictingMemoryId: "mem-002",
    description: "Contradictory statements about TypeScript typing",
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe("Semantic Memory CRUD", () => {
  describe("insertMemory", () => {
    it("writes to memories table", () => {
      const memory = createTestMemory({ id: "mem-insert-1" });
      insertMemory(t.db, memory, randomEmbedding());

      const row = t.db
        .prepare("SELECT * FROM memories WHERE id = ?")
        .get("mem-insert-1") as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.id).toBe("mem-insert-1");
      expect(row.type).toBe("fact");
      expect(row.content).toBe("TypeScript uses structural typing");
      expect(row.confidence).toBe(0.5);
      expect(row.importance).toBe(0.5);
      expect(row.access_count).toBe(0);
      expect(row.is_active).toBe(1);
      expect(JSON.parse(row.source_exchanges as string)).toEqual(["exch-001"]);
    });

    it("writes to memories_fts (FTS5 MATCH query)", () => {
      const memory = createTestMemory({
        id: "mem-fts-1",
        content: "Zettelkasten is a knowledge management method",
      });
      insertMemory(t.db, memory, randomEmbedding());

      const results = t.db
        .prepare(
          "SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?",
        )
        .all("zettelkasten") as { rowid: number }[];

      expect(results.length).toBeGreaterThan(0);
    });

    it("writes to vec_memories (vector MATCH query)", () => {
      const memory = createTestMemory({ id: "mem-vec-1" });
      const embedding = randomEmbedding();
      insertMemory(t.db, memory, embedding);

      const queryBuf = Buffer.from(new Float32Array(embedding).buffer);
      const results = t.db
        .prepare(
          "SELECT id, distance FROM vec_memories WHERE embedding MATCH ? AND k = 5",
        )
        .all(queryBuf) as { id: string; distance: number }[];

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("mem-vec-1");
      expect(results[0].distance).toBeCloseTo(0, 3);
    });
  });

  describe("getMemory", () => {
    it("returns correct memory by ID", () => {
      const memory = createTestMemory({
        id: "mem-get-1",
        content: "Fish shell uses a different syntax",
        context: "shell configuration discussion",
      });
      insertMemory(t.db, memory, randomEmbedding());

      const retrieved = getMemory(t.db, "mem-get-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("mem-get-1");
      expect(retrieved!.content).toBe("Fish shell uses a different syntax");
      expect(retrieved!.context).toBe("shell configuration discussion");
      expect(retrieved!.type).toBe("fact");
      expect(retrieved!.isActive).toBe(true);
      expect(retrieved!.sourceExchanges).toEqual(["exch-001"]);
    });

    it("returns null for nonexistent ID", () => {
      const result = getMemory(t.db, "nonexistent-id");
      expect(result).toBeNull();
    });
  });

  describe("updateMemory", () => {
    it("updates content and syncs FTS", () => {
      const memory = createTestMemory({
        id: "mem-update-1",
        content: "TypeScript uses nominal typing",
      });
      insertMemory(t.db, memory, randomEmbedding());

      updateMemory(t.db, "mem-update-1", {
        content: "TypeScript uses structural typing by default",
      });

      // Verify base table updated
      const retrieved = getMemory(t.db, "mem-update-1");
      expect(retrieved!.content).toBe(
        "TypeScript uses structural typing by default",
      );
      expect(retrieved!.updatedAt).toBeDefined();

      // Verify FTS updated — old content should NOT match
      const oldResults = t.db
        .prepare(
          "SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?",
        )
        .all("nominal") as { rowid: number }[];
      expect(oldResults.length).toBe(0);

      // New content should match
      const newResults = t.db
        .prepare(
          "SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?",
        )
        .all("structural") as { rowid: number }[];
      expect(newResults.length).toBeGreaterThan(0);
    });
  });

  describe("deactivateMemory", () => {
    it("sets is_active=false and superseded_by", () => {
      const memory = createTestMemory({ id: "mem-deactivate-1" });
      insertMemory(t.db, memory, randomEmbedding());

      deactivateMemory(t.db, "mem-deactivate-1", "mem-successor-1");

      const retrieved = getMemory(t.db, "mem-deactivate-1");
      expect(retrieved!.isActive).toBe(false);
      expect(retrieved!.supersededBy).toBe("mem-successor-1");
      expect(retrieved!.updatedAt).toBeDefined();
    });
  });

  describe("recordAccess", () => {
    it("increments access_count and updates last_accessed", () => {
      const memory = createTestMemory({
        id: "mem-access-1",
        accessCount: 0,
      });
      insertMemory(t.db, memory, randomEmbedding());

      recordAccess(t.db, "mem-access-1");
      recordAccess(t.db, "mem-access-1");

      const retrieved = getMemory(t.db, "mem-access-1");
      expect(retrieved!.accessCount).toBe(2);
      expect(retrieved!.lastAccessed).toBeDefined();
      expect(retrieved!.lastAccessed).toBeGreaterThan(0);
    });
  });

  describe("getActiveMemories", () => {
    it("excludes deactivated memories", () => {
      const mem1 = createTestMemory({ id: "mem-active-1", type: "fact" });
      const mem2 = createTestMemory({ id: "mem-active-2", type: "fact" });
      insertMemory(t.db, mem1, randomEmbedding());
      insertMemory(t.db, mem2, randomEmbedding());

      deactivateMemory(t.db, "mem-active-2", "mem-active-1");

      const active = getActiveMemories(t.db);
      const ids = active.map((m) => m.id);
      expect(ids).toContain("mem-active-1");
      expect(ids).not.toContain("mem-active-2");
    });

    it("filters by type when specified", () => {
      const factMem = createTestMemory({ id: "mem-type-fact", type: "fact" });
      const prefMem = createTestMemory({
        id: "mem-type-pref",
        type: "preference",
        content: "User prefers dark mode",
      });
      insertMemory(t.db, factMem, randomEmbedding());
      insertMemory(t.db, prefMem, randomEmbedding());

      const facts = getActiveMemories(t.db, "fact");
      const prefs = getActiveMemories(t.db, "preference");

      expect(facts.every((m) => m.type === "fact")).toBe(true);
      expect(prefs.every((m) => m.type === "preference")).toBe(true);
      expect(facts.map((m) => m.id)).toContain("mem-type-fact");
      expect(prefs.map((m) => m.id)).toContain("mem-type-pref");
    });
  });

  describe("findNearestMemories", () => {
    it("returns neighbors sorted by distance", () => {
      // Insert 3 memories with known embeddings
      const baseVec = randomEmbedding();
      const similarVec = baseVec.map((v) => v + (Math.random() - 0.5) * 0.01);
      const differentVec = randomEmbedding();

      const mem1 = createTestMemory({ id: "mem-near-1" });
      const mem2 = createTestMemory({ id: "mem-near-2" });
      const mem3 = createTestMemory({ id: "mem-near-3" });

      insertMemory(t.db, mem1, baseVec);
      insertMemory(t.db, mem2, similarVec);
      insertMemory(t.db, mem3, differentVec);

      const results = findNearestMemories(t.db, baseVec, 3);

      expect(results.length).toBeGreaterThanOrEqual(2);
      // First result should be the exact match
      expect(results[0].id).toBe("mem-near-1");
      expect(results[0].distance).toBeCloseTo(0, 2);
      // Results should be sorted by distance
      for (let i = 1; i < results.length; i++) {
        expect(results[i].distance).toBeGreaterThanOrEqual(
          results[i - 1].distance,
        );
      }
    });

    it("excludes deactivated memories", () => {
      const embedding = randomEmbedding();
      const mem1 = createTestMemory({ id: "mem-vec-active" });
      const mem2 = createTestMemory({ id: "mem-vec-inactive" });

      insertMemory(t.db, mem1, embedding);
      insertMemory(t.db, mem2, embedding);

      deactivateMemory(t.db, "mem-vec-inactive", "mem-vec-active");

      const results = findNearestMemories(t.db, embedding, 10);
      const ids = results.map((r) => r.id);

      expect(ids).toContain("mem-vec-active");
      expect(ids).not.toContain("mem-vec-inactive");
    });
  });

  describe("Conflict tracking", () => {
    it("insertConflict and getUnresolvedConflicts round-trip", () => {
      // Need memories to exist for foreign key constraint
      const mem1 = createTestMemory({ id: "mem-conflict-a" });
      const mem2 = createTestMemory({ id: "mem-conflict-b" });
      insertMemory(t.db, mem1, randomEmbedding());
      insertMemory(t.db, mem2, randomEmbedding());

      const conflict = createTestConflict({
        id: "conflict-1",
        memoryId: "mem-conflict-a",
        conflictingMemoryId: "mem-conflict-b",
        description: "Contradictory info about typing systems",
      });
      insertConflict(t.db, conflict);

      const unresolved = getUnresolvedConflicts(t.db);
      expect(unresolved.length).toBe(1);
      expect(unresolved[0].id).toBe("conflict-1");
      expect(unresolved[0].memoryId).toBe("mem-conflict-a");
      expect(unresolved[0].conflictingMemoryId).toBe("mem-conflict-b");
      expect(unresolved[0].description).toBe(
        "Contradictory info about typing systems",
      );
      expect(unresolved[0].resolution).toBeUndefined();
    });

    it("resolveConflict sets resolution and resolved_at", () => {
      const mem1 = createTestMemory({ id: "mem-resolve-a" });
      const mem2 = createTestMemory({ id: "mem-resolve-b" });
      insertMemory(t.db, mem1, randomEmbedding());
      insertMemory(t.db, mem2, randomEmbedding());

      const conflict = createTestConflict({
        id: "conflict-resolve-1",
        memoryId: "mem-resolve-a",
        conflictingMemoryId: "mem-resolve-b",
      });
      insertConflict(t.db, conflict);

      resolveConflict(
        t.db,
        "conflict-resolve-1",
        "Kept newer memory as authoritative",
      );

      // Should no longer appear in unresolved
      const unresolved = getUnresolvedConflicts(t.db);
      expect(unresolved.length).toBe(0);

      // Verify resolution was stored
      const row = t.db
        .prepare("SELECT * FROM conflicts WHERE id = ?")
        .get("conflict-resolve-1") as Record<string, unknown>;
      expect(row.resolution).toBe("Kept newer memory as authoritative");
      expect(row.resolved_at).toBeDefined();
      expect(row.resolved_at).toBeGreaterThan(0);
    });
  });
});
