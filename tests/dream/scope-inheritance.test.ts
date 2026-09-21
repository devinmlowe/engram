/**
 * W2: the dream pipeline carries `conversations.scope` into every memory it
 * extracts from that conversation. Mocks the LLM extractor + embeddings + NLI;
 * the real consolidator writes memories.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";

vi.mock("../../src/episodic/sync.js", () => ({
  syncConversations: vi.fn().mockResolvedValue({
    discovered: 0, indexed: 0, copied: 0, skipped: 0, conversations: 0, errors: [],
  }),
}));

vi.mock("../../src/_core/embeddings/index.js", async () =>
  (await import("../mocks/embeddings.js")).deterministicEmbeddings(),
);

vi.mock("../../src/semantic/nli.js", () => ({
  classifyNli: vi.fn().mockResolvedValue({ entailment: 0, contradiction: 0, neutral: 1 }),
}));

vi.mock("../../src/semantic/extractor.js", () => ({
  initExtractor: vi.fn().mockResolvedValue(undefined),
  extractFromConversation: vi.fn().mockImplementation(async (conversationId: string) => ({
    facts: [
      { type: "fact", content: `Fact one from ${conversationId}`, importance: 0.7, sourceExchangeIds: [] },
      { type: "preference", content: `Preference from ${conversationId}`, importance: 0.5, sourceExchangeIds: [] },
    ],
    model: "test-model",
    tier: "haiku",
    confidence: 8,
    durationMs: 5,
  })),
}));

// Keep the real consolidateFacts (it writes memories); stub only provider init.
vi.mock("../../src/semantic/consolidator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/semantic/consolidator.js")>();
  return { ...actual, initConsolidator: vi.fn() };
});

vi.mock("../../src/graph/extractor.js", () => ({
  initGraphExtractor: vi.fn().mockResolvedValue(undefined),
  extractEntities: vi.fn().mockResolvedValue({ entities: [], model: "m", tier: "haiku", durationMs: 1 }),
  extractRelationships: vi.fn().mockResolvedValue({ relationships: [], model: "m", tier: "haiku", durationMs: 1 }),
}));
vi.mock("../../src/graph/resolver.js", () => ({ resolveEntities: vi.fn().mockResolvedValue([]) }));
vi.mock("../../src/graph/relationship.js", () => ({ findOrCreateRelationship: vi.fn() }));
vi.mock("../../src/graph/reflection.js", () => ({
  runReflection: vi.fn().mockResolvedValue({
    communities: [], bridges: [], temporalPatterns: [],
    health: { totalNodes: 0, totalEdges: 0, modularity: 0, communityCount: 0, orphanNodes: 0, averageCoherence: 0, generationCount: 0 },
    observations: [], generation: 1, generatedAt: Math.floor(Date.now() / 1000),
  }),
}));
vi.mock("../../src/semantic/decay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/semantic/decay.js")>();
  return { ...actual, isPruneEligible: vi.fn().mockReturnValue(false) };
});
vi.mock("../../src/dream/commitments-pass.js", () => ({
  runCommitmentsPass: vi.fn().mockResolvedValue({ processed: 0, errors: 0, created: 0 }),
}));

import { runDream } from "../../src/dream/daemon.js";

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  vi.clearAllMocks();
});

afterEach(() => {
  t.cleanup();
});

function seedConversation(convId: string, scope: string | null, project = "hermes"): void {
  if (scope === null) {
    t.db
      .prepare("INSERT INTO conversations (id, project, last_indexed, exchange_count) VALUES (?, ?, ?, ?)")
      .run(convId, project, Math.floor(Date.now() / 1000), 1);
  } else {
    t.db
      .prepare("INSERT INTO conversations (id, project, last_indexed, exchange_count, scope) VALUES (?, ?, ?, ?, ?)")
      .run(convId, project, Math.floor(Date.now() / 1000), 1, scope);
  }
  t.db
    .prepare(
      `INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`${convId}:0`, convId, project, new Date().toISOString(), "Question?", "Answer.", 0, 10);
}

function memoriesFor(convId: string): Array<{ content: string; scope: string }> {
  return t.db
    .prepare("SELECT content, scope FROM memories WHERE content LIKE ? ORDER BY content")
    .all(`%${convId}`) as Array<{ content: string; scope: string }>;
}

describe("dream extraction scope inheritance (W2)", () => {
  it("memories extracted from a hermes:career conversation carry scope hermes:career", async () => {
    seedConversation("hermes:sess-career", "hermes:career");
    seedConversation("claude-conv-1", "global", "engram");
    seedConversation("legacy-conv", null, "engram");

    const report = await runDream(t.db, t.config, { phases: ["extract", "consolidate"] });
    expect(report.newMemories).toBeGreaterThanOrEqual(6);

    const career = memoriesFor("hermes:sess-career");
    expect(career).toHaveLength(2);
    for (const m of career) expect(m.scope).toBe("hermes:career");

    const global = memoriesFor("claude-conv-1");
    expect(global).toHaveLength(2);
    for (const m of global) expect(m.scope).toBe("global");

    const legacy = memoriesFor("legacy-conv");
    expect(legacy).toHaveLength(2);
    for (const m of legacy) expect(m.scope).toBe("global");
  });
});
