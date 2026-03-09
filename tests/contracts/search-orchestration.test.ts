/**
 * Contract: Search Orchestration
 *
 * searchMultiSource() is the primary recall entry point — used by MCP recall
 * and (after fix) CLI search. When it moves from episodic/search.ts to
 * _core/search/, the exact same behavior must be preserved:
 *
 * - Source selection (episodic, semantic, graph)
 * - Cross-source RRF fusion with semantic boost
 * - Token budget enforcement with priority allocation
 * - XML output formatting
 *
 * These tests use a real DB with seeded data to catch any regression in the
 * full pipeline. No mocked embeddings — we need to verify the actual search
 * path because mocked deterministic embeddings hide real similarity failures.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  searchMultiSource,
  searchEpisodic,
  formatRecallXml,
  escapeXml,
} from "../../src/episodic/search.js";
import { initEmbeddings, resetEmbeddings, embedDocument } from "../../src/_core/embeddings/index.js";
import { createTestDb, type TestDb } from "../helpers.js";
import type { RecallResponse, SearchSource } from "../../src/_core/types/index.js";

describe("Search Orchestration Contract", { timeout: 120_000 }, () => {
  let t: TestDb;

  beforeAll(async () => {
    await initEmbeddings();
    t = createTestDb();

    // Seed episodic data — 5 exchanges with distinct topics
    const exchanges = [
      { id: "ex-fish", topic: "fish shell", user: "How do I configure fish shell?", assistant: "Fish uses config.fish for configuration. Set variables with set -Ux." },
      { id: "ex-git", topic: "git worktrees", user: "How do git worktrees work?", assistant: "Git worktrees let you check out multiple branches simultaneously in separate directories." },
      { id: "ex-sqlite", topic: "sqlite performance", user: "How do I optimize SQLite queries?", assistant: "Use WAL mode, create indexes, and use prepared statements for repeated queries." },
      { id: "ex-react", topic: "react hooks", user: "Explain React useEffect hook", assistant: "useEffect runs side effects after render. It takes a callback and dependency array." },
      { id: "ex-docker", topic: "docker compose", user: "How do I use docker compose?", assistant: "Docker compose defines multi-container applications. Use docker-compose.yml to configure services." },
    ];

    const insertExchange = t.db.prepare(`
      INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertVec = t.db.prepare(`
      INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)
    `);

    for (let i = 0; i < exchanges.length; i++) {
      const ex = exchanges[i];
      insertExchange.run(
        ex.id, "conv-001", "test-project",
        `2025-01-0${i + 1}T10:00:00Z`,
        ex.user, ex.assistant,
        i, 50, Math.floor(Date.now() / 1000),
      );

      const embedding = await embedDocument(`${ex.user} ${ex.assistant}`);
      const buf = Buffer.from(new Float32Array(embedding).buffer);
      insertVec.run(ex.id, buf);
    }
  });

  afterAll(() => {
    t.cleanup();
  });

  // ── Source Selection ───────────────────────────────────────────

  it("episodic-only search returns only episodic results", async () => {
    const result = await searchMultiSource(t.db, {
      query: "fish shell configuration",
      sources: ["episodic"] as SearchSource[],
      limit: 5,
      budget: 1000,
    });

    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) {
      expect(r.source).toBe("episodic");
    }
  });

  it("default sources include episodic and semantic", async () => {
    const result = await searchMultiSource(t.db, {
      query: "fish shell",
      limit: 5,
      budget: 1000,
    });

    // Even if semantic has no data, episodic should have results
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.query).toBe("fish shell");
  });

  // ── Semantic Relevance ─────────────────────────────────────────

  it("returns semantically relevant results first", async () => {
    const result = await searchEpisodic(t.db, {
      query: "SQLite database optimization",
      limit: 5,
      budget: 1000,
    });

    // The SQLite exchange should score highest
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].id).toBe("ex-sqlite");
  });

  it("unrelated query still returns results (no empty for valid DB)", async () => {
    const result = await searchEpisodic(t.db, {
      query: "quantum physics",
      limit: 5,
      budget: 1000,
    });

    // Should still return results — just lower scores
    expect(result.results.length).toBeGreaterThan(0);
  });

  // ── Token Budget ───────────────────────────────────────────────

  it("respects token budget — total never exceeds requested", async () => {
    const result = await searchMultiSource(t.db, {
      query: "programming",
      sources: ["episodic"] as SearchSource[],
      limit: 100,  // request many
      budget: 100, // but tiny budget
    });

    expect(result.tokensUsed).toBeLessThanOrEqual(100);
  });

  it("tokensUsed matches sum of result token estimates", async () => {
    const result = await searchMultiSource(t.db, {
      query: "git",
      sources: ["episodic"] as SearchSource[],
      limit: 5,
      budget: 1000,
    });

    const calculatedTokens = result.results.reduce(
      (sum, r) => sum + r.tokenEstimate,
      0,
    );
    expect(result.tokensUsed).toBe(calculatedTokens);
  });

  // ── RecallResponse Shape ───────────────────────────────────────

  it("RecallResponse has all required fields", async () => {
    const result = await searchMultiSource(t.db, {
      query: "docker",
      sources: ["episodic"] as SearchSource[],
      limit: 3,
      budget: 500,
    });

    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("tokensUsed");
    expect(result).toHaveProperty("totalResults");
    expect(result).toHaveProperty("query");
    expect(result.query).toBe("docker");
    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.tokensUsed).toBe("number");
    expect(typeof result.totalResults).toBe("number");
  });

  it("each SearchResult has required fields with correct types", async () => {
    const result = await searchMultiSource(t.db, {
      query: "react hooks",
      sources: ["episodic"] as SearchSource[],
      limit: 3,
      budget: 500,
    });

    for (const r of result.results) {
      expect(typeof r.id).toBe("string");
      expect(r.id.length).toBeGreaterThan(0);
      expect(["episodic", "semantic", "graph"]).toContain(r.source);
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(typeof r.content).toBe("string");
      expect(r.content.length).toBeGreaterThan(0);
      expect(typeof r.tokenEstimate).toBe("number");
      expect(r.tokenEstimate).toBeGreaterThan(0);
      expect(typeof r.metadata).toBe("object");
    }
  });

  // ── XML Formatting ─────────────────────────────────────────────

  it("formatRecallXml wraps results in engram_memory tags", async () => {
    const result = await searchMultiSource(t.db, {
      query: "fish",
      sources: ["episodic"] as SearchSource[],
      limit: 2,
      budget: 500,
    });

    const xml = formatRecallXml(result);

    expect(xml).toMatch(/^<engram_memory /);
    expect(xml).toMatch(/<\/engram_memory>$/);
    expect(xml).toContain('query="fish"');
    expect(xml).toContain("tokens_used=");
    expect(xml).toContain("total_results=");
  });

  it("escapeXml handles all special characters", () => {
    expect(escapeXml('&<>"')).toBe("&amp;&lt;&gt;&quot;");
    expect(escapeXml("normal text")).toBe("normal text");
    expect(escapeXml("")).toBe("");
  });

  it("formatRecallXml handles empty results", () => {
    const empty: RecallResponse = {
      results: [],
      tokensUsed: 0,
      totalResults: 0,
      query: "nothing",
    };

    const xml = formatRecallXml(empty);
    expect(xml).toContain('query="nothing"');
    expect(xml).toContain('tokens_used="0"');
    expect(xml).toContain('total_results="0"');
  });

  // ── Score Properties ───────────────────────────────────────────

  it("scores are normalized to [0, 1] range", async () => {
    const result = await searchEpisodic(t.db, {
      query: "programming tools",
      limit: 5,
      budget: 1000,
    });

    for (const r of result.results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1.0);
    }
  });

  it("results are sorted by score descending", async () => {
    const result = await searchEpisodic(t.db, {
      query: "shell scripting",
      limit: 5,
      budget: 1000,
    });

    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i - 1].score).toBeGreaterThanOrEqual(
        result.results[i].score,
      );
    }
  });
});
