import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateRowCounts,
  validateEmbeddings,
  validateContent,
  validateFTS,
  validateSearchQuality,
} from "../../src/migration/validate.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";

// ─── Helpers ────────────────────────────────────────────────────

interface TestContext {
  sourceDb: Database.Database;
  target: TestDb;
  tmpDir: string;
}

function createSourceDb(tmpDir: string): Database.Database {
  const dbPath = join(tmpDir, "source.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE exchanges (
      id TEXT PRIMARY KEY,
      project TEXT,
      timestamp TEXT,
      user_message TEXT,
      assistant_message TEXT,
      archive_path TEXT,
      line_start INTEGER,
      line_end INTEGER,
      session_id TEXT,
      cwd TEXT,
      git_branch TEXT,
      claude_version TEXT,
      is_sidechain INTEGER DEFAULT 0
    );

    CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY,
      exchange_id TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_result TEXT,
      is_error INTEGER DEFAULT 0,
      timestamp TEXT
    );
  `);

  return db;
}

function randomNormalizedVector(dims: number = 256): number[] {
  const vec = Array.from({ length: dims }, () => Math.random() - 0.5);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

function insertSourceExchange(
  db: Database.Database,
  id: string,
  archivePath: string,
  userMsg: string = "user message",
  assistantMsg: string = "assistant message",
): void {
  db.prepare(
    `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
     VALUES (?, 'test', '2026-01-15T10:00:00Z', ?, ?, ?, 0, 10)`,
  ).run(id, userMsg, assistantMsg, archivePath);
}

function insertTargetExchange(
  db: Database.Database,
  id: string,
  conversationId: string,
  userMsg: string = "user message",
  assistantMsg: string = "assistant message",
  embedding?: number[],
): void {
  db.prepare(
    `INSERT OR REPLACE INTO exchanges
       (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate)
     VALUES (?, ?, 'test', '2026-01-15T10:00:00Z', ?, ?, 0, 50)`,
  ).run(id, conversationId, userMsg, assistantMsg);

  // Insert vector
  const vec = embedding ?? randomNormalizedVector();
  db.prepare("DELETE FROM vec_exchanges WHERE id = ?").run(id);
  db.prepare("INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)").run(
    id,
    Buffer.from(new Float32Array(vec).buffer),
  );
}

function setupCtx(): TestContext {
  const tmpDir = mkdtempSync(join(tmpdir(), "engram-validate-test-"));
  const sourceDb = createSourceDb(tmpDir);
  const target = createTestDb();

  return { sourceDb, target, tmpDir };
}

function cleanupCtx(ctx: TestContext): void {
  ctx.sourceDb.close();
  ctx.target.cleanup();
  rmSync(ctx.tmpDir, { recursive: true, force: true });
}

// ─── Tests ──────────────────────────────────────────────────────

describe("validateRowCounts", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupCtx();
  });

  afterEach(() => {
    cleanupCtx(ctx);
  });

  it("detects row count mismatch", () => {
    // Insert 3 exchanges in source, 2 in target
    insertSourceExchange(ctx.sourceDb, "e1", "/archive/project/conv.jsonl");
    insertSourceExchange(ctx.sourceDb, "e2", "/archive/project/conv.jsonl");
    insertSourceExchange(ctx.sourceDb, "e3", "/archive/project/conv.jsonl");

    insertTargetExchange(ctx.target.db, "e1", "conv");
    insertTargetExchange(ctx.target.db, "e2", "conv");

    const results = validateRowCounts(ctx.sourceDb, ctx.target.db);
    const exchangeCheck = results.find(
      (r) => r.check === "Exchange row count",
    );
    expect(exchangeCheck).toBeDefined();
    expect(exchangeCheck!.passed).toBe(false);
    expect(exchangeCheck!.expected).toBe(3);
    expect(exchangeCheck!.actual).toBe(2);
  });

  it("passes when counts match", () => {
    insertSourceExchange(ctx.sourceDb, "e1", "/archive/project/conv.jsonl");
    insertSourceExchange(ctx.sourceDb, "e2", "/archive/project/conv.jsonl");

    insertTargetExchange(ctx.target.db, "e1", "conv");
    insertTargetExchange(ctx.target.db, "e2", "conv");

    // Insert target conversation
    ctx.target.db
      .prepare(
        "INSERT INTO conversations (id, project, exchange_count) VALUES (?, ?, ?)",
      )
      .run("conv", "test", 2);

    const results = validateRowCounts(ctx.sourceDb, ctx.target.db);
    const exchangeCheck = results.find(
      (r) => r.check === "Exchange row count",
    );
    expect(exchangeCheck!.passed).toBe(true);
  });

  it("excludes double-shot-latte from source counts", () => {
    insertSourceExchange(ctx.sourceDb, "e1", "/archive/project/conv.jsonl");
    insertSourceExchange(
      ctx.sourceDb,
      "e2",
      "/archive/double-shot-latte/conv2.jsonl",
    );

    insertTargetExchange(ctx.target.db, "e1", "conv");

    const results = validateRowCounts(ctx.sourceDb, ctx.target.db);
    const exchangeCheck = results.find(
      (r) => r.check === "Exchange row count",
    );
    // Source count should be 1 (excluded), target is 1 => pass
    expect(exchangeCheck!.passed).toBe(true);
    expect(exchangeCheck!.expected).toBe(1);
  });
});

describe("validateEmbeddings", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupCtx();
  });

  afterEach(() => {
    cleanupCtx(ctx);
  });

  it("passes with correct dimension and norm", () => {
    insertTargetExchange(ctx.target.db, "e1", "conv");

    const results = validateEmbeddings(ctx.target.db, 10);
    const dimCheck = results.find((r) =>
      r.check.includes("dimensions"),
    );
    const normCheck = results.find((r) => r.check.includes("norm"));

    expect(dimCheck!.passed).toBe(true);
    expect(normCheck!.passed).toBe(true);
  });

  it("reports no sample available when vec_exchanges is empty", () => {
    // No vectors inserted — validateEmbeddings should report the issue
    const results = validateEmbeddings(ctx.target.db, 10);
    const sampleCheck = results.find((r) =>
      r.check.includes("sample available"),
    );
    expect(sampleCheck).toBeDefined();
    expect(sampleCheck!.passed).toBe(false);
  });

  it("detects unnormalized vectors", () => {
    // Insert a vector that is not normalized (norm >> 1)
    const unnormalized = Array.from({ length: 256 }, () => 10.0);
    ctx.target.db
      .prepare(
        `INSERT INTO exchanges
         (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate)
         VALUES ('e-unnorm', 'conv', 'test', '2026-01-01', 'msg', 'resp', 0, 10)`,
      )
      .run();

    ctx.target.db
      .prepare("INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)")
      .run(
        "e-unnorm",
        Buffer.from(new Float32Array(unnormalized).buffer),
      );

    const results = validateEmbeddings(ctx.target.db, 10);
    const normCheck = results.find((r) => r.check.includes("norm"));
    expect(normCheck!.passed).toBe(false);
  });
});

describe("validateContent", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupCtx();
  });

  afterEach(() => {
    cleanupCtx(ctx);
  });

  it("passes when content matches", () => {
    insertSourceExchange(
      ctx.sourceDb,
      "e1",
      "/archive/project/conv.jsonl",
      "Hello",
      "World",
    );
    insertTargetExchange(ctx.target.db, "e1", "conv", "Hello", "World");

    const results = validateContent(ctx.sourceDb, ctx.target.db, 10);
    const presenceCheck = results.find((r) =>
      r.check.includes("presence"),
    );
    const accuracyCheck = results.find((r) =>
      r.check.includes("accuracy"),
    );

    expect(presenceCheck!.passed).toBe(true);
    expect(accuracyCheck!.passed).toBe(true);
  });

  it("detects content mismatch", () => {
    insertSourceExchange(
      ctx.sourceDb,
      "e1",
      "/archive/project/conv.jsonl",
      "Original question",
      "Original answer",
    );
    insertTargetExchange(
      ctx.target.db,
      "e1",
      "conv",
      "Different question",
      "Different answer",
    );

    const results = validateContent(ctx.sourceDb, ctx.target.db, 10);
    const accuracyCheck = results.find((r) =>
      r.check.includes("accuracy"),
    );
    expect(accuracyCheck!.passed).toBe(false);
  });

  it("detects missing exchanges", () => {
    insertSourceExchange(
      ctx.sourceDb,
      "e1",
      "/archive/project/conv.jsonl",
      "Hello",
      "World",
    );
    // Don't insert into target

    const results = validateContent(ctx.sourceDb, ctx.target.db, 10);
    const presenceCheck = results.find((r) =>
      r.check.includes("presence"),
    );
    expect(presenceCheck!.passed).toBe(false);
  });
});

describe("validateFTS", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupCtx();
  });

  afterEach(() => {
    cleanupCtx(ctx);
  });

  it("passes FTS integrity check on healthy DB", () => {
    // Insert some data and rebuild FTS
    insertTargetExchange(
      ctx.target.db,
      "e1",
      "conv",
      "How does SQLite FTS5 work?",
      "FTS5 provides full-text search capabilities...",
    );

    // Rebuild FTS from exchanges content
    ctx.target.db.exec(
      "INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')",
    );

    const results = validateFTS(ctx.target.db);
    const integrityCheck = results.find((r) =>
      r.check.includes("integrity"),
    );
    expect(integrityCheck!.passed).toBe(true);
  });

  it("detects FTS search hits", () => {
    // Insert exchanges with distinctive long words
    const messages = [
      "How does authentication middleware work in Express?",
      "What is the difference between PostgreSQL and SQLite databases?",
      "Explain containerization with Docker and Kubernetes orchestration",
      "How do I configure TypeScript compiler options correctly?",
      "Describe the implementation of binary search algorithms",
    ];

    for (let i = 0; i < messages.length; i++) {
      insertTargetExchange(
        ctx.target.db,
        `e-fts-${i}`,
        "conv",
        messages[i],
        `Response about ${messages[i].toLowerCase()}`,
      );
    }

    // Rebuild FTS
    ctx.target.db.exec(
      "INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')",
    );

    const results = validateFTS(ctx.target.db);
    const hitCheck = results.find((r) => r.check.includes("hit rate"));
    // We expect some of the sampled queries to find matches
    expect(hitCheck).toBeDefined();
  });
});

describe("validateSearchQuality", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupCtx();
  });

  afterEach(() => {
    cleanupCtx(ctx);
  });

  it("returns results for reference queries when data exists", () => {
    // Insert exchanges that contain common terms from reference queries
    const contents = [
      ["How do I set up the database?", "You need to configure the database connection..."],
      ["What configuration options are available?", "The configuration file supports..."],
      ["I got an error running the tests", "The error is caused by a missing function..."],
      ["How do I install this project?", "To install the project, run npm install..."],
      ["Read this file for me", "The file contents show the project structure..."],
    ];

    for (let i = 0; i < contents.length; i++) {
      insertTargetExchange(
        ctx.target.db,
        `e-sq-${i}`,
        "conv",
        contents[i][0],
        contents[i][1],
      );
    }

    // Rebuild FTS
    ctx.target.db.exec(
      "INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')",
    );

    const results = validateSearchQuality(ctx.target.db);
    const resultCheck = results.find((r) =>
      r.check.includes("return results"),
    );
    expect(resultCheck).toBeDefined();
    // At least some queries should return results since we have relevant content
    expect(resultCheck!.passed).toBe(true);
  });

  it("fails when no data exists", () => {
    // Empty target DB — no exchanges at all
    const results = validateSearchQuality(ctx.target.db);
    const resultCheck = results.find((r) =>
      r.check.includes("return results"),
    );
    expect(resultCheck!.passed).toBe(false);
  });
});
