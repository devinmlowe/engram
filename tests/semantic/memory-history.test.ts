/**
 * memory_history — trigger-based append-only audit trail over `memories`.
 * Acceptance suite SPEC-001…008 and SPEC-012 (docs/memory-history.md).
 *
 * RED against main @ abf0c28: the table, triggers and helpers do not exist
 * there, so every test fails with "no such table: memory_history", an absent
 * export, or a failed guard — not with a fixture error.
 *
 * Fixtures derive from the real write sites (cited file:line, never invented):
 *   - src/semantic/memory.ts:114 (insert), :208 (update), :237 (supersede),
 *     :288 (recordAccess), :310 (applyContradiction stability)
 *   - src/semantic/forget.ts:367 (soft delete), :403 (hard delete/purge),
 *     :432 (content edit), :456 (restore)
 *   - src/dream/daemon.ts:757 (prune)
 *   - src/interfaces/cli/transfer.ts:529 (import update-in-place)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { createTestDb, type TestDb } from "../helpers.js";
import { deterministicVector as vec } from "../mocks/embeddings.js";
import {
  insertMemory,
  updateMemory,
  deactivateMemory,
  recordAccess,
  applyContradiction,
  getMemory,
  findNearestMemories,
} from "../../src/semantic/memory.js";
import {
  forgetMemory,
  editMemory,
  restoreMemory,
} from "../../src/semantic/forget.js";
import type { Memory } from "../../src/semantic/types.js";
import type Database from "better-sqlite3";

// ─── helpers ─────────────────────────────────────────────────────

/** sha256 hex of the UTF-8 bytes — the exact hash discipline the triggers must match. */
function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

interface HistoryRow {
  id: number;
  memory_id: string;
  mechanism: string;
  before_content: string | null;
  after_content: string | null;
  before_hash: string | null;
  after_hash: string | null;
  actor: string | null;
  at: number;
}

let t: TestDb;

function history(where = "", ...params: unknown[]): HistoryRow[] {
  return t.db
    .prepare(`SELECT * FROM memory_history ${where}`)
    .all(...params) as HistoryRow[];
}

function historyCount(): number {
  return (
    t.db.prepare("SELECT COUNT(*) AS n FROM memory_history").get() as { n: number }
  ).n;
}

function seed(id = "mem-1", content = "TypeScript uses structural typing"): Memory {
  const memory: Memory = {
    id,
    type: "fact",
    content,
    confidence: 0.9,
    importance: 0.7,
    accessCount: 0,
    createdAt: Math.floor(Date.now() / 1000),
    sourceExchanges: [],
    isActive: true,
    source: "user",
    scope: "global",
  };
  insertMemory(t.db, memory, vec(`doc:${content}`));
  return memory;
}

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

// ─── SPEC-001: migration idempotence + provable no-op ────────────

describe("SPEC-001 migration idempotence + provable no-op", () => {
  it("creates memory_history with the adjudicated baseline schema", () => {
    const cols = t.db
      .prepare("PRAGMA table_info(memory_history)")
      .all() as Array<{ name: string; type: string; notnull: number; pk: number; dflt_value: string | null }>;
    // The table must exist at all (guards vacuous pass on main)
    expect(cols.length).toBe(9);
    expect(cols.map((c) => c.name)).toEqual([
      "id", "memory_id", "mechanism",
      "before_content", "after_content", "before_hash", "after_hash",
      "actor", "at",
    ]);
    const by = Object.fromEntries(cols.map((c) => [c.name, c])) as Record<string, { type: string; notnull: number; pk: number; dflt_value: string | null }>;
    expect(by.id.type).toBe("INTEGER");
    expect(by.id.pk).toBe(1);
    expect(by.memory_id.notnull).toBe(1);
    expect(by.mechanism.notnull).toBe(1);
    expect(by.before_content.notnull).toBe(0);
    expect(by.after_hash.notnull).toBe(0);
    expect(by.actor.notnull).toBe(0); // nullable: triggers cannot see app state
    expect(by.at.type).toBe("INTEGER");
    expect(by.at.notnull).toBe(1);
    expect(String(by.at.dflt_value)).toMatch(/unixepoch/i);
  });

  it("enforces the mechanism CHECK domain", () => {
    expect(() =>
      t.db
        .prepare("INSERT INTO memory_history (memory_id, mechanism) VALUES ('x', 'bogus')")
        .run(),
    ).toThrow(/CHECK/i);
    t.db
      .prepare("INSERT INTO memory_history (memory_id, mechanism) VALUES ('x', 'insert')")
      .run();
    expect(history("WHERE memory_id = 'x'")).toHaveLength(1);
  });

  it("records the memory_history_v1 checkpoint and keeps it additive (not breaking)", async () => {
    const schema = await import("../../src/_core/db/schema.js");
    const {
      MEMORY_HISTORY_MIGRATION,
      SCHEMA_MIGRATIONS,
      SCHEMA_VERSION,
      BREAKING_MIGRATIONS,
    } = schema as Record<string, unknown> as {
      MEMORY_HISTORY_MIGRATION: string;
      SCHEMA_MIGRATIONS: readonly string[];
      SCHEMA_VERSION: number;
      BREAKING_MIGRATIONS: ReadonlySet<string>;
    };
    expect(MEMORY_HISTORY_MIGRATION).toBe("memory_history_v1");
    expect(SCHEMA_MIGRATIONS).toContain(MEMORY_HISTORY_MIGRATION);
    expect(SCHEMA_VERSION).toBe(SCHEMA_MIGRATIONS.length); // the list IS the schema version
    expect(BREAKING_MIGRATIONS.has(MEMORY_HISTORY_MIGRATION)).toBe(false); // purely additive
    const cp = t.db
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?")
      .get(MEMORY_HISTORY_MIGRATION) as { n: number };
    expect(cp.n).toBe(1);
  });

  it("creates the three capture triggers on memories and the two block triggers on memory_history", () => {
    const trig = t.db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_history%'")
      .all() as Array<{ name: string; tbl_name: string }>;
    expect(trig.map((r) => r.name).sort()).toEqual([
      "memory_history_no_delete",
      "memory_history_no_update",
      "memory_history_on_delete",
      "memory_history_on_insert",
      "memory_history_on_update",
    ]);
    expect(trig.filter((r) => r.tbl_name === "memories")).toHaveLength(3);
    expect(trig.filter((r) => r.tbl_name === "memory_history")).toHaveLength(2);
  });

  it("is idempotent: a re-open of the same database is a provable no-op", async () => {
    const schema = await import("../../src/_core/db/schema.js");
    const { migrateMemoryHistory, MEMORY_HISTORY_MIGRATION } = schema as Record<string, unknown> as {
      migrateMemoryHistory: (db: Database.Database) => boolean;
      MEMORY_HISTORY_MIGRATION: string;
    };
    expect(MEMORY_HISTORY_MIGRATION).toBe("memory_history_v1");
    expect(typeof migrateMemoryHistory).toBe("function");
    // createTestDb already migrated on open: a direct call must be a no-op
    expect(migrateMemoryHistory(t.db)).toBe(false);

    const triggersBefore = (
      t.db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_history%'")
        .get() as { n: number }
    ).n;

    // Re-open the same file through the normal init path (WAL: second connection)
    const { initDatabase } = await import("../../src/_core/db/index.js");
    const db2 = initDatabase(t.config);
    try {
      const cp = db2
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?")
        .get(MEMORY_HISTORY_MIGRATION) as { n: number };
      expect(cp.n).toBe(1); // checkpoint not duplicated
      const triggersAfter = (
        db2
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_history%'")
          .get() as { n: number }
      ).n;
      expect(triggersAfter).toBe(triggersBefore); // no duplicated/recreated triggers
      expect(migrateMemoryHistory(db2)).toBe(false); // provable no-op on re-open
      expect(
        (db2.prepare("SELECT COUNT(*) AS n FROM memory_history").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      db2.close();
    }
  });
});

// ─── SPEC-002: insert row w/ after_hash = sha256(after_content) ──

describe("SPEC-002 insert records after_content + after_hash = sha256(after_content)", () => {
  it("fires on insertMemory (src/semantic/memory.ts:114) with sentinel actor and a plausible unix timestamp", () => {
    // Non-ASCII pins UTF-8 hashing (a latin1 or UTF-16 digest must fail here)
    const content = "Engram préfère le café ☕ — naïve hashing misses encoding";
    seed("mem-ins", content);
    const rows = history("WHERE memory_id = ? AND mechanism = 'insert'", "mem-ins");
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.after_content).toBe(content);
    expect(r.after_hash).toBe(sha256(content));
    expect(r.before_content).toBeNull();
    expect(r.before_hash).toBeNull();
    expect(r.actor).toBe("unknown"); // insert path carries no actor context
    expect(r.at).toBeGreaterThan(1_700_000_000);
    expect(typeof r.id).toBe("number");
  });
});

// ─── SPEC-003: edit — before/after content AND hashes ────────────

describe("SPEC-003 edit records before AND after content and hashes", () => {
  it("editMemory (src/semantic/forget.ts:432) records both sides with both hashes", () => {
    const before = "Retention defaults to thirty days";
    const after = "Retention defaults to 30 days";
    seed("mem-ed", before);
    editMemory(t.db, {
      memoryId: "mem-ed",
      content: after,
      embedding: vec(`doc:${after}`),
      actor: "cli",
      now: new Date("2026-09-17T10:00:00Z"),
    });
    const rows = history("WHERE memory_id = ? AND mechanism = 'edit'", "mem-ed");
    expect(rows).toHaveLength(1);
    expect(rows[0].before_content).toBe(before);
    expect(rows[0].after_content).toBe(after);
    expect(rows[0].before_hash).toBe(sha256(before));
    expect(rows[0].after_hash).toBe(sha256(after));
  });

  it("updateMemory with a content change (src/semantic/memory.ts:208) is an edit too", () => {
    seed("mem-upd", "old text");
    updateMemory(t.db, "mem-upd", { content: "new text" });
    const rows = history("WHERE memory_id = ? AND mechanism = 'edit'", "mem-upd");
    expect(rows).toHaveLength(1);
    expect(rows[0].before_hash).toBe(sha256("old text"));
    expect(rows[0].after_hash).toBe(sha256("new text"));
  });
});

// ─── SPEC-004: soft delete → 'forget' ────────────────────────────

describe("SPEC-004 soft delete records mechanism 'forget'", () => {
  it("forgetMemory soft (src/semantic/forget.ts:367): before content + hash, after absent, memories row kept", () => {
    const content = "Forgotten fact about launchd environment";
    seed("mem-fg", content);
    forgetMemory(t.db, {
      memoryId: "mem-fg",
      actor: "claude-code",
      now: new Date("2026-09-17T11:00:00Z"),
    });
    const rows = history("WHERE memory_id = ? AND mechanism = 'forget'", "mem-fg");
    expect(rows).toHaveLength(1);
    expect(rows[0].before_content).toBe(content);
    expect(rows[0].before_hash).toBe(sha256(content));
    expect(rows[0].after_content).toBeNull();
    expect(rows[0].after_hash).toBeNull();
    // Soft delete keeps the memories row (decision #56) — only the flag flips
    const mem = t.db
      .prepare("SELECT is_active, deleted_at FROM memories WHERE id = 'mem-fg'")
      .get() as { is_active: number; deleted_at: string | null };
    expect(mem.is_active).toBe(0);
    expect(mem.deleted_at).not.toBeNull();
  });

  it("deactivateMemory supersede (src/semantic/memory.ts:237) records a forget — the is_active flip", () => {
    seed("mem-sup", "superseded convention");
    deactivateMemory(t.db, "mem-sup", "mem-newer");
    const rows = history("WHERE memory_id = ? AND mechanism = 'forget'", "mem-sup");
    expect(rows).toHaveLength(1);
    expect(rows[0].after_content).toBeNull();
    expect(rows[0].before_content).toBe("superseded convention");
  });
});

// ─── SPEC-005: purge + absent-content convention ─────────────────

describe("SPEC-005 purge records mechanism 'purge' with the absent-content convention", () => {
  it("hard forget (DELETE, src/semantic/forget.ts:403) records purge: before content + hash, after NULL/NULL", () => {
    const content = "Purge me after retention";
    seed("mem-pg", content);
    forgetMemory(t.db, {
      memoryId: "mem-pg",
      actor: "cli",
      hard: true,
      now: new Date("2026-09-17T12:00:00Z"),
    });
    const rows = history("WHERE memory_id = ? AND mechanism = 'purge'", "mem-pg");
    expect(rows).toHaveLength(1);
    expect(rows[0].before_content).toBe(content);
    expect(rows[0].before_hash).toBe(sha256(content));
    expect(rows[0].after_content).toBeNull();
    expect(rows[0].after_hash).toBeNull();
    // The hard path also logged the soft forget on the way by
    expect(history("WHERE memory_id = ? AND mechanism = 'forget'", "mem-pg")).toHaveLength(1);
    // …and the memories row is gone (that is what makes it a purge)
    expect(t.db.prepare("SELECT 1 FROM memories WHERE id = 'mem-pg'").get()).toBeUndefined();
  });

  it("absent content ⇔ absent hash, deterministically: NULL, never '' and never sha256('')", () => {
    seed("mem-conv", "convention probe");
    const ins = history("WHERE memory_id = 'mem-conv' AND mechanism = 'insert'")[0];
    expect(ins.before_content).toBeNull();
    expect(ins.before_hash).toBeNull();
    expect(ins.before_hash).not.toBe("");
    expect(ins.before_hash).not.toBe(sha256(""));
    forgetMemory(t.db, { memoryId: "mem-conv", actor: "cli", now: new Date("2026-09-17T12:30:00Z") });
    const fg = history("WHERE memory_id = 'mem-conv' AND mechanism = 'forget'")[0];
    expect(fg.after_content).toBeNull();
    expect(fg.after_hash).toBeNull();
    expect(fg.after_hash).not.toBe("");
    expect(fg.after_hash).not.toBe(sha256(""));
  });
});

// ─── SPEC-006: restore ───────────────────────────────────────────

describe("SPEC-006 restore records mechanism 'restore'", () => {
  it("restoreMemory (src/semantic/forget.ts:456): before absent, after content + hash", () => {
    const content = "Restored after an accidental forget";
    seed("mem-rs", content);
    forgetMemory(t.db, { memoryId: "mem-rs", actor: "cli", now: new Date("2026-09-17T13:00:00Z") });
    restoreMemory(t.db, {
      memoryId: "mem-rs",
      embedding: vec(`doc:${content}`),
      actor: "mcp-client",
      now: new Date("2026-09-17T14:00:00Z"),
    });
    const rows = history("WHERE memory_id = ? AND mechanism = 'restore'", "mem-rs");
    expect(rows).toHaveLength(1);
    expect(rows[0].before_content).toBeNull();
    expect(rows[0].before_hash).toBeNull();
    expect(rows[0].after_content).toBe(content);
    expect(rows[0].after_hash).toBe(sha256(content));
  });
});

// ─── SPEC-007: append-only enforcement ───────────────────────────

describe("SPEC-007 UPDATE/DELETE on memory_history abort (append-only)", () => {
  it("UPDATE of a history row aborts with an append-only message and changes nothing", () => {
    seed("mem-ao", "audit target");
    const rows = history("WHERE memory_id = 'mem-ao'");
    expect(rows.length).toBeGreaterThan(0);
    expect(() =>
      t.db
        .prepare("UPDATE memory_history SET actor = 'attacker' WHERE id = ?")
        .run(rows[0].id),
    ).toThrow(/append-only/i);
    expect(history("WHERE memory_id = 'mem-ao'")[0].actor).toBe(rows[0].actor);
  });

  it("DELETE of a history row aborts the same way and the row survives", () => {
    seed("mem-ao2", "audit target 2");
    const rows = history();
    expect(rows.length).toBeGreaterThan(0);
    expect(() =>
      t.db.prepare("DELETE FROM memory_history WHERE id = ?").run(rows[0].id),
    ).toThrow(/append-only/i);
    expect(historyCount()).toBe(rows.length);
  });
});

// ─── SPEC-008: actor stamping ────────────────────────────────────

describe("SPEC-008 actor stamping — non-sentinel on app paths, sentinel fallback, never fabricated", () => {
  it("app paths stamp the actor they were given (forget / restore / edit)", () => {
    seed("mem-a1", "actor probe");
    forgetMemory(t.db, { memoryId: "mem-a1", actor: "claude-code", now: new Date("2026-09-17T15:00:00Z") });
    expect(history("WHERE memory_id = 'mem-a1' AND mechanism = 'forget'")[0].actor).toBe("claude-code");
    restoreMemory(t.db, {
      memoryId: "mem-a1",
      embedding: vec("doc:actor probe"),
      actor: "mcp-client",
      now: new Date("2026-09-17T15:30:00Z"),
    });
    expect(history("WHERE memory_id = 'mem-a1' AND mechanism = 'restore'")[0].actor).toBe("mcp-client");
    editMemory(t.db, {
      memoryId: "mem-a1",
      content: "actor probe v2",
      embedding: vec("doc:actor probe v2"),
      actor: "cli",
      now: new Date("2026-09-17T16:00:00Z"),
    });
    expect(history("WHERE memory_id = 'mem-a1' AND mechanism = 'edit'")[0].actor).toBe("cli");
  });

  it("context-free writes stamp the sentinel 'unknown' (dream prune statement, src/dream/daemon.ts:757)", () => {
    seed("mem-a2", "prune candidate");
    // The exact statement the dream prune phase runs — no actor context exists there
    t.db.prepare("UPDATE memories SET is_active = 0 WHERE id = ?").run("mem-a2");
    const rows = history("WHERE memory_id = 'mem-a2' AND mechanism = 'forget'");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("unknown");
  });

  it("never fabricates: a prior app-path actor does not leak into a later context-free write", () => {
    seed("mem-a3", "leak probe");
    forgetMemory(t.db, { memoryId: "mem-a3", actor: "claude-code", now: new Date("2026-09-17T17:00:00Z") });
    // A different memory, same connection, written with no actor context
    seed("mem-a4", "leak probe 2");
    t.db.prepare("UPDATE memories SET is_active = 0 WHERE id = ?").run("mem-a4");
    const rows = history("WHERE memory_id = 'mem-a4' AND mechanism = 'forget'");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("unknown");
    expect(rows[0].actor).not.toBe("claude-code");
  });
});

// ─── SPEC-012: zero recall-path behavior change ──────────────────

describe("SPEC-012 zero recall-path behavior change with triggers active", () => {
  it("recall reinforcement (recordAccess :288, applyContradiction :310) writes NO history rows and still works", () => {
    seed("mem-rec", "recall me");
    const n = historyCount();
    recordAccess(t.db, "mem-rec");
    applyContradiction(t.db, "mem-rec");
    expect(historyCount()).toBe(n); // metadata-only: the trail records corrections, not access bumps
    // Pre-existing behavior preserved with triggers active
    const mem = getMemory(t.db, "mem-rec")!;
    expect(mem.accessCount).toBe(1);
    expect(mem.isActive).toBe(true);
  });

  it("metadata-only updateMemory (confidence) leaves no history row; vector recall still finds the memory", () => {
    seed("mem-meta", "vector target");
    const n = historyCount();
    updateMemory(t.db, "mem-meta", { confidence: 0.95 });
    expect(historyCount()).toBe(n);
    const hits = findNearestMemories(t.db, vec("doc:vector target"), 5);
    expect(hits.some((h) => h.id === "mem-meta")).toBe(true);
    expect(getMemory(t.db, "mem-meta")!.confidence).toBe(0.95);
  });

  it("the transfer import update (src/interfaces/cli/transfer.ts:529) is captured by the trigger alone — no app change", () => {
    seed("mem-tr", "imported v1");
    // The full-column UPDATE transfer.ts:529 issues, verbatim shape
    t.db
      .prepare(
        `UPDATE memories SET
           type = ?, content = ?, context = ?, confidence = ?, importance = ?,
           access_count = ?, last_accessed = ?, created_at = ?, updated_at = ?,
           source_exchanges = ?, superseded_by = ?, is_active = ?, source = ?,
           scope = ?, stability = ?, event_ts = ?, extraction_basis = ?
         WHERE id = ?`,
      )
      .run("fact", "imported v2", null, 0.9, 0.5, 0, null, 1_758_000_000, null, "[]", null, 1, "import", "global", null, null, "observed", "mem-tr");
    const rows = history("WHERE memory_id = 'mem-tr' AND mechanism = 'edit'");
    expect(rows).toHaveLength(1);
    expect(rows[0].before_content).toBe("imported v1");
    expect(rows[0].after_content).toBe("imported v2");
    expect(rows[0].after_hash).toBe(sha256("imported v2"));
    // An import that changes nothing substantive records nothing (idempotent re-import)
    const n = historyCount();
    t.db
      .prepare(
        `UPDATE memories SET
           type = ?, content = ?, context = ?, confidence = ?, importance = ?,
           access_count = ?, last_accessed = ?, created_at = ?, updated_at = ?,
           source_exchanges = ?, superseded_by = ?, is_active = ?, source = ?,
           scope = ?, stability = ?, event_ts = ?, extraction_basis = ?
         WHERE id = ?`,
      )
      .run("fact", "imported v2", null, 0.9, 0.5, 0, null, 1_758_000_000, null, "[]", null, 1, "import", "global", null, null, "observed", "mem-tr");
    expect(historyCount()).toBe(n);
  });

  it("history rows are transactional: a rolled-back edit leaves no row", () => {
    seed("mem-tx", "durable text");
    const n = historyCount();
    t.db.exec("BEGIN");
    t.db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("ghost edit", "mem-tx");
    t.db.exec("ROLLBACK");
    expect(historyCount()).toBe(n);
    expect(getMemory(t.db, "mem-tx")!.content).toBe("durable text");
  });
});
