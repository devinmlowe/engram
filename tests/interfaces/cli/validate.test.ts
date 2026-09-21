import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { validateEmbeddings, validateFTS } from "../../../src/interfaces/cli/validate.js";
import { createTestDb, insertExchange as insertExchangeRow } from "../../helpers.js";
import type { TestDb } from "../../helpers.js";

// ─── Helpers ────────────────────────────────────────────────────

function randomNormalizedVector(dims: number = 256): number[] {
  const vec = Array.from({ length: dims }, () => Math.random() - 0.5);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

/** An exchange row plus its vec_exchanges embedding (random unit vector unless given). */
function insertExchange(
  db: Database.Database,
  id: string,
  conversationId: string,
  userMessage: string = "user message",
  assistantMessage: string = "assistant message",
  embedding: number[] = randomNormalizedVector(),
): void {
  insertExchangeRow(db, id, conversationId, { project: "test", timestamp: "2026-01-15T10:00:00Z", userMessage, assistantMessage });
  db.prepare("INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)").run(id, Buffer.from(new Float32Array(embedding).buffer));
}

// ─── Tests ──────────────────────────────────────────────────────

describe("validateEmbeddings", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it("passes with correct dimension and norm", () => {
    insertExchange(t.db, "e1", "conv");

    const results = validateEmbeddings(t.db, 10);
    const dimCheck = results.find((r) => r.check.includes("dimensions"));
    const normCheck = results.find((r) => r.check.includes("norm"));

    expect(dimCheck!.passed).toBe(true);
    expect(normCheck!.passed).toBe(true);
  });

  it("reports no sample available when vec_exchanges is empty", () => {
    const results = validateEmbeddings(t.db, 10);
    const sampleCheck = results.find((r) => r.check.includes("sample available"));
    expect(sampleCheck).toBeDefined();
    expect(sampleCheck!.passed).toBe(false);
  });

  it("detects unnormalized vectors", () => {
    const unnormalized = Array.from({ length: 256 }, () => 10.0);
    insertExchange(t.db, "e-unnorm", "conv", "msg", "resp", unnormalized);

    const results = validateEmbeddings(t.db, 10);
    const normCheck = results.find((r) => r.check.includes("norm"));
    expect(normCheck!.passed).toBe(false);
  });
});

describe("validateFTS", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it("passes FTS integrity check on healthy DB", () => {
    insertExchange(
      t.db,
      "e1",
      "conv",
      "How does SQLite FTS5 work?",
      "FTS5 provides full-text search capabilities...",
    );
    t.db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");

    const results = validateFTS(t.db);
    const integrityCheck = results.find((r) => r.check.includes("integrity"));
    expect(integrityCheck!.passed).toBe(true);
  });

  it("reports the FTS hit rate over sampled exchange content", () => {
    const messages = [
      "How does authentication middleware work in Express?",
      "What is the difference between PostgreSQL and SQLite databases?",
      "Explain containerization with Docker and Kubernetes orchestration",
      "How do I configure TypeScript compiler options correctly?",
      "Describe the implementation of binary search algorithms",
    ];

    for (let i = 0; i < messages.length; i++) {
      insertExchange(t.db, `e-fts-${i}`, "conv", messages[i], `Response about ${messages[i].toLowerCase()}`);
    }
    t.db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");

    const results = validateFTS(t.db);
    const hitCheck = results.find((r) => r.check.includes("hit rate"));
    expect(hitCheck).toBeDefined();
    expect(hitCheck!.passed).toBe(true);
  });
});
