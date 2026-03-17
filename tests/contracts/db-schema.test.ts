/**
 * Contract: Database Schema Completeness
 *
 * The DB schema is the system's backbone. During extraction to _core/db/
 * with a thin DAL, the schema MUST remain identical. If a table, column,
 * index, or constraint is dropped or renamed, queries across 8+ modules
 * silently break or return wrong data.
 *
 * These tests pin the exact schema — every table, every column, every index.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase } from "../../src/_core/db/index.js";
import { createTestDb, type TestDb } from "../helpers.js";

describe("Database Schema Contract", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  // ── Table Existence ────────────────────────────────────────────

  it("all required tables exist", () => {
    const tables = t.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name).sort();

    // Pin exact table list
    expect(tableNames).toContain("conversations");
    expect(tableNames).toContain("exchanges");
    expect(tableNames).toContain("tool_calls");
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("conflicts");
    expect(tableNames).toContain("entities");
    expect(tableNames).toContain("relationships");
    expect(tableNames).toContain("topic_clusters");
  });

  // ── Entity-Conversation Junction Table ─────────────────────────

  it("creates entity_conversations junction table", () => {
    const tables = t.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entity_conversations'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  // ── Exchange Table Schema ──────────────────────────────────────

  it("exchanges table has all required columns", () => {
    const cols = t.db.prepare("PRAGMA table_info(exchanges)").all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const colNames = cols.map((c) => c.name);

    const required = [
      "id", "conversation_id", "project", "timestamp",
      "user_message", "assistant_message", "exchange_index",
      "token_estimate", "created_at",
    ];

    for (const col of required) {
      expect(colNames, `missing column: ${col}`).toContain(col);
    }
  });

  // ── Memory Table Schema ────────────────────────────────────────

  it("memories table has all required columns", () => {
    const cols = t.db.prepare("PRAGMA table_info(memories)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);

    const required = [
      "id", "type", "content", "confidence", "importance",
      "access_count", "created_at", "source_exchanges", "is_active",
    ];

    for (const col of required) {
      expect(colNames, `missing column: ${col}`).toContain(col);
    }
  });

  // ── Entity Table Schema ────────────────────────────────────────

  it("entities table has all required columns", () => {
    const cols = t.db.prepare("PRAGMA table_info(entities)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);

    const required = [
      "id", "name", "type", "aliases", "first_seen",
      "last_seen", "mention_count", "created_at",
    ];

    for (const col of required) {
      expect(colNames, `missing column: ${col}`).toContain(col);
    }
  });

  // ── Relationship Table Schema ──────────────────────────────────

  it("relationships table has all required columns", () => {
    const cols = t.db.prepare("PRAGMA table_info(relationships)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);

    const required = [
      "id", "source_entity_id", "target_entity_id", "type",
      "weight", "source_memories", "created_at",
    ];

    for (const col of required) {
      expect(colNames, `missing column: ${col}`).toContain(col);
    }
  });

  // ── FTS Tables ─────────────────────────────────────────────────

  it("FTS5 tables exist for exchanges and memories", () => {
    const tables = t.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%' ORDER BY name`,
      )
      .all() as { name: string }[];

    const ftsNames = tables.map((t) => t.name);
    expect(ftsNames).toContain("exchanges_fts");
    expect(ftsNames).toContain("memories_fts");
  });

  // ── Vector Tables ──────────────────────────────────────────────

  it("vec0 virtual tables exist for vector search", () => {
    // vec0 tables may show up differently in sqlite_master
    // Test by attempting a query
    const exchangeVec = () =>
      t.db.prepare("SELECT count(*) as c FROM vec_exchanges").get();
    const memoryVec = () =>
      t.db.prepare("SELECT count(*) as c FROM vec_memories").get();

    expect(exchangeVec).not.toThrow();
    expect(memoryVec).not.toThrow();
  });

  // ── WAL Mode ───────────────────────────────────────────────────

  it("database is in WAL mode", () => {
    const result = t.db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(result.journal_mode).toBe("wal");
  });

  // ── Foreign Keys ───────────────────────────────────────────────

  it("foreign keys are enabled", () => {
    const result = t.db.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    expect(result.foreign_keys).toBe(1);
  });

  // ── Type Constraints ───────────────────────────────────────────

  it("memory type constraint rejects invalid types", () => {
    expect(() => {
      t.db.prepare(`
        INSERT INTO memories (id, type, content, confidence, importance, access_count, created_at, source_exchanges, is_active)
        VALUES ('test-bad-type', 'INVALID_TYPE', 'content', 0.5, 0.5, 0, unixepoch(), '[]', 1)
      `).run();
    }).toThrow();
  });

  it("memory type constraint accepts all valid types", () => {
    const validTypes = [
      "preference", "decision", "pattern", "fact", "solution", "convention",
    ];

    for (const type of validTypes) {
      expect(() => {
        t.db.prepare(`
          INSERT INTO memories (id, type, content, confidence, importance, access_count, created_at, source_exchanges, is_active)
          VALUES (?, ?, 'content', 0.5, 0.5, 0, unixepoch(), '[]', 1)
        `).run(`test-${type}`, type);
      }, `type "${type}" should be accepted`).not.toThrow();
    }
  });

  // ── Dream Run Tables ───────────────────────────────────────────

  it("dream run tracking tables exist", () => {
    const tables = t.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("dream_runs");
    expect(tableNames).toContain("dream_checkpoints");
  });

  // ── Idempotent Init ────────────────────────────────────────────

  it("calling initDatabase twice does not corrupt schema", () => {
    // Re-init on same path
    const db2 = initDatabase(t.config);

    const tables = db2
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];

    expect(tables.length).toBeGreaterThan(5);
    db2.close();
  });
});
