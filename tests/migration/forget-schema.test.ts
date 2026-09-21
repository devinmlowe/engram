import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import {
  migrateForget,
  migrateSuppressionsScope,
  FORGET_MIGRATION,
  SUPPRESSIONS_SCOPE_MIGRATION,
  MEMORY_CHANGE_OPS,
} from "../../src/_core/db/schema.js";
import { loadConfig, parseRetentionDays, DEFAULT_FORGET_RETENTION_DAYS } from "../../src/_core/config/index.js";

// #55: forget tool + memory inspection surface — schema and config.
describe("forget_v1 schema migration (#55)", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  function columns(table: string): string[] {
    return (t.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  }

  it("adds deleted_at / deleted_by to memories and stale_since to entities and relationships", () => {
    expect(columns("memories")).toEqual(expect.arrayContaining(["deleted_at", "deleted_by"]));
    expect(columns("entities")).toContain("stale_since");
    expect(columns("relationships")).toContain("stale_since");
    const indexes = (t.db.prepare("PRAGMA index_list(memories)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toContain("idx_memories_deleted_at");
  });

  it("creates memory_changes with the four ops and memory_suppressions keyed by content hash", () => {
    expect(columns("memory_changes")).toEqual(["id", "memory_id", "op", "before", "after", "actor", "at"]);
    expect(columns("memory_suppressions")).toEqual(["content_hash", "memory_id", "scope", "created_at"]);
    expect([...MEMORY_CHANGE_OPS]).toEqual(["forget", "edit", "purge", "restore"]);

    for (const op of MEMORY_CHANGE_OPS) {
      t.db
        .prepare("INSERT INTO memory_changes (id, memory_id, op, before, after, actor, at) VALUES (?, 'm', ?, 'b', 'a', 'cli', '2026-09-17T00:00:00Z')")
        .run(`c-${op}`, op);
    }
    expect(() =>
      t.db
        .prepare("INSERT INTO memory_changes (id, memory_id, op, actor, at) VALUES ('bad', 'm', 'nuke', 'cli', 'now')")
        .run(),
    ).toThrow(/CHECK/);

    t.db.prepare("INSERT INTO memory_suppressions (content_hash, memory_id, scope, created_at) VALUES ('h', 'm', 'global', 'now')").run();
    expect(() =>
      t.db.prepare("INSERT INTO memory_suppressions (content_hash, memory_id, scope, created_at) VALUES ('h', 'm2', 'global', 'now')").run(),
    ).toThrow(/UNIQUE|PRIMARY/);
    // #106: keyed by (content_hash, scope) — another tenant's row coexists.
    t.db.prepare("INSERT INTO memory_suppressions (content_hash, memory_id, scope, created_at) VALUES ('h', 'm3', 'hermes:x', 'now')").run();
    expect(t.db.prepare("SELECT count(*) AS n FROM memory_suppressions WHERE content_hash = 'h'").get()).toEqual({ n: 2 });
  });

  // #106: a 0.4.0 database keyed on content_hash alone is rebuilt with the composite key, rows kept.
  it("suppressions_scope_v1 rebuilds a content_hash-keyed table and keeps its rows", () => {
    t.db.exec(`
      DROP TABLE memory_suppressions;
      CREATE TABLE memory_suppressions (content_hash TEXT PRIMARY KEY, memory_id TEXT, scope TEXT DEFAULT 'global', created_at TEXT NOT NULL);
      INSERT INTO memory_suppressions VALUES ('h1', 'm1', 'hermes:career', 'now'), ('h2', 'm2', NULL, 'now');
      DELETE FROM schema_migrations WHERE name = '${SUPPRESSIONS_SCOPE_MIGRATION}';
    `);
    expect(migrateSuppressionsScope(t.db)).toBe(true);
    expect(migrateSuppressionsScope(t.db)).toBe(false);
    expect(t.db.prepare("SELECT content_hash, scope FROM memory_suppressions ORDER BY content_hash").all()).toEqual([
      { content_hash: "h1", scope: "hermes:career" },
      { content_hash: "h2", scope: "global" },
    ]);
    t.db.prepare("INSERT INTO memory_suppressions (content_hash, memory_id, scope, created_at) VALUES ('h1', 'm3', 'global', 'now')").run();
    expect(t.db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(SUPPRESSIONS_SCOPE_MIGRATION)).toBeDefined();
  });

  it("records the checkpoint and is a no-op on re-open", () => {
    const row = t.db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(FORGET_MIGRATION);
    expect(row).toBeDefined();
    expect(migrateForget(t.db)).toBe(false);
    expect(columns("memories").filter((c) => c === "deleted_at")).toHaveLength(1);
  });
});

describe("ENGRAM_FORGET_RETENTION_DAYS (#56)", () => {
  const saved = process.env.ENGRAM_FORGET_RETENTION_DAYS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENGRAM_FORGET_RETENTION_DAYS;
    else process.env.ENGRAM_FORGET_RETENTION_DAYS = saved;
  });

  it("defaults to 30 days", () => {
    delete process.env.ENGRAM_FORGET_RETENTION_DAYS;
    expect(DEFAULT_FORGET_RETENTION_DAYS).toBe(30);
    expect(loadConfig().forget.retentionDays).toBe(30);
  });

  it("accepts 0 (purge on the next prune) and ignores garbage", () => {
    process.env.ENGRAM_FORGET_RETENTION_DAYS = "0";
    expect(loadConfig().forget.retentionDays).toBe(0);
    process.env.ENGRAM_FORGET_RETENTION_DAYS = "7";
    expect(loadConfig().forget.retentionDays).toBe(7);
    expect(parseRetentionDays("-1", 30)).toBe(30);
    expect(parseRetentionDays("abc", 30)).toBe(30);
    expect(parseRetentionDays("", 30)).toBe(30);
  });
});
