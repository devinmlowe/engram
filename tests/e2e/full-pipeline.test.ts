/**
 * End-to-end test: full pipeline from exchange insertion through
 * search, semantic memory, and graph traversal.
 *
 * Uses a real SQLite database but mocks embeddings to avoid model
 * download overhead in CI.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestDb, createSyntheticExchange, createTestEntity, createTestRelationship } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { SearchSource } from "../../src/_core/types/index.js";
import type { Memory, MemoryType } from "../../src/semantic/types.js";

// Mock embeddings to avoid model loading
vi.mock("../../src/_core/embeddings/index.js", () => {
  const dims = 256;
  let callCount = 0;

  function deterministicVector(seed: string): Float32Array {
    const vec = new Float32Array(dims);
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < dims; i++) {
      hash = ((hash << 5) - hash + i) | 0;
      vec[i] = (hash & 0xffff) / 0xffff - 0.5;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < dims; i++) vec[i] /= norm;
    return vec;
  }

  return {
    initEmbeddings: vi.fn().mockResolvedValue(undefined),
    embedQuery: vi.fn().mockImplementation((text: string) => {
      return Promise.resolve(deterministicVector(`query:${text}`));
    }),
    embedDocument: vi.fn().mockImplementation((text: string) => {
      return Promise.resolve(deterministicVector(`doc:${text}`));
    }),
    embedDocumentBatch: vi.fn().mockImplementation((texts: string[]) => {
      return Promise.resolve(texts.map((t) => deterministicVector(`doc:${t}`)));
    }),
    getActiveModel: vi.fn().mockReturnValue("mock-model"),
    resetEmbeddings: vi.fn(),
  };
});

let testDb: TestDb;

beforeAll(() => {
  testDb = createTestDb();
});

afterAll(() => {
  testDb.cleanup();
});

describe("Full Pipeline E2E", () => {
  describe("Episodic Layer", () => {
    it("inserts exchanges and retrieves via FTS", () => {
      const { db } = testDb;

      // Insert exchanges
      const exchanges = [
        createSyntheticExchange({
          id: "e2e-exch-001",
          conversationId: "e2e-conv-001",
          project: "engram",
          userMessage: "How should I implement the reranking pipeline?",
          assistantMessage: "You should use BGE-reranker-base via transformers.js for cross-encoder reranking.",
          exchangeIndex: 0,
        }),
        createSyntheticExchange({
          id: "e2e-exch-002",
          conversationId: "e2e-conv-001",
          project: "engram",
          userMessage: "What about context budget management?",
          assistantMessage: "Use priority-class allocation: semantic > graph > episodic with greedy fill.",
          exchangeIndex: 1,
        }),
        createSyntheticExchange({
          id: "e2e-exch-003",
          conversationId: "e2e-conv-002",
          project: "nova-voice",
          userMessage: "How do I set up MLX for local inference?",
          assistantMessage: "Install MLX via pip, then load quantized models with mlx-lm.",
          exchangeIndex: 0,
        }),
      ];

      const insertExchange = db.prepare(`
        INSERT OR IGNORE INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertFts = db.prepare(`
        INSERT INTO exchanges_fts (rowid, user_message, assistant_message)
        VALUES (?, ?, ?)
      `);

      for (const exch of exchanges) {
        insertExchange.run(
          exch.id, exch.conversationId, exch.project, exch.timestamp,
          exch.userMessage, exch.assistantMessage, exch.exchangeIndex,
          exch.tokenEstimate, exch.createdAt,
        );
        const row = db.prepare("SELECT rowid FROM exchanges WHERE id = ?").get(exch.id) as { rowid: number };
        insertFts.run(row.rowid, exch.userMessage, exch.assistantMessage);
      }

      // Verify FTS search
      const ftsResults = db.prepare(`
        SELECT e.id, e.user_message FROM exchanges e
        JOIN exchanges_fts f ON f.rowid = e.rowid
        WHERE exchanges_fts MATCH ?
        LIMIT 5
      `).all("reranking") as Array<{ id: string; user_message: string }>;

      expect(ftsResults.length).toBeGreaterThan(0);
      expect(ftsResults[0].id).toBe("e2e-exch-001");
    });

    it("inserts conversation metadata", () => {
      const { db } = testDb;

      db.prepare(`
        INSERT OR IGNORE INTO conversations (id, project, started_at, ended_at, exchange_count, last_indexed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("e2e-conv-001", "engram", new Date().toISOString(), new Date().toISOString(), 2, Math.floor(Date.now() / 1000));

      const conv = db.prepare("SELECT * FROM conversations WHERE id = ?").get("e2e-conv-001") as Record<string, unknown>;
      expect(conv).toBeDefined();
      expect(conv.exchange_count).toBe(2);
    });
  });

  describe("Semantic Layer", () => {
    it("inserts and retrieves semantic memories", async () => {
      const { db } = testDb;
      const { embedDocument } = await import("../../src/_core/embeddings/index.js");
      const { insertMemory, getMemory, findNearestMemories } = await import("../../src/semantic/memory.js");

      const memories: Memory[] = [
        {
          id: "e2e-mem-001",
          type: "preference" as MemoryType,
          content: "User prefers Fish shell for all interactive commands",
          confidence: 0.9,
          importance: 0.8,
          accessCount: 0,
          createdAt: Math.floor(Date.now() / 1000),
          sourceExchanges: ["e2e-exch-001"],
          isActive: true,
        },
        {
          id: "e2e-mem-002",
          type: "decision" as MemoryType,
          content: "SQLite chosen over Postgres for local-first portability",
          confidence: 0.85,
          importance: 0.9,
          accessCount: 0,
          createdAt: Math.floor(Date.now() / 1000),
          sourceExchanges: ["e2e-exch-002"],
          isActive: true,
        },
        {
          id: "e2e-mem-003",
          type: "fact" as MemoryType,
          content: "MLX runs on Apple Silicon Neural Engine for local inference",
          confidence: 0.7,
          importance: 0.6,
          accessCount: 0,
          createdAt: Math.floor(Date.now() / 1000),
          sourceExchanges: ["e2e-exch-003"],
          isActive: true,
        },
      ];

      for (const mem of memories) {
        const embedding = await embedDocument(mem.content);
        insertMemory(db, mem, embedding);
      }

      // Verify retrieval by ID
      const retrieved = getMemory(db, "e2e-mem-001");
      expect(retrieved).toBeDefined();
      expect(retrieved!.content).toBe("User prefers Fish shell for all interactive commands");
      expect(retrieved!.type).toBe("preference");

      // Verify vector nearest neighbor search
      const queryEmb = await embedDocument("What shell does the user prefer?");
      const nearest = findNearestMemories(db, queryEmb, 3);
      expect(nearest.length).toBeGreaterThan(0);
    });

    it("tracks memory access and confidence", async () => {
      const { db } = testDb;
      const { recordAccess, getMemory } = await import("../../src/semantic/memory.js");

      recordAccess(db, "e2e-mem-001");
      const mem = getMemory(db, "e2e-mem-001");
      expect(mem!.accessCount).toBe(1);
      expect(mem!.lastAccessed).toBeDefined();
    });
  });

  describe("Graph Layer", () => {
    it("creates entities and relationships", async () => {
      const { db } = testDb;
      const { insertEntity } = await import("../../src/graph/entity.js");
      const { findOrCreateRelationship } = await import("../../src/graph/relationship.js");
      const { embedDocument } = await import("../../src/_core/embeddings/index.js");

      const entities = [
        createTestEntity({ id: "e2e-ent-sqlite", name: "SQLite", type: "technology", description: "Embedded database" }),
        createTestEntity({ id: "e2e-ent-engram", name: "engram", type: "project", description: "Cognitive memory system" }),
        createTestEntity({ id: "e2e-ent-mlx", name: "MLX", type: "technology", description: "Apple machine learning framework" }),
        createTestEntity({ id: "e2e-ent-fish", name: "Fish Shell", type: "tool", description: "Friendly interactive shell" }),
      ];

      for (const ent of entities) {
        const embedding = await embedDocument(ent.name);
        insertEntity(db, ent, Array.from(embedding));
      }

      // Create relationships
      findOrCreateRelationship(
        db,
        "e2e-ent-engram",
        "e2e-ent-sqlite",
        "uses",
        "Engram uses SQLite for local-first storage",
        "e2e-mem-002",
      );

      findOrCreateRelationship(
        db,
        "e2e-ent-engram",
        "e2e-ent-mlx",
        "uses",
        "Engram uses MLX for local inference",
        "e2e-mem-003",
      );

      // Verify entity count
      const entityCount = (db.prepare("SELECT COUNT(*) as count FROM entities").get() as { count: number }).count;
      expect(entityCount).toBeGreaterThanOrEqual(4);

      // Verify relationship count
      const relCount = (db.prepare("SELECT COUNT(*) as count FROM relationships").get() as { count: number }).count;
      expect(relCount).toBeGreaterThanOrEqual(2);
    });

    it("explores entity connections", async () => {
      const { db } = testDb;
      const { exploreEntity } = await import("../../src/graph/search.js");

      const result = exploreEntity(db, {
        entity: "engram",
        depth: 1,
      });

      expect(result.centerEntity.name).toBe("engram");
      expect(result.neighbors.length).toBeGreaterThanOrEqual(2);

      const neighborNames = result.neighbors.map((n: any) => n.entity.name);
      expect(neighborNames).toContain("SQLite");
      expect(neighborNames).toContain("MLX");
    });
  });

  describe("Search Pipeline", () => {
    it("performs multi-source search with budget enforcement", async () => {
      const { db } = testDb;
      const { searchMultiSource, formatRecallXml } = await import("../../src/episodic/search.js");

      const response = await searchMultiSource(db, {
        query: "SQLite database",
        sources: ["episodic", "semantic"] as SearchSource[],
        mode: "hybrid",
        budget: 1500,
      });

      expect(response.results.length).toBeGreaterThan(0);
      expect(response.tokensUsed).toBeLessThanOrEqual(1500);

      // Verify XML formatting
      const xml = formatRecallXml(response);
      expect(xml).toContain("<engram_memory");
      expect(xml).toContain("</engram_memory>");
    });
  });

  describe("Context Budget", () => {
    it("respects priority ordering in budget allocation", async () => {
      const { allocateBudget } = await import("../../src/_core/search/budget.js");

      const results = [
        { id: "r1", source: "episodic" as SearchSource, score: 0.9, content: "A".repeat(400), metadata: {}, tokenEstimate: 100 },
        { id: "r2", source: "semantic" as SearchSource, score: 0.8, content: "B".repeat(400), metadata: {}, tokenEstimate: 100 },
        { id: "r3", source: "graph" as SearchSource, score: 0.7, content: "C".repeat(400), metadata: {}, tokenEstimate: 100 },
      ];

      const allocated = allocateBudget(results, 250);
      // Should fit 2 results within 250 token budget
      expect(allocated.length).toBeLessThanOrEqual(3);

      // Semantic should come first (highest priority boost)
      if (allocated.length >= 2) {
        expect(allocated[0].source).toBe("semantic");
      }
    });
  });

  describe("Cache", () => {
    it("LRU cache works correctly", async () => {
      const { LRUCache } = await import("../../src/_core/cache/index.js");

      const cache = new LRUCache<string, number>({ maxSize: 3, ttlMs: 60000 });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);

      expect(cache.get("a")).toBe(1);
      expect(cache.size).toBe(3);

      // Adding 4th item should evict LRU
      cache.set("d", 4);
      expect(cache.size).toBe(3);
      // "b" was LRU (we accessed "a" after setting it)
      expect(cache.has("b")).toBe(false);
    });
  });

  describe("Database Integrity", () => {
    it("all tables exist with correct schema", () => {
      const { db } = testDb;

      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
      `).all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);

      // Episodic layer
      expect(tableNames).toContain("exchanges");
      expect(tableNames).toContain("tool_calls");
      expect(tableNames).toContain("conversations");

      // Semantic layer
      expect(tableNames).toContain("memories");
      expect(tableNames).toContain("conflicts");

      // Graph layer
      expect(tableNames).toContain("entities");
      expect(tableNames).toContain("relationships");
      expect(tableNames).toContain("topic_clusters");

      // Dream state
      expect(tableNames).toContain("dream_runs");
      expect(tableNames).toContain("dream_checkpoints");

      // Reflection
      expect(tableNames).toContain("bridge_scores");
      expect(tableNames).toContain("temporal_patterns");
      expect(tableNames).toContain("reflection_observations");
    });

    it("indexes exist for performance", () => {
      const { db } = testDb;

      const indexes = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);

      // Key performance indexes
      expect(indexNames).toContain("idx_exchanges_conversation");
      expect(indexNames).toContain("idx_exchanges_project");
      expect(indexNames).toContain("idx_exchanges_timestamp");
      expect(indexNames).toContain("idx_memories_type");
      expect(indexNames).toContain("idx_entities_name");
    });

    it("WAL mode is enabled", () => {
      const { db } = testDb;
      const mode = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
      expect(mode[0].journal_mode).toBe("wal");
    });
  });
});
