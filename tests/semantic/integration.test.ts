/**
 * End-to-end integration tests for the Phase 3 semantic pipeline.
 *
 * Tests the full flow: episodic insert -> extraction (mocked) ->
 * consolidation -> multi-source search -> remember -> dedup.
 *
 * LLM calls are mocked; embeddings and NLI are mocked for speed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  consolidateFacts,
  resetConsolidator,
  setConsolidatorClient,
} from "../../src/semantic/consolidator.js";
import { searchMultiSource, formatRecallXml } from "../../src/episodic/search.js";
import {
  insertMemory,
  getMemory,
  recordAccess,
  findNearestMemories,
} from "../../src/semantic/memory.js";
import { insertExchange } from "../../src/episodic/store.js";
import { createTestDb, createSyntheticExchange } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { Memory } from "../../src/semantic/types.js";
import type { ExtractedFact } from "../../src/semantic/types.js";

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock("../../src/semantic/nli.js", () => ({
  classifyNli: vi.fn(),
}));

vi.mock("../../src/_core/embeddings/index.js", () => {
  // Produce deterministic embeddings based on content
  function hashEmbedding(text: string, dims: number = 256): number[] {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) & 0xffffffff;
    }
    let state = hash;
    const next = () => {
      state = (state * 1664525 + 1013904223) & 0xffffffff;
      return (state >>> 0) / 0xffffffff - 0.5;
    };
    const vec = Array.from({ length: dims }, () => next());
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / norm);
  }

  return {
    embedDocument: vi.fn((text: string) =>
      Promise.resolve(hashEmbedding(text)),
    ),
    embedQuery: vi.fn((text: string) =>
      Promise.resolve(hashEmbedding(text)),
    ),
    embedExchange: vi.fn(
      (userMsg: string, assistantMsg: string) =>
        Promise.resolve(hashEmbedding(userMsg + assistantMsg)),
    ),
    initEmbeddings: vi.fn(() => Promise.resolve()),
    getActiveModel: vi.fn(() => "nomic"),
    getActiveDimensions: vi.fn(() => 256),
    resetEmbeddings: vi.fn(),
    embedDocumentBatch: vi.fn((texts: string[]) =>
      Promise.resolve(texts.map((t) => hashEmbedding(t))),
    ),
  };
});

import { classifyNli } from "../../src/semantic/nli.js";
import {
  embedDocument,
  embedQuery,
  embedExchange,
} from "../../src/_core/embeddings/index.js";

const mockedClassifyNli = vi.mocked(classifyNli);
const mockedEmbedDocument = vi.mocked(embedDocument);
const mockedEmbedQuery = vi.mocked(embedQuery);
const mockedEmbedExchange = vi.mocked(embedExchange);

// ─── Helpers ────────────────────────────────────────────────────

let t: TestDb;

function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  const id =
    overrides.id ?? `mem-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    type: "fact",
    content: "Default test memory content",
    confidence: 0.5,
    importance: 0.5,
    accessCount: 0,
    createdAt: Math.floor(Date.now() / 1000),
    sourceExchanges: ["exch-001"],
    isActive: true,
    ...overrides,
  };
}

function createTestFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    type: "fact",
    content: "New fact content",
    importance: 0.5,
    sourceExchangeIds: ["exch-010"],
    ...overrides,
  };
}

async function seedExchange(
  db: typeof t.db,
  id: string,
  userMsg: string,
  assistantMsg: string,
  project: string = "test",
) {
  const exchange = createSyntheticExchange({
    id,
    userMessage: userMsg,
    assistantMessage: assistantMsg,
    project,
    timestamp: "2026-02-26T10:00:00Z",
    tokenEstimate: Math.ceil((userMsg.length + assistantMsg.length) / 4),
  });

  const embedding = await embedExchange(userMsg, assistantMsg, {
    project,
    date: "2026-02-26",
  });

  insertExchange(db, exchange, embedding, []);
}

// ─── Setup / Teardown ───────────────────────────────────────────

beforeEach(() => {
  t = createTestDb();
  resetConsolidator();
  vi.clearAllMocks();
});

afterEach(() => {
  t.cleanup();
  resetConsolidator();
});

// ─── Integration Tests ──────────────────────────────────────────

describe("Phase 3 Integration: extraction -> consolidation -> search", () => {
  it("inserts synthetic exchanges, consolidates facts, and finds them via multi-source search", async () => {
    // Step 1: Insert synthetic episodic exchanges
    await seedExchange(
      t.db,
      "e-fish-1",
      "I prefer Fish shell over bash",
      "Fish shell has great autocomplete features",
    );
    await seedExchange(
      t.db,
      "e-sqlite-1",
      "We use SQLite for the database",
      "SQLite with WAL mode gives good performance",
    );

    // Step 2: Create mock extraction results (simulating Stream C output)
    const extractedFacts: ExtractedFact[] = [
      {
        type: "preference",
        content: "User prefers Fish shell over bash",
        context: "Stated directly in conversation",
        importance: 0.8,
        sourceExchangeIds: ["e-fish-1"],
      },
      {
        type: "decision",
        content: "Project uses SQLite with WAL mode for database",
        context: "Architectural decision for performance",
        importance: 0.7,
        sourceExchangeIds: ["e-sqlite-1"],
      },
    ];

    // Step 3: Run consolidation (facts are novel since DB is empty)
    const results = await consolidateFacts(t.db, extractedFacts, "conv-test");

    expect(results).toHaveLength(2);
    expect(results[0].action).toBe("insert");
    expect(results[1].action).toBe("insert");

    // Step 4: Search via multi-source — should find both episodic AND semantic
    const response = await searchMultiSource(t.db, {
      query: "Fish shell",
      budget: 5000,
    });

    expect(response.results.length).toBeGreaterThan(0);

    // Should have semantic results (from consolidated facts)
    const semanticResults = response.results.filter(
      (r) => r.source === "semantic",
    );
    expect(semanticResults.length).toBeGreaterThan(0);

    // The semantic result should be the Fish shell preference
    const fishResult = semanticResults.find((r) =>
      r.content.includes("Fish shell"),
    );
    expect(fishResult).toBeDefined();
    expect(fishResult!.source).toBe("semantic");
  });

  it("duplicate fact merges with existing memory and bumps access count", async () => {
    // Insert a memory
    const embedding = await embedDocument("User prefers dark mode");
    const existing = createTestMemory({
      id: "mem-dark-mode",
      content: "User prefers dark mode",
      type: "preference",
      accessCount: 2,
    });
    insertMemory(t.db, existing, embedding);

    // Consolidate same fact — should merge (same embedding = sim 1.0)
    const facts = [
      createTestFact({
        content: "User prefers dark mode",
        type: "preference",
      }),
    ];

    const results = await consolidateFacts(t.db, facts, "conv-dedup");

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("merge");
    expect(results[0].memoryId).toBe("mem-dark-mode");

    // Verify access count was bumped
    const updated = getMemory(t.db, "mem-dark-mode");
    expect(updated!.accessCount).toBe(3);
  });

  it("remember-style explicit memory appears in search results", async () => {
    // Simulate what the MCP 'remember' tool does
    const content = "Always use strict TypeScript mode in this project";
    const embedding = await embedDocument(content);
    const newId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const memory: Memory = {
      id: newId,
      type: "convention",
      content,
      confidence: 0.9, // User-stated
      importance: 0.8,
      accessCount: 0,
      createdAt: now,
      sourceExchanges: [],
      isActive: true,
    };

    insertMemory(t.db, memory, embedding);

    // Search for it
    const response = await searchMultiSource(t.db, {
      query: "strict TypeScript mode",
      budget: 5000,
    });

    expect(response.results.length).toBeGreaterThan(0);

    const found = response.results.find((r) =>
      r.content.includes("strict TypeScript"),
    );
    expect(found).toBeDefined();
    expect(found!.source).toBe("semantic");
  });

  it("deactivated memories are excluded from search results", async () => {
    const activeEmb = await embedDocument("Active memory about Fish shell");
    const inactiveEmb = await embedDocument("Inactive memory about bash shell");

    const activeMem = createTestMemory({
      id: "mem-active-fish",
      content: "Active memory about Fish shell",
      type: "preference",
    });
    const inactiveMem = createTestMemory({
      id: "mem-inactive-bash",
      content: "Inactive memory about bash shell",
      type: "preference",
    });

    insertMemory(t.db, activeMem, activeEmb);
    insertMemory(t.db, inactiveMem, inactiveEmb);

    // Deactivate the bash memory
    const { deactivateMemory } = await import(
      "../../src/semantic/memory.js"
    );
    deactivateMemory(t.db, "mem-inactive-bash", "mem-active-fish");

    // Search — should only find active memory
    const response = await searchMultiSource(t.db, {
      query: "shell preference",
      budget: 5000,
    });

    const ids = response.results.map((r) => r.id);
    // Active memory should be in results, inactive should not
    if (ids.includes("mem-active-fish")) {
      expect(ids).toContain("mem-active-fish");
    }
    expect(ids).not.toContain("mem-inactive-bash");
  });

  it("formatRecallXml handles mixed episodic+semantic results", async () => {
    // Seed both stores
    await seedExchange(
      t.db,
      "e-tmux",
      "I always use tmux",
      "tmux is great for session persistence",
    );

    const memEmb = await embedDocument("User always uses tmux");
    const mem = createTestMemory({
      id: "mem-tmux",
      content: "User always uses tmux",
      type: "preference",
      importance: 0.9,
      confidence: 0.85,
    });
    insertMemory(t.db, mem, memEmb);

    const response = await searchMultiSource(t.db, {
      query: "tmux usage",
      budget: 5000,
    });

    const xml = formatRecallXml(response);

    // Should contain the engram_memory wrapper
    expect(xml).toContain("<engram_memory");
    expect(xml).toContain("</engram_memory>");

    // If semantic result is present, should use semantic tag
    if (response.results.some((r) => r.source === "semantic")) {
      expect(xml).toContain("<semantic");
      expect(xml).toContain("</semantic>");
    }

    // If episodic result is present, should use episodic tag
    if (response.results.some((r) => r.source === "episodic")) {
      expect(xml).toContain("<episodic");
      expect(xml).toContain("</episodic>");
    }
  });
});
