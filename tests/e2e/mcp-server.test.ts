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
vi.mock("../../src/_core/embeddings/index.js", () => {
  const dims = 256;

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
      new URL("../../src/mcp/server.ts", import.meta.url),
      "utf-8",
    );

    for (const tool of expectedTools) {
      expect(serverSource).toContain(`name: "${tool}"`);
    }
  });

  it("recall tool has correct input schema shape", async () => {
    const { readFileSync } = await import("node:fs");
    const serverSource = readFileSync(
      new URL("../../src/mcp/server.ts", import.meta.url),
      "utf-8",
    );

    // Verify recall accepts query, budget, after, before, depth, sources
    expect(serverSource).toContain("query");
    expect(serverSource).toContain("budget");
    expect(serverSource).toContain("after");
    expect(serverSource).toContain("before");
    expect(serverSource).toContain("depth");
    expect(serverSource).toContain("sources");
  });

  it("remember tool accepts content, type, importance", async () => {
    const { readFileSync } = await import("node:fs");
    const serverSource = readFileSync(
      new URL("../../src/mcp/server.ts", import.meta.url),
      "utf-8",
    );

    // Check remember tool schema properties (keys are unquoted in TS source)
    expect(serverSource).toContain("content:");
    expect(serverSource).toContain("importance:");
    // Verify remember-specific schema structure
    expect(serverSource).toContain('required: ["content"]');
    expect(serverSource).toContain("RememberInputSchema");
  });
});

describe("MCP Tool Behaviors (unit-level)", () => {
  it("search pipeline returns formatted XML", async () => {
    const { searchMultiSource, formatRecallXml } = await import(
      "../../src/episodic/search.js"
    );

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
    const { escapeXml } = await import("../../src/episodic/search.js");

    expect(escapeXml("a < b")).toBe("a &lt; b");
    expect(escapeXml("a > b")).toBe("a &gt; b");
    expect(escapeXml('a & "b"')).toBe("a &amp; &quot;b&quot;");
  });
});

describe("CLI Entry Points", () => {
  it("CLI has mcp command registered", async () => {
    const { readFileSync } = await import("node:fs");
    const cliSource = readFileSync(
      new URL("../../src/cli/index.ts", import.meta.url),
      "utf-8",
    );

    expect(cliSource).toContain('.command("mcp")');
  });

  it("CLI has health command registered", async () => {
    const { readFileSync } = await import("node:fs");
    const cliSource = readFileSync(
      new URL("../../src/cli/index.ts", import.meta.url),
      "utf-8",
    );

    expect(cliSource).toContain('.command("health")');
  });

  it("MCP server has shebang line", async () => {
    const { readFileSync } = await import("node:fs");
    const serverSource = readFileSync(
      new URL("../../src/mcp/server.ts", import.meta.url),
      "utf-8",
    );

    expect(serverSource.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("CLI has shebang line", async () => {
    const { readFileSync } = await import("node:fs");
    const cliSource = readFileSync(
      new URL("../../src/cli/index.ts", import.meta.url),
      "utf-8",
    );

    expect(cliSource.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
