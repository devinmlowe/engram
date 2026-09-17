import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createTestDb, type TestDb } from "../helpers.js";
import { initDatabase, CONVERSATIONS_SCOPE_MIGRATION } from "../../src/_core/db/schema.js";
import { loadConfig } from "../../src/_core/config/index.js";
import { upsertConversation, getConversation } from "../../src/episodic/store.js";

// W2: conversations.scope — tenant scope of the conversation's origin so the
// dream extraction phase can stamp extracted memories with it (ADR-010).
describe("conversations scope column (W2)", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it("fresh DB has a scope column defaulting to 'global' and an index", () => {
    const cols = (t.db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("scope");
    t.db.prepare("INSERT INTO conversations (id, project) VALUES ('c1', 'p')").run();
    const row = t.db.prepare("SELECT scope FROM conversations WHERE id = 'c1'").get() as { scope: string };
    expect(row.scope).toBe("global");

    const indexes = (t.db.prepare("PRAGMA index_list(conversations)").all() as Array<{ name: string }>).map(
      (i) => i.name,
    );
    expect(indexes).toContain("idx_conversations_scope");
  });

  it("records the migration checkpoint in schema_migrations", () => {
    const row = t.db
      .prepare("SELECT 1 AS ok FROM schema_migrations WHERE name = ?")
      .get(CONVERSATIONS_SCOPE_MIGRATION) as { ok: number } | undefined;
    expect(row?.ok).toBe(1);
  });

  it("upsertConversation persists scope and getConversation reads it back", () => {
    upsertConversation(t.db, { id: "c-scoped", project: "hermes", exchangeCount: 1, scope: "hermes:career" });
    expect(getConversation(t.db, "c-scoped")?.scope).toBe("hermes:career");

    // Claude Code sync path passes no scope → column default
    upsertConversation(t.db, { id: "c-global", project: "engram", exchangeCount: 1 });
    expect(getConversation(t.db, "c-global")?.scope).toBe("global");
  });
});

describe("conversations scope migration on an existing DB", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "engram-conv-scope-mig-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds the column to a pre-existing conversations table and backfills 'global'", () => {
    // loadConfig derives dbPath from dataDir; put the legacy file where initDatabase will open it
    const dbPath = join(tmpDir, "engram.db");

    // Legacy schema: conversations without scope, plus one row
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        exchange_count INTEGER,
        summary TEXT,
        primary_topics TEXT,
        archive_path TEXT,
        last_indexed INTEGER
      );
      INSERT INTO conversations (id, project, exchange_count) VALUES ('legacy-1', 'old-project', 3);
    `);
    legacy.close();

    const config = loadConfig({ dataDir: tmpDir, dbPath });
    const db = initDatabase(config);
    try {
      const cols = (db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toContain("scope");
      const row = db.prepare("SELECT scope FROM conversations WHERE id = 'legacy-1'").get() as { scope: string };
      expect(row.scope).toBe("global");
      const mig = db
        .prepare("SELECT 1 AS ok FROM schema_migrations WHERE name = ?")
        .get(CONVERSATIONS_SCOPE_MIGRATION) as { ok: number } | undefined;
      expect(mig?.ok).toBe(1);
    } finally {
      db.close();
    }

    // Re-open is a no-op (idempotent)
    const again = initDatabase(config);
    try {
      const n = (
        again.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?").get(CONVERSATIONS_SCOPE_MIGRATION) as { n: number }
      ).n;
      expect(n).toBe(1);
    } finally {
      again.close();
    }
  });
});
