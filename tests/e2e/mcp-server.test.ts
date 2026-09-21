/**
 * End-to-end MCP server test: verifies tool definitions and
 * handler behavior without spawning a real stdio process.
 *
 * Tests the server's request handlers directly by simulating
 * MCP protocol requests.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestDb, createSyntheticExchange, createTestEntity } from "../helpers.js";
import type { TestDb } from "../helpers.js";

// Mock embeddings
vi.mock("../../src/_core/embeddings/index.js", async () =>
  (await import("../mocks/embeddings.js")).deterministicEmbeddings(),
);

// Mock config to use test database (pass through to real loadConfig so createTestDb works)
vi.mock("../../src/_core/config/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/_core/config/index.js")>("../../src/_core/config/index.js");
  return {
    ...actual,
    loadConfig: vi.fn().mockImplementation(actual.loadConfig),
  };
});

let testDb: TestDb;

beforeAll(() => {
  testDb = createTestDb();

  // Seed test data
  const { db } = testDb;

  // Insert an exchange
  const exch = createSyntheticExchange({
    id: "mcp-exch-001",
    conversationId: "mcp-conv-001",
    project: "test-project",
    userMessage: "What database should I use for local storage?",
    assistantMessage: "SQLite is excellent for local-first applications. It supports WAL mode for concurrent reads.",
    exchangeIndex: 0,
  });

  db.prepare(`
    INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(exch.id, exch.conversationId, exch.project, exch.timestamp, exch.userMessage, exch.assistantMessage, exch.exchangeIndex, exch.tokenEstimate, exch.createdAt);

  const row = db.prepare("SELECT rowid FROM exchanges WHERE id = ?").get(exch.id) as { rowid: number };
  db.prepare("INSERT INTO exchanges_fts (rowid, user_message, assistant_message) VALUES (?, ?, ?)").run(row.rowid, exch.userMessage, exch.assistantMessage);

  // Insert an entity
  const ent = createTestEntity({
    id: "mcp-ent-sqlite",
    name: "SQLite",
    type: "technology",
    description: "Lightweight embedded database",
  });

  db.prepare(`
    INSERT INTO entities (id, name, type, description, aliases, first_seen, last_seen, mention_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ent.id, ent.name, ent.type, ent.description, JSON.stringify(ent.aliases), ent.firstSeen, ent.lastSeen, ent.mentionCount, ent.createdAt);
});

afterAll(() => {
  testDb.cleanup();
});

describe("MCP Server Tool Definitions", () => {
  it("has all 5 expected tools", async () => {
    // The MCP server registers tools via ListToolsRequestSchema handler
    // We can verify tool definitions by checking the server module's exports
    // Since the server is designed for stdio, we test the tool schemas directly

    const expectedTools = ["recall", "remember", "show", "explore", "reflect"];

    // Read the server source to verify tool names are registered
    const { readFileSync } = await import("node:fs");
    const serverSource = readFileSync(
      new URL("../../src/interfaces/mcp/server.ts", import.meta.url),
      "utf-8",
    );

    for (const tool of expectedTools) {
      expect(serverSource).toContain(`name: "${tool}"`);
    }
  });

  it("remember's LLM merge is bounded by its own timeout, not the dream pipeline's", async () => {
    const { readFileSync } = await import("node:fs");
    const serverSource = readFileSync(
      new URL("../../src/interfaces/mcp/server.ts", import.meta.url),
      "utf-8",
    );
    expect(serverSource).toMatch(/const MERGE_TIMEOUT_MS = (\d+)_?(\d*);/);
    const ms = Number(serverSource.match(/const MERGE_TIMEOUT_MS = ([\d_]+);/)![1].replace(/_/g, ""));
    expect(ms).toBeLessThanOrEqual(30_000);
    expect(serverSource).toContain("timeoutMs: MERGE_TIMEOUT_MS");
  });

  it("MCP_TOOL_NAMES matches the tools registered in the server source", async () => {
    const { MCP_TOOL_NAMES } = await import("../../src/interfaces/mcp/tool-names.js");
    const { readFileSync } = await import("node:fs");
    const serverSource = readFileSync(
      new URL("../../src/interfaces/mcp/server.ts", import.meta.url),
      "utf-8",
    );
    const listBlock = serverSource.slice(
      serverSource.indexOf("export const MCP_TOOL_DEFINITIONS"),
      serverSource.indexOf("function registerToolHandlers("),
    );
    const registered = [...listBlock.matchAll(/^\s{4}name: "([a-z_]+)"/gm)].map((m) => m[1]);
    expect([...registered].sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it("recall tool has correct input schema shape", async () => {
    const { MCP_TOOL_DEFINITIONS } = await import("../../src/interfaces/mcp/server.js");
    const recall = MCP_TOOL_DEFINITIONS.find((t) => t.name === "recall")!;
    expect(Object.keys(recall.inputSchema.properties!)).toEqual(
      expect.arrayContaining(["query", "budget", "after", "before", "depth", "sources"]),
    );
    expect(recall.inputSchema.required).toEqual(["query"]);
  });

  it("remember tool accepts content, type, importance", async () => {
    const { MCP_TOOL_DEFINITIONS } = await import("../../src/interfaces/mcp/server.js");
    const remember = MCP_TOOL_DEFINITIONS.find((t) => t.name === "remember")!;
    expect(Object.keys(remember.inputSchema.properties!)).toEqual(
      expect.arrayContaining(["content", "type", "importance"]),
    );
    expect(remember.inputSchema.required).toEqual(["content"]);
  });
});

describe("MCP Tool Behaviors (unit-level)", () => {
  it("search pipeline returns formatted XML", async () => {
    const { searchMultiSource } = await import("../../src/_core/search/orchestrator.js");
    const { formatRecallXml } = await import("../../src/_core/search/format.js");

    const response = await searchMultiSource(testDb.db, {
      query: "SQLite database",
      sources: ["episodic"],
      mode: "text",
      budget: 1500,
    });

    const xml = formatRecallXml(response);

    expect(xml).toContain("<engram_memory");
    expect(xml).toContain("query=");
    expect(xml).toContain("</engram_memory>");
  });

  it("remember deduplication works", async () => {
    const { embedDocument } = await import("../../src/_core/embeddings/index.js");
    const { insertMemory, findNearestMemories } = await import(
      "../../src/semantic/memory.js"
    );

    const content = "Test memory for MCP dedup check";
    const embedding = await embedDocument(content);

    const memory = {
      id: "mcp-mem-dedup",
      type: "fact" as const,
      content,
      confidence: 0.9,
      importance: 0.7,
      accessCount: 0,
      createdAt: Math.floor(Date.now() / 1000),
      sourceExchanges: [],
      isActive: true,
    };

    insertMemory(testDb.db, memory, embedding);

    // Same embedding should find the existing memory
    const neighbors = findNearestMemories(testDb.db, embedding, 3);
    expect(neighbors.length).toBeGreaterThan(0);
    expect(neighbors[0].id).toBe("mcp-mem-dedup");
  });

  it("explore returns graph structure", async () => {
    const { exploreEntity } = await import("../../src/graph/search.js");

    const result = exploreEntity(testDb.db, {
      entity: "SQLite",
      depth: 1,
    });

    expect(result.centerEntity).toBeDefined();
    expect(result.centerEntity.name).toBe("SQLite");
    expect(result.centerEntity.type).toBe("technology");
  });
});

describe("XML Output Format", () => {
  it("escapes special XML characters", async () => {
    const { escapeXml } = await import("../../src/_core/search/format.js");

    expect(escapeXml("a < b")).toBe("a &lt; b");
    expect(escapeXml("a > b")).toBe("a &gt; b");
    expect(escapeXml('a & "b"')).toBe("a &amp; &quot;b&quot;");
  });
});

describe("CLI Entry Points", () => {
  it("CLI has mcp command registered", async () => {
    const { readFileSync } = await import("node:fs");
    const cliSource = readFileSync(
      new URL("../../src/interfaces/cli/index.ts", import.meta.url),
      "utf-8",
    );

    expect(cliSource).toContain('.command("mcp")');
  });

  it("CLI has health command registered", async () => {
    const { readFileSync } = await import("node:fs");
    const cliSource = readFileSync(
      new URL("../../src/interfaces/cli/index.ts", import.meta.url),
      "utf-8",
    );

    expect(cliSource).toContain('.command("health")');
  });

  it("MCP server has shebang line", async () => {
    const { readFileSync } = await import("node:fs");
    const serverSource = readFileSync(
      new URL("../../src/interfaces/mcp/server.ts", import.meta.url),
      "utf-8",
    );

    expect(serverSource.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("CLI has shebang line", async () => {
    const { readFileSync } = await import("node:fs");
    const cliSource = readFileSync(
      new URL("../../src/interfaces/cli/index.ts", import.meta.url),
      "utf-8",
    );

    expect(cliSource.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
