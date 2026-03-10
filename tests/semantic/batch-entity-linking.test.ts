/**
 * Tests for Phase 7C.1: RLM Findings Feedback Loop
 *
 * Tests entity linking in batch remember — linking stored memories
 * to existing graph entities via relates_to_entities.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import { getMemory } from "../../src/semantic/memory.js";

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

/**
 * Helper: insert a test entity directly via SQL (no embedding needed for linking tests).
 */
function insertTestEntity(
  name: string,
  type: string = "technology",
  mentionCount: number = 5,
): string {
  const id = `ent-${name.toLowerCase().replace(/\s+/g, "-")}`;
  t.db.prepare(`
    INSERT INTO entities (id, name, type, description, aliases, first_seen, last_seen, mention_count, created_at)
    VALUES (?, ?, ?, ?, '[]', unixepoch(), unixepoch(), ?, unixepoch())
  `).run(id, name, type, `${name} description`, mentionCount);
  return id;
}

/**
 * Helper: get entity mention_count.
 */
function getEntityMentionCount(id: string): number {
  const row = t.db.prepare("SELECT mention_count FROM entities WHERE id = ?").get(id) as { mention_count: number };
  return row.mention_count;
}

/**
 * Helper: get relationships between two entities.
 */
function getRelationship(sourceId: string, targetId: string, type: string = "related_to") {
  return t.db.prepare(
    "SELECT * FROM relationships WHERE source_entity_id = ? AND target_entity_id = ? AND type = ?",
  ).get(sourceId, targetId, type) as {
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    type: string;
    weight: number;
    source_memories: string | null;
  } | undefined;
}

// ─── Backward Compatibility ───────────────────────────────────────

describe("backward compatibility", () => {
  it("batch without relates_to_entities works exactly as before", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await storeMemoryBatch(t.db, [
      { content: "Fact without entity links", type: "fact" },
      { content: "Another unlinked fact", type: "decision" },
    ]);

    expect(result.total).toBe(2);
    expect(result.created).toBe(2);
    expect(result.deduplicated).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.entitiesLinked).toBe(0);
    expect(result.details).toHaveLength(2);
    expect(result.details.every((d) => d.status === "created")).toBe(true);
  });

  it("empty batch returns entitiesLinked: 0", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await storeMemoryBatch(t.db, []);

    expect(result.entitiesLinked).toBe(0);
  });
});

// ─── Entity Linking ───────────────────────────────────────────────

describe("entity linking via relates_to_entities", () => {
  it("links memory to existing entities and bumps mention_count", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const tsId = insertTestEntity("TypeScript");
    const sqliteId = insertTestEntity("SQLite");

    const initialTsMentions = getEntityMentionCount(tsId);
    const initialSqliteMentions = getEntityMentionCount(sqliteId);

    const result = await storeMemoryBatch(t.db, [
      {
        content: "TypeScript works well with SQLite via better-sqlite3",
        type: "fact",
        relates_to_entities: ["TypeScript", "SQLite"],
      },
    ]);

    expect(result.created).toBe(1);
    expect(result.entitiesLinked).toBe(2);

    // Mention counts bumped
    expect(getEntityMentionCount(tsId)).toBe(initialTsMentions + 1);
    expect(getEntityMentionCount(sqliteId)).toBe(initialSqliteMentions + 1);
  });

  it("creates pairwise relationships between linked entities", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const tsId = insertTestEntity("TypeScript");
    const sqliteId = insertTestEntity("SQLite");

    const result = await storeMemoryBatch(t.db, [
      {
        content: "TypeScript and SQLite integration pattern",
        type: "pattern",
        relates_to_entities: ["TypeScript", "SQLite"],
      },
    ]);

    expect(result.entitiesLinked).toBe(2);

    // Check relationship was created (order: alphabetical by entity ID)
    const rel = getRelationship(tsId, sqliteId) ?? getRelationship(sqliteId, tsId);
    expect(rel).toBeDefined();
    expect(rel!.type).toBe("related_to");
    expect(rel!.weight).toBe(1.0);

    // source_memories should contain the memory ID
    const memoryId = result.details[0].id!;
    const sourceMemories = JSON.parse(rel!.source_memories!);
    expect(sourceMemories).toContain(memoryId);
  });

  it("skips nonexistent entity names gracefully", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    insertTestEntity("TypeScript");

    const result = await storeMemoryBatch(t.db, [
      {
        content: "Something about TypeScript and NonexistentTool",
        type: "fact",
        relates_to_entities: ["TypeScript", "NonexistentTool"],
      },
    ]);

    expect(result.created).toBe(1);
    expect(result.entitiesLinked).toBe(1); // Only TypeScript found
    expect(result.errors).toBe(0); // No errors from missing entity
  });

  it("handles single entity in relates_to_entities (no pairwise relationships)", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const tsId = insertTestEntity("TypeScript");
    const initialMentions = getEntityMentionCount(tsId);

    const result = await storeMemoryBatch(t.db, [
      {
        content: "TypeScript is great for large codebases",
        type: "fact",
        relates_to_entities: ["TypeScript"],
      },
    ]);

    expect(result.entitiesLinked).toBe(1);
    expect(getEntityMentionCount(tsId)).toBe(initialMentions + 1);

    // No relationships created (need >= 2 entities for pairwise)
    const rels = t.db.prepare(
      "SELECT COUNT(*) as count FROM relationships",
    ).get() as { count: number };
    expect(rels.count).toBe(0);
  });

  it("handles mixed memories — some with entities, some without", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const tsId = insertTestEntity("TypeScript");
    const sqliteId = insertTestEntity("SQLite");
    const initialTsMentions = getEntityMentionCount(tsId);

    const result = await storeMemoryBatch(t.db, [
      { content: "Plain fact with no entity links", type: "fact" },
      {
        content: "TypeScript and SQLite work together",
        type: "fact",
        relates_to_entities: ["TypeScript", "SQLite"],
      },
      { content: "Another plain fact", type: "decision" },
    ]);

    expect(result.total).toBe(3);
    expect(result.created).toBe(3);
    expect(result.entitiesLinked).toBe(2); // Only from the second memory
    expect(getEntityMentionCount(tsId)).toBe(initialTsMentions + 1);
  });

  it("case-insensitive entity name matching", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const tsId = insertTestEntity("TypeScript");
    const initialMentions = getEntityMentionCount(tsId);

    const result = await storeMemoryBatch(t.db, [
      {
        content: "typescript is case insensitive",
        type: "fact",
        relates_to_entities: ["typescript"], // lowercase
      },
    ]);

    expect(result.entitiesLinked).toBe(1);
    expect(getEntityMentionCount(tsId)).toBe(initialMentions + 1);
  });

  it("updates existing relationship weight and source_memories on repeated linking", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const tsId = insertTestEntity("TypeScript");
    const sqliteId = insertTestEntity("SQLite");

    // First batch — creates relationship
    const result1 = await storeMemoryBatch(t.db, [
      {
        content: "First fact about TypeScript and SQLite",
        type: "fact",
        relates_to_entities: ["TypeScript", "SQLite"],
      },
    ]);

    const memoryId1 = result1.details[0].id!;

    // Second batch — should update existing relationship
    const result2 = await storeMemoryBatch(t.db, [
      {
        content: "Second fact about TypeScript and SQLite",
        type: "fact",
        relates_to_entities: ["TypeScript", "SQLite"],
      },
    ]);

    const memoryId2 = result2.details[0].id!;

    // Find the relationship
    const rel = getRelationship(tsId, sqliteId) ?? getRelationship(sqliteId, tsId);
    expect(rel).toBeDefined();
    expect(rel!.weight).toBe(1.5); // 1.0 initial + 0.5 bump

    const sourceMemories = JSON.parse(rel!.source_memories!);
    expect(sourceMemories).toContain(memoryId1);
    expect(sourceMemories).toContain(memoryId2);
  });

  it("creates pairwise relationships for 3 entities", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const tsId = insertTestEntity("TypeScript");
    const sqliteId = insertTestEntity("SQLite");
    const nodeId = insertTestEntity("Node.js");

    const result = await storeMemoryBatch(t.db, [
      {
        content: "TypeScript, SQLite, and Node.js work together",
        type: "fact",
        relates_to_entities: ["TypeScript", "SQLite", "Node.js"],
      },
    ]);

    expect(result.entitiesLinked).toBe(3);

    // Should have 3 pairwise relationships (3 choose 2)
    const rels = t.db.prepare(
      "SELECT COUNT(*) as count FROM relationships WHERE type = 'related_to'",
    ).get() as { count: number };
    expect(rels.count).toBe(3);
  });

  it("limits relates_to_entities to 10 names", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    // Create 12 entities
    for (let i = 0; i < 12; i++) {
      insertTestEntity(`Entity${i}`, "concept");
    }

    const result = await storeMemoryBatch(t.db, [
      {
        content: "Memory linking to many entities",
        type: "fact",
        relates_to_entities: Array.from({ length: 12 }, (_, i) => `Entity${i}`),
      },
    ]);

    // Only first 10 should be linked
    expect(result.entitiesLinked).toBeLessThanOrEqual(10);
  });

  it("does not link entities for deduplicated memories", async () => {
    const { storeMemoryBatch } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const tsId = insertTestEntity("TypeScript");
    const initialMentions = getEntityMentionCount(tsId);

    // First batch creates the memory
    await storeMemoryBatch(t.db, [
      { content: "Duplicate content for entity linking test", type: "fact" },
    ]);

    // Second batch with same content should deduplicate — no entity linking
    const result = await storeMemoryBatch(t.db, [
      {
        content: "Duplicate content for entity linking test",
        type: "fact",
        relates_to_entities: ["TypeScript"],
      },
    ]);

    expect(result.deduplicated).toBe(1);
    expect(result.entitiesLinked).toBe(0);
    expect(getEntityMentionCount(tsId)).toBe(initialMentions);
  });
});
