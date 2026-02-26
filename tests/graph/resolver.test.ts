import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveEntity, resolveEntities } from "../../src/graph/resolver.js";
import {
  insertEntity,
  getEntity,
  getEntityByName,
} from "../../src/graph/entity.js";
import { createTestDb, createTestEntity } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { ExtractedEntity } from "../../src/graph/types.js";

// Mock embeddings module — resolver calls embedDocument for stage 3+4.
// Return a deterministic but unique vector based on input text hash,
// so different entity names produce different embeddings.
vi.mock("../../src/episodic/embeddings.js", () => ({
  embedDocument: vi.fn().mockImplementation(async (text: string) => {
    // Simple hash-based vector: each char code contributes to different dims
    const vec = new Array(256).fill(0);
    for (let i = 0; i < text.length; i++) {
      const idx = i % 256;
      vec[idx] += text.charCodeAt(i) / 1000;
    }
    // L2 normalize
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return vec.map((v: number) => v / norm);
  }),
}));

let t: TestDb;

function randomEmbedding(dims = 256): number[] {
  return Array.from({ length: dims }, () => Math.random() * 2 - 1);
}

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

describe("Entity Resolver", () => {
  describe("Stage 1: Exact Name Match", () => {
    it("returns merge with stage exact_name for existing entity", async () => {
      const entity = createTestEntity({
        id: "ent-ts",
        name: "TypeScript",
        type: "technology",
      });
      insertEntity(t.db, entity, randomEmbedding());

      const extracted: ExtractedEntity = {
        name: "TypeScript",
        type: "technology",
      };

      const result = await resolveEntity(t.db, extracted);

      expect(result.action).toBe("merge");
      expect(result.entityId).toBe("ent-ts");
      expect(result.stage).toBe("exact_name");
    });

    it("matches case-insensitively", async () => {
      const entity = createTestEntity({
        id: "ent-ts",
        name: "TypeScript",
        type: "technology",
      });
      insertEntity(t.db, entity, randomEmbedding());

      const extracted: ExtractedEntity = {
        name: "typescript",
        type: "technology",
      };

      const result = await resolveEntity(t.db, extracted);

      expect(result.action).toBe("merge");
      expect(result.entityId).toBe("ent-ts");
      expect(result.stage).toBe("exact_name");
    });

    it("increments mention_count on merge", async () => {
      const entity = createTestEntity({
        id: "ent-ts",
        name: "TypeScript",
        type: "technology",
        mentionCount: 3,
      });
      insertEntity(t.db, entity, randomEmbedding());

      const extracted: ExtractedEntity = {
        name: "TypeScript",
        type: "technology",
      };

      await resolveEntity(t.db, extracted);

      const updated = getEntity(t.db, "ent-ts");
      expect(updated!.mentionCount).toBe(4);
    });
  });

  describe("Stage 2: Alias Match", () => {
    it("returns merge with stage alias when matching alias", async () => {
      const entity = createTestEntity({
        id: "ent-ts",
        name: "TypeScript",
        type: "technology",
        aliases: ["ts", "TS"],
      });
      insertEntity(t.db, entity, randomEmbedding());

      const extracted: ExtractedEntity = {
        name: "ts",
        type: "technology",
      };

      const result = await resolveEntity(t.db, extracted);

      expect(result.action).toBe("merge");
      expect(result.entityId).toBe("ent-ts");
      expect(result.stage).toBe("alias");
    });

    it("increments mention_count on alias merge", async () => {
      const entity = createTestEntity({
        id: "ent-ts",
        name: "TypeScript",
        type: "technology",
        aliases: ["ts"],
        mentionCount: 2,
      });
      insertEntity(t.db, entity, randomEmbedding());

      const extracted: ExtractedEntity = {
        name: "ts",
        type: "technology",
      };

      await resolveEntity(t.db, extracted);

      const updated = getEntity(t.db, "ent-ts");
      expect(updated!.mentionCount).toBe(3);
    });
  });

  describe("Stage 4: Create New", () => {
    it("creates new entity when no match found", async () => {
      const extracted: ExtractedEntity = {
        name: "Rust",
        type: "technology",
        description: "A systems programming language",
      };

      const result = await resolveEntity(t.db, extracted);

      expect(result.action).toBe("create");
      expect(result.stage).toBe("created");
      expect(result.entityId).toBeTruthy();
    });

    it("inserts entity into database on create", async () => {
      const extracted: ExtractedEntity = {
        name: "Kubernetes",
        type: "tool",
        description: "Container orchestration",
      };

      const result = await resolveEntity(t.db, extracted);

      const entity = getEntity(t.db, result.entityId);
      expect(entity).not.toBeNull();
      expect(entity!.name).toBe("Kubernetes");
      expect(entity!.type).toBe("tool");
      expect(entity!.description).toBe("Container orchestration");
      expect(entity!.mentionCount).toBe(1);
    });
  });

  describe("resolveEntities (batch)", () => {
    it("handles within-batch dedup via sequential resolution", async () => {
      // First entity should be created
      // Second entity with same name should merge with first
      const extractedEntities: ExtractedEntity[] = [
        { name: "Docker", type: "tool", description: "Container runtime" },
        { name: "Docker", type: "tool", description: "Container platform" },
      ];

      const results = await resolveEntities(t.db, extractedEntities);

      expect(results).toHaveLength(2);

      // First should be created
      expect(results[0].resolution.action).toBe("create");
      expect(results[0].resolution.stage).toBe("created");

      // Second should merge with the first (exact name match)
      expect(results[1].resolution.action).toBe("merge");
      expect(results[1].resolution.stage).toBe("exact_name");
      expect(results[1].resolution.entityId).toBe(
        results[0].resolution.entityId,
      );
    });

    it("resolves multiple distinct entities", async () => {
      const extractedEntities: ExtractedEntity[] = [
        { name: "React", type: "technology" },
        { name: "Vue", type: "technology" },
        { name: "Angular", type: "technology" },
      ];

      const results = await resolveEntities(t.db, extractedEntities);

      expect(results).toHaveLength(3);

      // All should be created (distinct names)
      for (const r of results) {
        expect(r.resolution.action).toBe("create");
        expect(r.resolution.stage).toBe("created");
      }

      // Each should have a unique entity ID
      const ids = results.map((r) => r.resolution.entityId);
      expect(new Set(ids).size).toBe(3);
    });

    it("merges with pre-existing entity", async () => {
      // Insert an existing entity
      const existing = createTestEntity({
        id: "ent-existing",
        name: "SQLite",
        type: "technology",
      });
      insertEntity(t.db, existing, randomEmbedding());

      const extractedEntities: ExtractedEntity[] = [
        { name: "SQLite", type: "technology" },
        { name: "PostgreSQL", type: "technology" },
      ];

      const results = await resolveEntities(t.db, extractedEntities);

      expect(results).toHaveLength(2);

      // First should merge with existing
      expect(results[0].resolution.action).toBe("merge");
      expect(results[0].resolution.entityId).toBe("ent-existing");

      // Second should be created
      expect(results[1].resolution.action).toBe("create");
    });
  });
});
