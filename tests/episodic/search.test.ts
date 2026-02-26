import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import {
  rrfFuse,
  budgetResults,
  formatRecallXml,
  searchEpisodic,
} from "../../src/episodic/search.js";
import { insertExchange } from "../../src/episodic/store.js";
import { initEmbeddings, embedExchange } from "../../src/episodic/embeddings.js";
import { createTestDb, createSyntheticExchange } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { SearchResult, RecallResponse } from "../../src/core/types.js";

// ─── Unit Tests (no DB) ───────────────────────────────────────

describe("rrfFuse", () => {
  it("merges two ranked lists with RRF scoring", () => {
    const vector = [
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
      { id: "c", rank: 3 },
    ];
    const fts = [
      { id: "b", rank: 1 },
      { id: "d", rank: 2 },
      { id: "a", rank: 3 },
    ];

    const result = rrfFuse(vector, fts, 60);

    // "b" appears rank 2 in vector + rank 1 in FTS → highest combined score
    // "a" appears rank 1 in vector + rank 3 in FTS → second
    expect(result[0].id).toBe("b");
    expect(result[1].id).toBe("a");
    // All 4 items should be present
    expect(result).toHaveLength(4);
  });

  it("handles items appearing in only one list", () => {
    const vector = [{ id: "x", rank: 1 }];
    const fts = [{ id: "y", rank: 1 }];

    const result = rrfFuse(vector, fts);
    expect(result).toHaveLength(2);
    // Both should have equal scores (same rank, one list each)
    expect(result[0].score).toEqual(result[1].score);
  });

  it("handles empty inputs", () => {
    expect(rrfFuse([], [])).toEqual([]);
    expect(rrfFuse([{ id: "a", rank: 1 }], [])).toHaveLength(1);
    expect(rrfFuse([], [{ id: "b", rank: 1 }])).toHaveLength(1);
  });
});

describe("budgetResults", () => {
  const makeResult = (id: string, tokens: number): SearchResult => ({
    id,
    source: "episodic",
    score: 0.9,
    content: "test",
    metadata: {},
    tokenEstimate: tokens,
  });

  it("fills within budget greedily", () => {
    const results = [
      makeResult("a", 100),
      makeResult("b", 200),
      makeResult("c", 300),
      makeResult("d", 500),
    ];

    const budgeted = budgetResults(results, 400);
    expect(budgeted.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("skips items that exceed remaining budget", () => {
    const results = [
      makeResult("a", 100),
      makeResult("b", 900), // too big
      makeResult("c", 200),
    ];

    const budgeted = budgetResults(results, 350);
    expect(budgeted.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("returns empty for zero budget", () => {
    const results = [makeResult("a", 100)];
    expect(budgetResults(results, 0)).toEqual([]);
  });

  it("returns all if budget is generous", () => {
    const results = [makeResult("a", 100), makeResult("b", 100)];
    const budgeted = budgetResults(results, 10000);
    expect(budgeted).toHaveLength(2);
  });
});

describe("formatRecallXml", () => {
  it("formats results as XML", () => {
    const response: RecallResponse = {
      query: "SQLite WAL",
      results: [
        {
          id: "e1",
          source: "episodic",
          score: 0.85,
          content: "User asked about WAL mode",
          metadata: { project: "engram", date: "2026-02-26" },
          tokenEstimate: 50,
        },
      ],
      tokensUsed: 50,
      totalResults: 1,
    };

    const xml = formatRecallXml(response);
    expect(xml).toContain('<engram_memory query="SQLite WAL"');
    expect(xml).toContain('tokens_used="50"');
    expect(xml).toContain('total_results="1"');
    expect(xml).toContain('project="engram"');
    expect(xml).toContain('relevance="85%"');
    expect(xml).toContain("User asked about WAL mode");
    expect(xml).toContain("</engram_memory>");
  });

  it("escapes XML special characters", () => {
    const response: RecallResponse = {
      query: 'test <script> & "quotes"',
      results: [],
      tokensUsed: 0,
      totalResults: 0,
    };

    const xml = formatRecallXml(response);
    expect(xml).toContain("&lt;script&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;quotes&quot;");
  });
});

// ─── Integration Tests (with DB + embeddings) ──────────────────

describe("searchEpisodic (integration)", () => {
  let t: TestDb;

  beforeAll(async () => {
    await initEmbeddings();
  }, 120_000);

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  async function seedExchange(
    id: string,
    userMsg: string,
    assistantMsg: string,
    project: string = "test",
    timestamp: string = "2026-02-26T10:00:00Z",
  ) {
    const exchange = createSyntheticExchange({
      id,
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      project,
      timestamp,
      tokenEstimate: Math.ceil((userMsg.length + assistantMsg.length) / 4),
    });

    const embedding = await embedExchange(userMsg, assistantMsg, {
      project,
      date: timestamp.split("T")[0],
    });

    insertExchange(t.db, exchange, embedding, []);
  }

  it("finds semantically relevant results", async () => {
    await seedExchange("e1", "How does WAL mode work in SQLite?", "WAL is write-ahead logging...");
    await seedExchange("e2", "What is the best chocolate cake recipe?", "Here is a chocolate cake recipe...");
    await seedExchange("e3", "Explain database journaling", "Database journaling ensures consistency...");

    const response = await searchEpisodic(t.db, {
      query: "SQLite write-ahead log",
      mode: "hybrid",
      limit: 10,
      budget: 5000,
    });

    expect(response.results.length).toBeGreaterThan(0);
    // The SQLite/database results should rank higher than cake recipe
    const ids = response.results.map((r) => r.id);
    const sqliteIdx = ids.indexOf("e1");
    const cakeIdx = ids.indexOf("e2");

    if (sqliteIdx !== -1 && cakeIdx !== -1) {
      expect(sqliteIdx).toBeLessThan(cakeIdx);
    }
  });

  it("supports text-only search mode", async () => {
    await seedExchange("e1", "FTS5 full-text search", "FTS5 provides fast search...");
    await seedExchange("e2", "Vector embeddings", "Vectors represent meaning...");

    const response = await searchEpisodic(t.db, {
      query: "FTS5",
      mode: "text",
      limit: 10,
      budget: 5000,
    });

    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0].id).toBe("e1");
  });

  it("supports vector-only search mode", async () => {
    await seedExchange("e1", "Machine learning model training", "Training involves optimization...");
    await seedExchange("e2", "Grocery shopping list", "Milk, eggs, bread...");

    const response = await searchEpisodic(t.db, {
      query: "deep learning neural networks",
      mode: "vector",
      limit: 10,
      budget: 5000,
    });

    expect(response.results.length).toBeGreaterThan(0);
    // ML-related should rank first
    expect(response.results[0].id).toBe("e1");
  });

  it("filters by date range", async () => {
    await seedExchange("old", "Old question", "Old answer", "test", "2025-01-01T10:00:00Z");
    await seedExchange("new", "New question", "New answer", "test", "2026-02-20T10:00:00Z");

    const response = await searchEpisodic(t.db, {
      query: "question answer",
      mode: "hybrid",
      limit: 10,
      budget: 5000,
      after: "2026-01-01",
    });

    const ids = response.results.map((r) => r.id);
    expect(ids).toContain("new");
    expect(ids).not.toContain("old");
  });

  it("respects token budget", async () => {
    // Insert exchanges with known token estimates
    for (let i = 0; i < 5; i++) {
      const msg = "A".repeat(400); // ~100 tokens each
      await seedExchange(`e${i}`, `Question ${i}: ${msg}`, `Answer ${i}: ${msg}`);
    }

    const response = await searchEpisodic(t.db, {
      query: "Question Answer",
      mode: "text",
      limit: 10,
      budget: 250, // Only room for ~1 exchange
    });

    expect(response.tokensUsed).toBeLessThanOrEqual(250);
  });

  it("returns empty results for no matches", async () => {
    const response = await searchEpisodic(t.db, {
      query: "xyzzy nonexistent gibberish",
      mode: "text",
      limit: 10,
      budget: 5000,
    });

    expect(response.results).toHaveLength(0);
  });
});
