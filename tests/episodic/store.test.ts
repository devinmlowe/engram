import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  insertExchange,
  upsertConversation,
  getConversation,
  getExchange,
  getToolCallsForExchange,
} from "../../src/episodic/store.js";
import {
  createTestDb,
  createSyntheticExchange,
  createSyntheticToolCall,
} from "../helpers.js";
import type { TestDb } from "../helpers.js";

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

function randomEmbedding(dims: number = 256): number[] {
  const vec = Array.from({ length: dims }, () => Math.random() - 0.5);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

describe("Store", () => {
  describe("insertExchange", () => {
    it("inserts and retrieves an exchange", () => {
      const exchange = createSyntheticExchange({ id: "exch-100" });
      const embedding = randomEmbedding();

      insertExchange(t.db, exchange, embedding, []);

      const retrieved = getExchange(t.db, "exch-100");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("exch-100");
      expect(retrieved!.userMessage).toBe(exchange.userMessage);
      expect(retrieved!.assistantMessage).toBe(exchange.assistantMessage);
      expect(retrieved!.project).toBe(exchange.project);
    });

    it("makes exchange searchable via FTS", () => {
      const exchange = createSyntheticExchange({
        id: "fts-test",
        userMessage: "How does Zettelkasten work?",
        assistantMessage: "Zettelkasten is a note-taking method...",
      });

      insertExchange(t.db, exchange, randomEmbedding(), []);

      const results = t.db
        .prepare(
          "SELECT rowid FROM exchanges_fts WHERE exchanges_fts MATCH ?",
        )
        .all("zettelkasten") as { rowid: number }[];

      expect(results.length).toBeGreaterThan(0);
    });

    it("makes exchange searchable via vector", () => {
      const exchange = createSyntheticExchange({ id: "vec-test" });
      const embedding = randomEmbedding();

      insertExchange(t.db, exchange, embedding, []);

      const queryBuf = Buffer.from(new Float32Array(embedding).buffer);
      const results = t.db
        .prepare(
          "SELECT id, distance FROM vec_exchanges WHERE embedding MATCH ? AND k = 5",
        )
        .all(queryBuf) as { id: string; distance: number }[];

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("vec-test");
      expect(results[0].distance).toBeCloseTo(0, 3); // Same vector → distance ~0
    });

    it("stores tool calls correctly", () => {
      const exchange = createSyntheticExchange({ id: "tc-test" });
      const tc1 = createSyntheticToolCall({
        id: "tc-1",
        exchangeId: "tc-test",
        toolName: "Read",
      });
      const tc2 = createSyntheticToolCall({
        id: "tc-2",
        exchangeId: "tc-test",
        toolName: "Write",
        isError: true,
      });

      insertExchange(t.db, exchange, randomEmbedding(), [tc1, tc2]);

      const toolCalls = getToolCallsForExchange(t.db, "tc-test");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls.map((tc) => tc.toolName).sort()).toEqual(["Read", "Write"]);
      expect(toolCalls.find((tc) => tc.toolName === "Write")!.isError).toBe(true);
    });

    it("supports idempotent re-insert (INSERT OR REPLACE)", () => {
      const exchange = createSyntheticExchange({
        id: "idem-test",
        userMessage: "Version 1",
      });

      insertExchange(t.db, exchange, randomEmbedding(), []);

      // Re-insert with updated content
      const updated = createSyntheticExchange({
        id: "idem-test",
        userMessage: "Version 2",
      });
      insertExchange(t.db, updated, randomEmbedding(), []);

      const retrieved = getExchange(t.db, "idem-test");
      expect(retrieved!.userMessage).toBe("Version 2");

      // Should still be only one exchange
      const count = t.db
        .prepare("SELECT COUNT(*) as c FROM exchanges WHERE id = ?")
        .get("idem-test") as { c: number };
      expect(count.c).toBe(1);
    });
  });

  describe("upsertConversation / getConversation", () => {
    it("inserts and retrieves a conversation", () => {
      upsertConversation(t.db, {
        id: "conv-100",
        project: "test-project",
        startedAt: "2026-02-26T10:00:00Z",
        endedAt: "2026-02-26T11:00:00Z",
        exchangeCount: 5,
        primaryTopics: ["sqlite", "testing"],
        archivePath: "/tmp/archive/conv.jsonl",
        lastIndexed: 1000000,
      });

      const conv = getConversation(t.db, "conv-100");
      expect(conv).not.toBeNull();
      expect(conv!.project).toBe("test-project");
      expect(conv!.exchangeCount).toBe(5);
      expect(conv!.primaryTopics).toEqual(["sqlite", "testing"]);
      expect(conv!.lastIndexed).toBe(1000000);
    });

    it("updates existing conversation on re-upsert", () => {
      upsertConversation(t.db, {
        id: "conv-200",
        project: "test",
        exchangeCount: 3,
      });

      upsertConversation(t.db, {
        id: "conv-200",
        project: "test",
        exchangeCount: 7,
        lastIndexed: 2000000,
      });

      const conv = getConversation(t.db, "conv-200");
      expect(conv!.exchangeCount).toBe(7);
      expect(conv!.lastIndexed).toBe(2000000);
    });

    it("returns null for non-existent conversation", () => {
      expect(getConversation(t.db, "nonexistent")).toBeNull();
    });
  });
});
