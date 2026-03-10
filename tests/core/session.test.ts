/**
 * Tests for the session store and drill capability.
 *
 * Phase 6B: Iterative recall — TDD tests written first.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SessionStore,
  getSessionStore,
  resetSessionStore,
} from "../../src/_core/search/session.js";
import { drillIntoResult } from "../../src/_core/search/drill.js";
import type { SearchResult } from "../../src/_core/types/index.js";
import { createTestDb, createSyntheticExchange, createTestEntity, createTestRelationship } from "../helpers.js";
import type { TestDb } from "../helpers.js";

// Mock embeddings (needed for any imports that reference embeddings)
vi.mock("../../src/_core/embeddings/index.js", () => ({
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  embedQuery: vi.fn().mockResolvedValue(new Float32Array(256)),
  embedDocument: vi.fn().mockResolvedValue(new Float32Array(256)),
  embedDocumentBatch: vi.fn().mockResolvedValue([]),
  getActiveModel: vi.fn().mockReturnValue("mock-model"),
  resetEmbeddings: vi.fn(),
}));

// ─── SessionStore Tests ─────────────────────────────────────────

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  it("creates session with unique ID", () => {
    const session = store.create("test query");
    expect(session.id).toBeDefined();
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(session.query).toBe("test query");
  });

  it("creates sessions with distinct IDs", () => {
    const s1 = store.create("query 1");
    const s2 = store.create("query 2");
    expect(s1.id).not.toBe(s2.id);
  });

  it("retrieves session by ID", () => {
    const created = store.create("find me");
    const retrieved = store.get(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.query).toBe("find me");
  });

  it("returns null for non-existent session", () => {
    const result = store.get("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("tracks refinements", () => {
    const session = store.create("initial query");
    store.addResults(session.id, [], "refined query 1");
    store.addResults(session.id, [], "refined query 2");

    const retrieved = store.get(session.id);
    expect(retrieved!.refinements).toEqual(["refined query 1", "refined query 2"]);
  });

  it("accumulates results across refinements", () => {
    const session = store.create("initial query");

    const result1: SearchResult = {
      id: "r1",
      source: "episodic",
      score: 0.9,
      content: "first result",
      metadata: {},
      tokenEstimate: 50,
    };
    const result2: SearchResult = {
      id: "r2",
      source: "semantic",
      score: 0.8,
      content: "second result",
      metadata: {},
      tokenEstimate: 30,
    };

    store.addResults(session.id, [result1]);
    store.addResults(session.id, [result2], "refined");

    const retrieved = store.get(session.id);
    expect(retrieved!.results).toHaveLength(2);
    expect(retrieved!.results[0].id).toBe("r1");
    expect(retrieved!.results[1].id).toBe("r2");
  });

  it("tracks budget usage", () => {
    const session = store.create("query", { maxBudget: 1000 });

    const results: SearchResult[] = [
      { id: "r1", source: "episodic", score: 0.9, content: "a", metadata: {}, tokenEstimate: 100 },
      { id: "r2", source: "episodic", score: 0.8, content: "b", metadata: {}, tokenEstimate: 200 },
    ];

    store.addResults(session.id, results);

    expect(store.getRemainingBudget(session.id)).toBe(700);
  });

  it("prevents exceeding max budget by reporting 0 remaining", () => {
    const session = store.create("query", { maxBudget: 100 });

    const results: SearchResult[] = [
      { id: "r1", source: "episodic", score: 0.9, content: "a", metadata: {}, tokenEstimate: 150 },
    ];

    store.addResults(session.id, results);

    // Budget has been exceeded, remaining should be 0 (clamped)
    expect(store.getRemainingBudget(session.id)).toBe(0);
  });

  it("evicts oldest session when at capacity (10)", () => {
    // Create 10 sessions, setting distinct timestamps to control LRU order
    const sessionIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const s = store.create(`query ${i}`);
      // Set lastAccessedAt to increasingly newer times
      s.lastAccessedAt = new Date(Date.now() - (10 - i) * 1000);
      sessionIds.push(s.id);
    }
    expect(store.size).toBe(10);

    // Session 0 has the oldest lastAccessedAt
    // Create an 11th — should evict sessionIds[0] (the oldest)
    store.create("query 10");
    expect(store.size).toBe(10);

    // Session 0 should have been evicted (oldest)
    expect(store.get(sessionIds[0])).toBeNull();

    // Session 1 should still exist
    expect(store.get(sessionIds[1])).not.toBeNull();
  });

  it("expires sessions after TTL (30 min)", () => {
    const session = store.create("query");

    // Manipulate lastAccessedAt to be 31 minutes ago
    session.lastAccessedAt = new Date(Date.now() - 31 * 60 * 1000);

    // Next get should trigger eviction
    const retrieved = store.get(session.id);
    expect(retrieved).toBeNull();
  });

  it("updates lastAccessedAt on access", () => {
    const session = store.create("query");
    const createdAt = session.lastAccessedAt.getTime();

    // Small delay to ensure time difference
    const before = Date.now();
    const retrieved = store.get(session.id);
    const after = Date.now();

    expect(retrieved!.lastAccessedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(retrieved!.lastAccessedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("close removes session", () => {
    const session = store.create("query");
    expect(store.get(session.id)).not.toBeNull();

    store.close(session.id);
    expect(store.get(session.id)).toBeNull();
  });

  it("marks results as expanded", () => {
    const session = store.create("query");
    const result: SearchResult = {
      id: "r1",
      source: "episodic",
      score: 0.9,
      content: "test",
      metadata: {},
      tokenEstimate: 50,
    };
    store.addResults(session.id, [result]);
    store.markExpanded(session.id, "r1");

    const retrieved = store.get(session.id);
    expect(retrieved!.expandedIds.has("r1")).toBe(true);
  });
});

// ─── Singleton Tests ────────────────────────────────────────────

describe("getSessionStore singleton", () => {
  afterEach(() => {
    resetSessionStore();
  });

  it("returns the same instance", () => {
    const store1 = getSessionStore();
    const store2 = getSessionStore();
    expect(store1).toBe(store2);
  });

  it("resetSessionStore creates a new instance", () => {
    const store1 = getSessionStore();
    store1.create("query");
    expect(store1.size).toBe(1);

    resetSessionStore();
    const store2 = getSessionStore();
    expect(store2.size).toBe(0);
    expect(store2).not.toBe(store1);
  });
});

// ─── drillIntoResult Tests ──────────────────────────────────────

describe("drillIntoResult", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    const { db } = testDb;

    // Seed episodic exchanges in a conversation
    for (let i = 0; i < 12; i++) {
      const exch = createSyntheticExchange({
        id: `drill-exch-${i.toString().padStart(3, "0")}`,
        conversationId: "drill-conv-001",
        project: "drill-project",
        userMessage: `User message ${i}`,
        assistantMessage: `Assistant response ${i}`,
        exchangeIndex: i,
      });

      db.prepare(`
        INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(exch.id, exch.conversationId, exch.project, exch.timestamp, exch.userMessage, exch.assistantMessage, exch.exchangeIndex, exch.tokenEstimate, exch.createdAt);
    }

    // Seed a semantic memory with source_exchanges
    db.prepare(`
      INSERT INTO memories (id, type, content, context, confidence, importance, access_count, created_at, source_exchanges, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "drill-mem-001",
      "fact",
      "SQLite uses WAL mode for concurrency",
      "Database configuration discussion",
      0.9,
      0.8,
      0,
      Math.floor(Date.now() / 1000),
      JSON.stringify(["drill-exch-003", "drill-exch-004"]),
      1,
    );

    // Seed graph entities and relationships
    const entity1 = createTestEntity({
      id: "drill-ent-001",
      name: "SQLite",
      type: "technology",
      description: "Lightweight embedded database",
    });
    const entity2 = createTestEntity({
      id: "drill-ent-002",
      name: "WAL",
      type: "concept",
      description: "Write-Ahead Logging",
    });

    db.prepare(`
      INSERT INTO entities (id, name, type, description, aliases, first_seen, last_seen, mention_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entity1.id, entity1.name, entity1.type, entity1.description, JSON.stringify(entity1.aliases), entity1.firstSeen, entity1.lastSeen, entity1.mentionCount, entity1.createdAt);

    db.prepare(`
      INSERT INTO entities (id, name, type, description, aliases, first_seen, last_seen, mention_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entity2.id, entity2.name, entity2.type, entity2.description, JSON.stringify(entity2.aliases), entity2.firstSeen, entity2.lastSeen, entity2.mentionCount, entity2.createdAt);

    const rel = createTestRelationship({
      id: "drill-rel-001",
      sourceEntityId: "drill-ent-001",
      targetEntityId: "drill-ent-002",
      type: "uses",
      weight: 0.9,
      context: "SQLite uses WAL mode",
    });

    db.prepare(`
      INSERT INTO relationships (id, source_entity_id, target_entity_id, type, weight, context, source_memories, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(rel.id, rel.sourceEntityId, rel.targetEntityId, rel.type, rel.weight, rel.context, JSON.stringify(rel.sourceMemories), rel.createdAt);
  });

  afterEach(() => {
    testDb.cleanup();
  });

  it("episodic: returns surrounding exchanges", async () => {
    const result: SearchResult = {
      id: "drill-exch-006",
      source: "episodic",
      score: 0.9,
      content: "User: User message 6\nAssistant: Assistant response 6",
      metadata: {
        conversationId: "drill-conv-001",
        project: "drill-project",
      },
      tokenEstimate: 50,
    };

    const drillResult = await drillIntoResult(result, testDb.db);

    // Should have 5 before (exchanges 1-5) and 5 after (exchanges 7-11)
    expect(drillResult.before.length).toBe(5);
    expect(drillResult.after.length).toBe(5);
    expect(drillResult.content).toContain("User message 6");
    expect(drillResult.content).toContain("Assistant response 6");
  });

  it("semantic: returns source conversation segment", async () => {
    const result: SearchResult = {
      id: "drill-mem-001",
      source: "semantic",
      score: 0.85,
      content: "SQLite uses WAL mode for concurrency",
      metadata: {
        type: "fact",
        confidence: 0.9,
        importance: 0.8,
      },
      tokenEstimate: 30,
    };

    const drillResult = await drillIntoResult(result, testDb.db);

    expect(drillResult.content).toContain("SQLite uses WAL mode for concurrency");
    expect(drillResult.content).toContain("Database configuration discussion");
    // Source exchanges should be in before context
    expect(drillResult.before.length).toBe(2);
  });

  it("graph: returns entity with relationships", async () => {
    const result: SearchResult = {
      id: "drill-ent-001",
      source: "graph",
      score: 0.95,
      content: "SQLite (technology): Lightweight embedded database",
      metadata: {
        entityName: "SQLite",
        entityType: "technology",
      },
      tokenEstimate: 40,
    };

    const drillResult = await drillIntoResult(result, testDb.db);

    expect(drillResult.content).toContain("SQLite");
    expect(drillResult.content).toContain("technology");
    expect(drillResult.relatedEntities.length).toBeGreaterThan(0);
    expect(drillResult.relatedEntities[0].name).toBe("WAL");
  });

  it("generates follow-up suggestions", async () => {
    const result: SearchResult = {
      id: "drill-exch-006",
      source: "episodic",
      score: 0.9,
      content: "test",
      metadata: {
        conversationId: "drill-conv-001",
        project: "drill-project",
      },
      tokenEstimate: 50,
    };

    const drillResult = await drillIntoResult(result, testDb.db);
    expect(drillResult.suggestions.length).toBeGreaterThan(0);
  });

  it("handles missing source gracefully", async () => {
    const result: SearchResult = {
      id: "nonexistent-id",
      source: "episodic",
      score: 0.9,
      content: "original content",
      metadata: {
        conversationId: "nonexistent-conv",
      },
      tokenEstimate: 50,
    };

    const drillResult = await drillIntoResult(result, testDb.db);

    // Should fall back to original content
    expect(drillResult.content).toBe("original content");
    expect(drillResult.before).toHaveLength(0);
    expect(drillResult.after).toHaveLength(0);
  });
});
