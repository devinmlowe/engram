import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  insertRelationship,
  getRelationship,
  getRelationshipsForEntity,
  getRelationshipsBetween,
  findOrCreateRelationship,
  computeEdgeWeight,
} from "../../src/graph/relationship.js";
import { insertEntity } from "../../src/graph/entity.js";
import {
  createTestDb,
  createTestEntity,
  createTestRelationship,
} from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { EdgeWeightFactors } from "../../src/graph/types.js";

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  // Insert entities that relationships will reference (FK constraints)
  const embedding = Array.from({ length: 256 }, () => Math.random() * 2 - 1);
  insertEntity(
    t.db,
    createTestEntity({ id: "ent-a", name: "TypeScript" }),
    embedding,
  );
  insertEntity(
    t.db,
    createTestEntity({ id: "ent-b", name: "Node.js" }),
    [...embedding].map((v) => v + 0.01),
  );
  insertEntity(
    t.db,
    createTestEntity({ id: "ent-c", name: "React" }),
    [...embedding].map((v) => v - 0.01),
  );
});

afterEach(() => {
  t.cleanup();
});

describe("Relationship CRUD", () => {
  describe("insertRelationship", () => {
    it("writes to relationships table", () => {
      const rel = createTestRelationship({
        id: "rel-insert-1",
        sourceEntityId: "ent-a",
        targetEntityId: "ent-b",
        type: "uses",
        weight: 0.75,
        context: "TypeScript runs on Node.js",
        sourceMemories: ["mem-001"],
      });
      insertRelationship(t.db, rel);

      const row = t.db
        .prepare("SELECT * FROM relationships WHERE id = ?")
        .get("rel-insert-1") as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.id).toBe("rel-insert-1");
      expect(row.source_entity_id).toBe("ent-a");
      expect(row.target_entity_id).toBe("ent-b");
      expect(row.type).toBe("uses");
      expect(row.weight).toBe(0.75);
      expect(row.context).toBe("TypeScript runs on Node.js");
      expect(JSON.parse(row.source_memories as string)).toEqual(["mem-001"]);
    });

    it("does not create duplicate with same ID (INSERT OR IGNORE)", () => {
      const rel = createTestRelationship({
        id: "rel-dup-1",
        sourceEntityId: "ent-a",
        targetEntityId: "ent-b",
        type: "uses",
      });
      insertRelationship(t.db, rel);
      insertRelationship(t.db, rel); // Should not throw

      const count = t.db
        .prepare("SELECT COUNT(*) as cnt FROM relationships WHERE id = ?")
        .get("rel-dup-1") as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  describe("getRelationship", () => {
    it("returns correct relationship by ID", () => {
      const rel = createTestRelationship({
        id: "rel-get-1",
        sourceEntityId: "ent-a",
        targetEntityId: "ent-b",
        type: "depends_on",
        weight: 0.5,
        context: "TS depends on Node runtime",
      });
      insertRelationship(t.db, rel);

      const retrieved = getRelationship(t.db, "rel-get-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("rel-get-1");
      expect(retrieved!.sourceEntityId).toBe("ent-a");
      expect(retrieved!.targetEntityId).toBe("ent-b");
      expect(retrieved!.type).toBe("depends_on");
      expect(retrieved!.weight).toBe(0.5);
      expect(retrieved!.context).toBe("TS depends on Node runtime");
    });

    it("returns null for nonexistent ID", () => {
      expect(getRelationship(t.db, "nonexistent")).toBeNull();
    });
  });

  describe("getRelationshipsForEntity", () => {
    it("returns both incoming and outgoing edges", () => {
      // ent-a -> ent-b (outgoing from ent-a)
      insertRelationship(
        t.db,
        createTestRelationship({
          id: "rel-for-1",
          sourceEntityId: "ent-a",
          targetEntityId: "ent-b",
          type: "uses",
        }),
      );
      // ent-c -> ent-a (incoming to ent-a)
      insertRelationship(
        t.db,
        createTestRelationship({
          id: "rel-for-2",
          sourceEntityId: "ent-c",
          targetEntityId: "ent-a",
          type: "depends_on",
        }),
      );
      // ent-b -> ent-c (unrelated to ent-a)
      insertRelationship(
        t.db,
        createTestRelationship({
          id: "rel-for-3",
          sourceEntityId: "ent-b",
          targetEntityId: "ent-c",
          type: "related_to",
        }),
      );

      const rels = getRelationshipsForEntity(t.db, "ent-a");
      expect(rels.length).toBe(2);

      const ids = rels.map((r) => r.id);
      expect(ids).toContain("rel-for-1");
      expect(ids).toContain("rel-for-2");
      expect(ids).not.toContain("rel-for-3");
    });
  });

  describe("getRelationshipsBetween", () => {
    it("returns edges between two specific entities", () => {
      insertRelationship(
        t.db,
        createTestRelationship({
          id: "rel-between-1",
          sourceEntityId: "ent-a",
          targetEntityId: "ent-b",
          type: "uses",
        }),
      );
      insertRelationship(
        t.db,
        createTestRelationship({
          id: "rel-between-2",
          sourceEntityId: "ent-b",
          targetEntityId: "ent-a",
          type: "depends_on",
        }),
      );
      insertRelationship(
        t.db,
        createTestRelationship({
          id: "rel-between-3",
          sourceEntityId: "ent-a",
          targetEntityId: "ent-c",
          type: "related_to",
        }),
      );

      const rels = getRelationshipsBetween(t.db, "ent-a", "ent-b");
      expect(rels.length).toBe(2);

      const ids = rels.map((r) => r.id);
      expect(ids).toContain("rel-between-1");
      expect(ids).toContain("rel-between-2");
      expect(ids).not.toContain("rel-between-3");
    });
  });

  describe("findOrCreateRelationship", () => {
    it("creates new edge when none exists", () => {
      const rel = findOrCreateRelationship(
        t.db,
        "ent-a",
        "ent-b",
        "uses",
        "TypeScript uses Node.js",
        "mem-100",
      );

      expect(rel).toBeDefined();
      expect(rel.sourceEntityId).toBe("ent-a");
      expect(rel.targetEntityId).toBe("ent-b");
      expect(rel.type).toBe("uses");
      expect(rel.context).toBe("TypeScript uses Node.js");
      expect(rel.sourceMemories).toEqual(["mem-100"]);
      expect(rel.weight).toBe(1.0);
    });

    it("appends memory to existing edge's source_memories", () => {
      // Create initial edge
      findOrCreateRelationship(
        t.db,
        "ent-a",
        "ent-b",
        "uses",
        "First context",
        "mem-200",
      );

      // Add another memory to the same edge
      const updated = findOrCreateRelationship(
        t.db,
        "ent-a",
        "ent-b",
        "uses",
        undefined,
        "mem-201",
      );

      expect(updated.sourceMemories).toContain("mem-200");
      expect(updated.sourceMemories).toContain("mem-201");
      expect(updated.sourceMemories.length).toBe(2);
    });

    it("does not duplicate memory in source_memories", () => {
      findOrCreateRelationship(
        t.db,
        "ent-a",
        "ent-b",
        "uses",
        undefined,
        "mem-300",
      );

      // Try adding the same memory again
      const rel = findOrCreateRelationship(
        t.db,
        "ent-a",
        "ent-b",
        "uses",
        undefined,
        "mem-300",
      );

      expect(rel.sourceMemories).toEqual(["mem-300"]);
    });

    it("does not create duplicate edges for same (source, target, type)", () => {
      findOrCreateRelationship(t.db, "ent-a", "ent-b", "uses");
      findOrCreateRelationship(t.db, "ent-a", "ent-b", "uses");

      const count = t.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM relationships WHERE source_entity_id = ? AND target_entity_id = ? AND type = ?",
        )
        .get("ent-a", "ent-b", "uses") as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });
});

describe("computeEdgeWeight", () => {
  const baseNow = 1700000000; // fixed reference time

  it("produces expected values for known inputs", () => {
    const factors: EdgeWeightFactors = {
      mentionCount: 10,
      lastSeen: baseNow, // just now
      confidence: 0.8,
      sourceImportance: 0.7,
      targetImportance: 0.9,
    };

    const weight = computeEdgeWeight(factors, baseNow);

    // freq: log2(11)/log2(11) = 1.0 -> 0.35 * 1.0 = 0.35
    // recency: 0.9^(0/90) = 1.0 -> 0.25 * 1.0 = 0.25
    // conf: 0.8 -> 0.20 * 0.8 = 0.16
    // imp: (0.7+0.9)/2 = 0.8 -> 0.20 * 0.8 = 0.16
    // total = 0.35 + 0.25 + 0.16 + 0.16 = 0.92
    expect(weight).toBeCloseTo(0.92, 2);
  });

  it("recency decays over time", () => {
    const factors: EdgeWeightFactors = {
      mentionCount: 5,
      lastSeen: baseNow,
      confidence: 0.5,
      sourceImportance: 0.5,
      targetImportance: 0.5,
    };

    const weightNow = computeEdgeWeight(factors, baseNow);

    // 180 days later
    const weightLater = computeEdgeWeight(
      factors,
      baseNow + 180 * 86400,
    );

    expect(weightLater).toBeLessThan(weightNow);

    // After 90 days, recency should be 0.9^1 = 0.9
    const weight90 = computeEdgeWeight(factors, baseNow + 90 * 86400);
    // After 180 days, recency should be 0.9^2 = 0.81
    expect(weight90).toBeGreaterThan(weightLater);
  });

  it("floors at 0.01", () => {
    const factors: EdgeWeightFactors = {
      mentionCount: 0,
      lastSeen: 0, // very old
      confidence: 0,
      sourceImportance: 0,
      targetImportance: 0,
    };

    const weight = computeEdgeWeight(factors, baseNow);
    expect(weight).toBeGreaterThanOrEqual(0.01);
  });

  it("handles zero mentions gracefully", () => {
    const factors: EdgeWeightFactors = {
      mentionCount: 0,
      lastSeen: baseNow,
      confidence: 0.5,
      sourceImportance: 0.5,
      targetImportance: 0.5,
    };

    const weight = computeEdgeWeight(factors, baseNow);
    // freq: log2(1)/log2(11) = 0 -> 0.35 * 0 = 0
    // recency: 1.0 -> 0.25
    // conf: 0.5 -> 0.10
    // imp: 0.5 -> 0.10
    // total = 0 + 0.25 + 0.10 + 0.10 = 0.45
    expect(weight).toBeCloseTo(0.45, 2);
  });
});
