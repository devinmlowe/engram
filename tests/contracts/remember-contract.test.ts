/**
 * Contract tests for backward compatibility of the remember tool.
 *
 * Phase 6D: Ensures existing remember tool behavior is preserved
 * after adding source parameter and batch capability.
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

describe("existing remember tool backward compatible", () => {
  it("remember tool accepts same parameters as before", async () => {
    const { rememberFact } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    // Original call signature: content, type, importance (no source)
    const result = await rememberFact(t.db, {
      content: "User prefers Fish shell",
      type: "preference",
      importance: 0.8,
    });

    expect(result.action).toBe("created");
    expect(result.memoryId).toBeDefined();
    expect(result.content).toBe("User prefers Fish shell");
  });

  it("remember without source works identically to before", async () => {
    const { rememberFact } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const result = await rememberFact(t.db, {
      content: "SQLite is preferred for local storage",
      type: "fact",
      importance: 0.7,
    });

    expect(result.action).toBe("created");

    // Verify the memory was stored correctly
    const mem = getMemory(t.db, result.memoryId);
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe("SQLite is preferred for local storage");
    expect(mem!.type).toBe("fact");
    expect(mem!.importance).toBe(0.7);
    expect(mem!.isActive).toBe(true);
    // Source should default to 'user'
    expect(mem!.source).toBe("user");
  });

  it("stored memories retrievable via existing recall patterns", async () => {
    const { rememberFact } = await import(
      "../../src/interfaces/shared/remember.js"
    );
    const { findNearestMemories } = await import(
      "../../src/semantic/memory.js"
    );
    const { embedDocument } = await import(
      "../../src/_core/embeddings/index.js"
    );

    // Store a memory using the original interface
    const result = await rememberFact(t.db, {
      content: "TypeScript uses structural typing",
      type: "fact",
      importance: 0.7,
    });

    expect(result.action).toBe("created");

    // Retrieve using vector search (same pattern as recall tool)
    const embedding = await embedDocument("TypeScript uses structural typing");
    const neighbors = findNearestMemories(t.db, embedding, 3);

    expect(neighbors.length).toBeGreaterThan(0);
    expect(neighbors[0].id).toBe(result.memoryId);
  });

  it("deduplication still works without source param", async () => {
    const { rememberFact } = await import(
      "../../src/interfaces/shared/remember.js"
    );

    const first = await rememberFact(t.db, {
      content: "Dedup test content for contract",
      type: "fact",
      importance: 0.7,
    });

    const second = await rememberFact(t.db, {
      content: "Dedup test content for contract",
      type: "fact",
      importance: 0.7,
    });

    expect(first.action).toBe("created");
    expect(second.action).toBe("updated");
    expect(second.memoryId).toBe(first.memoryId);
  });
});

describe("MCP remember tool schema", () => {
  it("remember tool definition includes optional source parameter", async () => {
    const { readFileSync } = await import("node:fs");
    const serverSource = readFileSync(
      new URL("../../src/interfaces/mcp/server.ts", import.meta.url),
      "utf-8",
    );

    // The remember tool should have a source property
    expect(serverSource).toContain("source:");
    // It should still require only content
    expect(serverSource).toContain('required: ["content"]');
  });

  it("remember_batch tool is registered", async () => {
    const { readFileSync } = await import("node:fs");
    const serverSource = readFileSync(
      new URL("../../src/interfaces/mcp/server.ts", import.meta.url),
      "utf-8",
    );

    expect(serverSource).toContain('name: "remember_batch"');
  });
});
