/**
 * memories.event_ts — schema migration, one-time backfill, and write-path
 * maintenance for event-time ("about when") recall.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, backfillEventTs } from "../../src/_core/db/index.js";
import { insertMemory, updateMemory, resolveEventTs, getMemory } from "../../src/semantic/memory.js";
import { resolveSourceExchangeIds } from "../../src/semantic/extractor.js";
import { createTestDb, type TestDb } from "../helpers.js";
import type { Memory } from "../../src/semantic/types.js";

let t: TestDb;

const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function seedExchange(id: string, timestamp: string, index = 0) {
  t.db
    .prepare(
      `INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index)
       VALUES (?, 'conv-1', 'proj', ?, 'u', 'a', ?)`,
    )
    .run(id, timestamp, index);
}

/** Raw insert bypassing insertMemory so event_ts stays NULL (legacy rows). */
function rawMemory(id: string, sourceExchanges: string | null, content = `content of ${id}`) {
  t.db
    .prepare(
      `INSERT INTO memories (id, type, content, created_at, source_exchanges)
       VALUES (?, 'fact', ?, ?, ?)`,
    )
    .run(id, content, epoch("2026-05-01T00:00:00Z"), sourceExchanges);
}

function mem(id: string, sourceExchanges: string[] = []): Memory {
  return {
    id,
    type: "fact",
    content: `memory ${id}`,
    confidence: 0.5,
    importance: 0.5,
    accessCount: 0,
    createdAt: epoch("2026-05-01T00:00:00Z"),
    sourceExchanges,
    isActive: true,
  };
}

const vec = () => Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0));

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

describe("schema", () => {
  it("memories has event_ts and both temporal indexes", () => {
    const cols = (t.db.pragma("table_info(memories)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("event_ts");
    const idx = (t.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain("idx_memories_created_at");
    expect(idx).toContain("idx_memories_event_ts");
  });

  it("upgrading a pre-event_ts database adds the column, indexes, and backfills once", () => {
    // Simulate the old schema on a populated store, then reopen through initDatabase
    seedExchange("ex-1", "2026-03-10T12:00:00Z");
    t.db.exec("DROP INDEX idx_memories_event_ts");
    t.db.exec("ALTER TABLE memories DROP COLUMN event_ts");
    rawMemory("legacy-resolvable", '["ex-1"]');
    rawMemory("legacy-index-style", '["0","1"]');
    const before = t.db.prepare("SELECT id, content FROM memories ORDER BY id").all();
    t.db.close();

    const db = initDatabase(t.config);
    try {
      const cols = (db.pragma("table_info(memories)") as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("event_ts");
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'").all() as Array<{ name: string }>).map((r) => r.name);
      expect(idx).toContain("idx_memories_event_ts");

      const rows = db.prepare("SELECT id, content, event_ts FROM memories ORDER BY id").all() as Array<{ id: string; content: string; event_ts: number | null }>;
      expect(rows.map(({ id, content }) => ({ id, content }))).toEqual(before);
      expect(rows.find((r) => r.id === "legacy-resolvable")!.event_ts).toBe(epoch("2026-03-10T12:00:00Z"));
      expect(rows.find((r) => r.id === "legacy-index-style")!.event_ts).toBeNull();
    } finally {
      db.close();
      // createTestDb's cleanup closes t.db again; make that a no-op
      t.db = db;
    }
  });
});

describe("backfillEventTs", () => {
  it("is transactional, idempotent, content-neutral, and only fills resolvable rows", () => {
    seedExchange("ex-1", "2026-03-12T12:00:00Z");
    seedExchange("ex-2", "2026-03-10T09:00:00Z");
    rawMemory("m-two-sources", '["ex-1","ex-2"]'); // earliest wins
    rawMemory("m-legacy", '["3","4","5"]'); // model indexes, not ids
    rawMemory("m-none", null);
    rawMemory("m-empty", "[]");
    rawMemory("m-badjson", "not json");
    rawMemory("m-object", '{"a":1}');

    const countBefore = (t.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
    const contentBefore = t.db.prepare("SELECT id, content, source_exchanges, created_at FROM memories ORDER BY id").all();

    expect(backfillEventTs(t.db)).toBe(1);

    const rows = t.db.prepare("SELECT id, event_ts FROM memories ORDER BY id").all() as Array<{ id: string; event_ts: number | null }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.event_ts]));
    expect(byId["m-two-sources"]).toBe(epoch("2026-03-10T09:00:00Z"));
    for (const id of ["m-legacy", "m-none", "m-empty", "m-badjson", "m-object"]) {
      expect(byId[id]).toBeNull();
    }

    expect((t.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n).toBe(countBefore);
    expect(t.db.prepare("SELECT id, content, source_exchanges, created_at FROM memories ORDER BY id").all()).toEqual(contentBefore);

    // Re-run: nothing left to do, nothing rewritten
    expect(backfillEventTs(t.db)).toBe(0);
  });
});

describe("write path keeps event_ts fresh", () => {
  it("insertMemory derives event_ts from the earliest source exchange", () => {
    seedExchange("ex-late", "2026-04-02T00:00:00Z");
    seedExchange("ex-early", "2026-04-01T00:00:00Z");
    insertMemory(t.db, mem("m-1", ["ex-late", "ex-early"]), vec());
    expect(getMemory(t.db, "m-1")!.eventTs).toBe(epoch("2026-04-01T00:00:00Z"));
  });

  it("insertMemory leaves event_ts NULL when nothing resolves", () => {
    insertMemory(t.db, mem("m-2", []), vec());
    insertMemory(t.db, mem("m-3", ["7", "8"]), vec());
    expect(getMemory(t.db, "m-2")!.eventTs).toBeUndefined();
    expect(getMemory(t.db, "m-3")!.eventTs).toBeUndefined();
  });

  it("insertMemory honours an explicit eventTs", () => {
    insertMemory(t.db, { ...mem("m-4"), eventTs: 1_700_000_000 }, vec());
    expect(getMemory(t.db, "m-4")!.eventTs).toBe(1_700_000_000);
  });

  it("updateMemory recomputes event_ts when sourceExchanges change", () => {
    seedExchange("ex-a", "2026-01-05T00:00:00Z");
    seedExchange("ex-b", "2026-02-05T00:00:00Z");
    insertMemory(t.db, mem("m-5", ["ex-b"]), vec());
    expect(getMemory(t.db, "m-5")!.eventTs).toBe(epoch("2026-02-05T00:00:00Z"));

    updateMemory(t.db, "m-5", { sourceExchanges: ["ex-a", "ex-b"] });
    expect(getMemory(t.db, "m-5")!.eventTs).toBe(epoch("2026-01-05T00:00:00Z"));

    updateMemory(t.db, "m-5", { sourceExchanges: [] });
    expect(getMemory(t.db, "m-5")!.eventTs).toBeUndefined();
  });

  it("resolveEventTs returns null for empty or unknown ids", () => {
    expect(resolveEventTs(t.db, [])).toBeNull();
    expect(resolveEventTs(t.db, undefined)).toBeNull();
    expect(resolveEventTs(t.db, ["nope"])).toBeNull();
  });
});

describe("extractor source references", () => {
  it("maps model-emitted exchange indexes to stored ids and drops unknowns", () => {
    const idByIndex = new Map<number, string>([
      [0, "ex-aaa"],
      [2, "ex-ccc"],
    ]);
    expect(resolveSourceExchangeIds(["0", "2", "9", "zzz", "ex-ccc", "0"], idByIndex)).toEqual([
      "ex-aaa",
      "ex-ccc",
    ]);
    expect(resolveSourceExchangeIds([], idByIndex)).toEqual([]);
  });
});
