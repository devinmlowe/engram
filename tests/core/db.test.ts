import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, rebuildFts } from "../../src/_core/db/index.js";
import { loadConfig } from "../../src/_core/config/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";

describe("Database Schema", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "engram-test-"));
    const config = loadConfig({
      dataDir: tmpDir,
      dbPath: join(tmpDir, "test.db"),
    });
    db = initDatabase(config);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates all required tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);

    // Core tables
    expect(tableNames).toContain("exchanges");
    expect(tableNames).toContain("tool_calls");
    expect(tableNames).toContain("conversations");
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("conflicts");
    expect(tableNames).toContain("entities");
    expect(tableNames).toContain("relationships");
    expect(tableNames).toContain("topic_clusters");
    expect(tableNames).toContain("dream_runs");
    expect(tableNames).toContain("dream_checkpoints");

    // FTS5 tables
    expect(tableNames).toContain("exchanges_fts");
    expect(tableNames).toContain("memories_fts");

    // Vector tables
    expect(tableNames).toContain("vec_exchanges");
    expect(tableNames).toContain("vec_memories");
    expect(tableNames).toContain("vec_entities");
  });

  it("is idempotent — safe to call initDatabase twice", () => {
    const config = loadConfig({
      dataDir: tmpDir,
      dbPath: join(tmpDir, "test.db"),
    });
    // Should not throw
    const db2 = initDatabase(config);
    db2.close();
  });

  it("uses WAL journal mode", () => {
    const result = db.pragma("journal_mode") as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe("wal");
  });

  it("can insert and retrieve an exchange", () => {
    db.prepare(`
      INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-001",
      "conv-001",
      "test-project",
      "2026-02-25T10:00:00Z",
      "How does SQLite WAL work?",
      "WAL (Write-Ahead Logging) is a journaling mode...",
      0,
      150,
    );

    const row = db
      .prepare("SELECT * FROM exchanges WHERE id = ?")
      .get("test-001") as Record<string, unknown>;
    expect(row.project).toBe("test-project");
    expect(row.user_message).toBe("How does SQLite WAL work?");
  });

  it("can insert and retrieve a semantic memory", () => {
    db.prepare(`
      INSERT INTO memories (id, type, content, confidence, importance, source_exchanges)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "mem-001",
      "preference",
      "User prefers Fish shell for all terminal commands",
      0.9,
      0.8,
      JSON.stringify(["exch-001", "exch-042"]),
    );

    const row = db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get("mem-001") as Record<string, unknown>;
    expect(row.type).toBe("preference");
    expect(row.confidence).toBe(0.9);
  });

  it("can insert and query entities and relationships", () => {
    db.prepare(`
      INSERT INTO entities (id, name, type, mention_count)
      VALUES (?, ?, ?, ?)
    `).run("ent-001", "SQLite", "technology", 15);

    db.prepare(`
      INSERT INTO entities (id, name, type, mention_count)
      VALUES (?, ?, ?, ?)
    `).run("ent-002", "better-sqlite3", "tool", 8);

    db.prepare(`
      INSERT INTO relationships (id, source_entity_id, target_entity_id, type, weight, source_memories)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "rel-001",
      "ent-002",
      "ent-001",
      "depends_on",
      1.0,
      JSON.stringify(["mem-001"]),
    );

    const rels = db
      .prepare(
        "SELECT * FROM relationships WHERE source_entity_id = ?",
      )
      .all("ent-002") as Record<string, unknown>[];
    expect(rels).toHaveLength(1);
    expect(rels[0].type).toBe("depends_on");
  });

  it("enforces memory type constraint", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO memories (id, type, content) VALUES (?, ?, ?)",
        )
        .run("mem-bad", "invalid_type", "test"),
    ).toThrow();
  });

  it("FTS5 rebuild works after insert", () => {
    db.prepare(`
      INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "fts-test-001",
      "conv-fts",
      "fts-project",
      "2026-02-25T12:00:00Z",
      "Tell me about Zettelkasten note-taking",
      "Zettelkasten is a method of personal knowledge management...",
      0,
      200,
    );

    rebuildFts(db, "exchanges_fts");

    const results = db
      .prepare(
        "SELECT * FROM exchanges_fts WHERE exchanges_fts MATCH ?",
      )
      .all("zettelkasten") as Record<string, unknown>[];
    expect(results).toHaveLength(1);
  });
});
