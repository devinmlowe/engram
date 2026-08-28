import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  insertEntity,
  getEntity,
  getEntityByName,
  getEntityByAlias,
  updateEntity,
  recordEntityMention,
  mergeEntities,
  findNearestEntities,
  ftsSearchEntities,
} from "../../src/graph/entity.js";
import { insertRelationship } from "../../src/graph/relationship.js";
import { createTestDb, createTestEntity, createTestRelationship } from "../helpers.js";
import type { TestDb } from "../helpers.js";

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

function randomEmbedding(dims = 256): number[] {
  return Array.from({ length: dims }, () => Math.random() * 2 - 1);
}

describe("Entity CRUD", () => {
  describe("insertEntity", () => {
    it("writes to entities table and vec_entities", () => {
      const entity = createTestEntity({ id: "ent-insert-1" });
      const embedding = randomEmbedding();
      insertEntity(t.db, entity, embedding);

      // Verify entities table
      const row = t.db
        .prepare("SELECT * FROM entities WHERE id = ?")
        .get("ent-insert-1") as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.id).toBe("ent-insert-1");
      expect(row.name).toBe("TypeScript");
      expect(row.type).toBe("technology");
      expect(row.description).toBe("A typed superset of JavaScript");
      expect(row.mention_count).toBe(1);
      expect(JSON.parse(row.aliases as string)).toEqual([]);

      // Verify vec_entities
      const queryBuf = Buffer.from(new Float32Array(embedding).buffer);
      const vecResults = t.db
        .prepare(
          "SELECT id, distance FROM vec_entities WHERE embedding MATCH ? AND k = 5",
        )
        .all(queryBuf) as Array<{ id: string; distance: number }>;

      expect(vecResults.length).toBeGreaterThan(0);
      expect(vecResults[0].id).toBe("ent-insert-1");
      expect(vecResults[0].distance).toBeCloseTo(0, 3);
    });
  });

  describe("getEntity", () => {
    it("returns correct entity by ID", () => {
      const entity = createTestEntity({
        id: "ent-get-1",
        name: "React",
        type: "technology",
        description: "A JavaScript UI library",
        aliases: ["reactjs"],
      });
      insertEntity(t.db, entity, randomEmbedding());

      const retrieved = getEntity(t.db, "ent-get-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("ent-get-1");
      expect(retrieved!.name).toBe("React");
      expect(retrieved!.type).toBe("technology");
      expect(retrieved!.description).toBe("A JavaScript UI library");
      expect(retrieved!.aliases).toEqual(["reactjs"]);
      expect(retrieved!.mentionCount).toBe(1);
    });

    it("returns null for nonexistent ID", () => {
      const result = getEntity(t.db, "nonexistent-id");
      expect(result).toBeNull();
    });
  });

  describe("getEntityByName", () => {
    it("finds entity case-insensitively", () => {
      const entity = createTestEntity({
        id: "ent-name-1",
        name: "TypeScript",
      });
      insertEntity(t.db, entity, randomEmbedding());

      // Exact case
      expect(getEntityByName(t.db, "TypeScript")).not.toBeNull();
      // Lower case
      expect(getEntityByName(t.db, "typescript")).not.toBeNull();
      // Upper case
      expect(getEntityByName(t.db, "TYPESCRIPT")).not.toBeNull();
      // Mixed case
      expect(getEntityByName(t.db, "typeScript")).not.toBeNull();

      // Non-matching
      expect(getEntityByName(t.db, "JavaScript")).toBeNull();
    });
  });

  describe("getEntityByAlias", () => {
    it("finds entity by alias", () => {
      const entity = createTestEntity({
        id: "ent-alias-1",
        name: "TypeScript",
        aliases: ["ts", "TS"],
      });
      insertEntity(t.db, entity, randomEmbedding());

      const found = getEntityByAlias(t.db, "ts");
      expect(found).not.toBeNull();
      expect(found!.id).toBe("ent-alias-1");

      // Case-insensitive alias match
      const foundUpper = getEntityByAlias(t.db, "TS");
      expect(foundUpper).not.toBeNull();
      expect(foundUpper!.id).toBe("ent-alias-1");
    });

    it("returns null for non-matching alias", () => {
      const entity = createTestEntity({
        id: "ent-alias-2",
        name: "TypeScript",
        aliases: ["ts"],
      });
      insertEntity(t.db, entity, randomEmbedding());

      expect(getEntityByAlias(t.db, "js")).toBeNull();
    });
  });

  describe("updateEntity", () => {
    it("updates description", () => {
      const entity = createTestEntity({
        id: "ent-update-1",
        description: "Old description",
      });
      insertEntity(t.db, entity, randomEmbedding());

      updateEntity(t.db, "ent-update-1", {
        description: "New and improved description",
      });

      const retrieved = getEntity(t.db, "ent-update-1");
      expect(retrieved!.description).toBe("New and improved description");
    });

    it("updates name", () => {
      const entity = createTestEntity({
        id: "ent-update-2",
        name: "OldName",
      });
      insertEntity(t.db, entity, randomEmbedding());

      updateEntity(t.db, "ent-update-2", { name: "NewName" });

      const retrieved = getEntity(t.db, "ent-update-2");
      expect(retrieved!.name).toBe("NewName");
    });
  });

  describe("recordEntityMention", () => {
    it("increments mention_count and updates last_seen", () => {
      const entity = createTestEntity({
        id: "ent-mention-1",
        mentionCount: 1,
      });
      insertEntity(t.db, entity, randomEmbedding());

      recordEntityMention(t.db, "ent-mention-1");
      recordEntityMention(t.db, "ent-mention-1");

      const retrieved = getEntity(t.db, "ent-mention-1");
      expect(retrieved!.mentionCount).toBe(3);
      expect(retrieved!.lastSeen).toBeGreaterThan(0);
    });
  });

  describe("mergeEntities", () => {
    it("transfers aliases, repoints relationships, deduplicates edges", () => {
      // Create two entities
      const keepEntity = createTestEntity({
        id: "ent-keep",
        name: "TypeScript",
        aliases: ["ts"],
        mentionCount: 5,
        firstSeen: 1000,
        lastSeen: 2000,
      });
      const mergeEntity = createTestEntity({
        id: "ent-merge",
        name: "TS Lang",
        aliases: ["typescript-lang"],
        mentionCount: 3,
        firstSeen: 500,
        lastSeen: 3000,
      });

      insertEntity(t.db, keepEntity, randomEmbedding());
      insertEntity(t.db, mergeEntity, randomEmbedding());

      // Create a third entity for relationships
      const otherEntity = createTestEntity({
        id: "ent-other",
        name: "Node.js",
      });
      insertEntity(t.db, otherEntity, randomEmbedding());

      // Create relationships pointing to/from merged entity
      const rel1 = createTestRelationship({
        id: "rel-1",
        sourceEntityId: "ent-merge",
        targetEntityId: "ent-other",
        type: "uses",
        weight: 0.8,
      });
      const rel2 = createTestRelationship({
        id: "rel-2",
        sourceEntityId: "ent-other",
        targetEntityId: "ent-merge",
        type: "depends_on",
        weight: 0.6,
      });
      // Create a relationship from keep to other (same type as rel1 after repoint)
      const rel3 = createTestRelationship({
        id: "rel-3",
        sourceEntityId: "ent-keep",
        targetEntityId: "ent-other",
        type: "uses",
        weight: 0.9,
      });

      insertRelationship(t.db, rel1);
      insertRelationship(t.db, rel2);
      insertRelationship(t.db, rel3);

      // Perform merge
      mergeEntities(t.db, "ent-keep", "ent-merge");

      // Verify merged entity is deleted
      expect(getEntity(t.db, "ent-merge")).toBeNull();

      // Verify keep entity has combined data
      const kept = getEntity(t.db, "ent-keep")!;
      expect(kept.mentionCount).toBe(8); // 5 + 3
      expect(kept.firstSeen).toBe(500); // min
      expect(kept.lastSeen).toBe(3000); // max

      // Verify aliases: should have ts, typescript-lang, ts lang (merged name)
      const lowerAliases = kept.aliases.map((a) => a.toLowerCase());
      expect(lowerAliases).toContain("ts");
      expect(lowerAliases).toContain("typescript-lang");
      expect(lowerAliases).toContain("ts lang");
      // Should not contain "typescript" (the keep entity's own name)
      expect(lowerAliases).not.toContain("typescript");

      // Verify relationships repointed
      const relRows = t.db
        .prepare("SELECT * FROM relationships")
        .all() as Array<Record<string, unknown>>;

      // rel1 (merge->other, uses) should have been deduplicated with rel3 (keep->other, uses)
      // rel2 (other->merge, depends_on) should have been repointed to (other->keep, depends_on)
      // After dedup, we should have 2 relationships: uses (keep->other) and depends_on (other->keep)
      expect(relRows.length).toBe(2);

      // No relationships should reference the merged entity
      for (const row of relRows) {
        expect(row.source_entity_id).not.toBe("ent-merge");
        expect(row.target_entity_id).not.toBe("ent-merge");
      }

      // The surviving "uses" edge should have the higher weight (0.9 from rel3)
      const usesEdge = relRows.find((r) => r.type === "uses");
      expect(usesEdge).toBeDefined();
      expect(usesEdge!.weight).toBe(0.9);

      // Verify merged entity removed from vec_entities
      const vecResults = t.db
        .prepare(
          "SELECT id FROM vec_entities WHERE id = ?",
        )
        .all("ent-merge");
      expect(vecResults.length).toBe(0);
    });
  });

  describe("findNearestEntities", () => {
    it("returns neighbors sorted by distance", () => {
      const baseVec = randomEmbedding();
      const similarVec = baseVec.map((v) => v + (Math.random() - 0.5) * 0.01);
      const differentVec = randomEmbedding();

      const ent1 = createTestEntity({ id: "ent-near-1" });
      const ent2 = createTestEntity({ id: "ent-near-2" });
      const ent3 = createTestEntity({ id: "ent-near-3" });

      insertEntity(t.db, ent1, baseVec);
      insertEntity(t.db, ent2, similarVec);
      insertEntity(t.db, ent3, differentVec);

      const results = findNearestEntities(t.db, baseVec, 3);

      expect(results.length).toBeGreaterThanOrEqual(2);
      // First result should be the exact match
      expect(results[0].id).toBe("ent-near-1");
      expect(results[0].distance).toBeCloseTo(0, 2);
      // Results should be sorted by distance
      for (let i = 1; i < results.length; i++) {
        expect(results[i].distance).toBeGreaterThanOrEqual(
          results[i - 1].distance,
        );
      }
    });
  });

  describe("ftsSearchEntities", () => {
    it("returns empty array for non-matching query", () => {
      const entity = createTestEntity({
        id: "ent-fts-1",
        name: "TypeScript",
        description: "A typed superset of JavaScript",
      });
      insertEntity(t.db, entity, randomEmbedding());

      const results = ftsSearchEntities(t.db, "Kubernetes");
      expect(results).toEqual([]);
    });

    it("finds inserted entity by name", () => {
      const entity = createTestEntity({
        id: "ent-fts-2",
        name: "Kubernetes",
        description: "Container orchestration platform",
      });
      insertEntity(t.db, entity, randomEmbedding());

      const results = ftsSearchEntities(t.db, "kubernetes");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("ent-fts-2");
      expect(results[0].name).toBe("Kubernetes");
    });

    it("tolerates punctuation and FTS5 syntax characters in the query", () => {
      const entity = createTestEntity({
        id: "ent-fts-3",
        name: "C++",
        description: "Systems programming language",
      });
      insertEntity(t.db, entity, randomEmbedding());

      // Each of these is an FTS5 syntax error when passed raw
      expect(() => ftsSearchEntities(t.db, "what's the C++ build?")).not.toThrow();
      expect(() => ftsSearchEntities(t.db, "foo-bar (memory)")).not.toThrow();
      expect(() => ftsSearchEntities(t.db, '"unbalanced')).not.toThrow();
      expect(ftsSearchEntities(t.db, "   ")).toEqual([]);

      const results = ftsSearchEntities(t.db, "what's the systems language?");
      expect(results.map((e) => e.id)).toContain("ent-fts-3");
    });
  });
});
