/**
 * Temporal recall integration: after/before on the semantic store (both
 * candidate paths), filed vs event basis, anniversary matching on both
 * stores, and dateHint resolution + transparency through unifiedSearch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchSemantic } from "../../src/semantic/search.js";
import { searchEpisodic } from "../../src/episodic/search.js";
import { insertMemory } from "../../src/semantic/memory.js";
import { unifiedSearch } from "../../src/interfaces/shared/search.js";
import { formatRecallXml } from "../../src/_core/search/format.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { Memory } from "../../src/semantic/types.js";

vi.mock("../../src/_core/embeddings/index.js", () => ({
  embedQuery: vi.fn(),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

import { embedQuery } from "../../src/_core/embeddings/index.js";
const mockedEmbedQuery = vi.mocked(embedQuery);

// ─── Helpers ────────────────────────────────────────────────────

let t: TestDb;

function seededEmbedding(seed: number, dims = 256): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff - 0.5;
  };
  const vec = Array.from({ length: dims }, () => next());
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function seedExchange(id: string, timestamp: string, text = "launchd daemon plist work") {
  t.db
    .prepare(
      `INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index, token_estimate, created_at)
       VALUES (?, 'conv-1', 'proj', ?, ?, ?, 0, 40, ?)`,
    )
    .run(id, timestamp, `User asks about ${text}`, `Assistant explains ${text}`, epoch(timestamp));
  const row = t.db.prepare("SELECT rowid FROM exchanges WHERE id = ?").get(id) as { rowid: number };
  t.db
    .prepare("INSERT INTO exchanges_fts (rowid, user_message, assistant_message) VALUES (?, ?, ?)")
    .run(row.rowid, `User asks about ${text}`, `Assistant explains ${text}`);
  t.db
    .prepare("INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)")
    .run(id, Buffer.from(new Float32Array(seededEmbedding(id.length + 7)).buffer));
}

function mem(id: string, createdAt: string, sourceExchanges: string[] = [], content = `${id} launchd daemon plist notes`): Memory {
  return {
    id,
    type: "fact",
    content,
    confidence: 0.5,
    importance: 0.5,
    accessCount: 0,
    createdAt: epoch(createdAt),
    sourceExchanges,
    isActive: true,
  };
}

/**
 * Fixture (spec item 2.4):
 *   mem-a  filed 2026-05-01T10:00Z, source exchange on 2026-03-10 → event March
 *   mem-b  filed 2026-05-15,        no sources                    → event = filed
 *   mem-c  filed 2026-02-01,        no sources
 */
function seedFixture() {
  seedExchange("ex-march", "2026-03-10T12:00:00Z");
  insertMemory(t.db, mem("mem-a", "2026-05-01T10:00:00Z", ["ex-march"]), seededEmbedding(1));
  insertMemory(t.db, mem("mem-b", "2026-05-15T10:00:00Z"), seededEmbedding(2));
  insertMemory(t.db, mem("mem-c", "2026-02-01T10:00:00Z"), seededEmbedding(3));
  mockedEmbedQuery.mockResolvedValue(seededEmbedding(1));
}

const ids = (rs: Array<{ id: string }>) => rs.map((r) => r.id).sort();

beforeEach(() => {
  t = createTestDb();
  vi.clearAllMocks();
});

afterEach(() => {
  t.cleanup();
});

// ─── Semantic: after/before (item 1) ────────────────────────────

describe("searchSemantic honors after/before", () => {
  it("unfiltered returns every memory (baseline)", async () => {
    seedFixture();
    const rs = await searchSemantic(t.db, { query: "launchd daemon plist" });
    expect(ids(rs)).toEqual(["mem-a", "mem-b", "mem-c"]);
  });

  it("filed basis: after excludes older rows", async () => {
    seedFixture();
    const rs = await searchSemantic(t.db, { query: "launchd daemon plist", after: "2026-04-01" });
    expect(ids(rs)).toEqual(["mem-a", "mem-b"]);
  });

  it("filed basis: before excludes newer rows", async () => {
    seedFixture();
    const rs = await searchSemantic(t.db, { query: "launchd daemon plist", before: "2026-04-01" });
    expect(ids(rs)).toEqual(["mem-c"]);
  });

  it("edges match episodic: after is inclusive of the day, before excludes the named day", async () => {
    seedFixture();
    // mem-a filed 2026-05-01T10:00Z
    expect(ids(await searchSemantic(t.db, { query: "launchd daemon plist", after: "2026-05-01", before: "2026-05-02" }))).toEqual(["mem-a"]);
    expect(ids(await searchSemantic(t.db, { query: "launchd daemon plist", before: "2026-05-01" }))).toEqual(["mem-c"]);
    expect(ids(await searchSemantic(t.db, { query: "launchd daemon plist", after: "2026-05-02" }))).toEqual(["mem-b"]);
  });

  it("vector candidate path is filtered (query text matches nothing in FTS)", async () => {
    seedFixture();
    // No FTS hit for this query → candidates come only from vec_memories
    const rs = await searchSemantic(t.db, { query: "zzqx qqxz", after: "2026-04-01" });
    expect(rs.length).toBeGreaterThan(0);
    expect(ids(rs)).toEqual(["mem-a", "mem-b"]);
  });

  it("FTS candidate path is filtered (memories reachable only via FTS)", async () => {
    seedFixture();
    // Strip vectors so the only route to these rows is memories_fts
    t.db.prepare("DELETE FROM vec_memories").run();
    const rs = await searchSemantic(t.db, { query: "launchd daemon plist", after: "2026-04-01" });
    expect(rs.length).toBeGreaterThan(0);
    expect(ids(rs)).toEqual(["mem-a", "mem-b"]);
  });

  it("thin window escalates the candidate window until it finds matches", async () => {
    seedFixture();
    // 60 decoys filed in 2027 crowd the top-k; the only 2025 row must still surface
    for (let i = 0; i < 60; i++) {
      insertMemory(t.db, mem(`decoy-${i}`, "2027-01-15T00:00:00Z", [], `decoy ${i} unrelated text`), seededEmbedding(100 + i));
    }
    insertMemory(t.db, mem("mem-old", "2025-06-01T00:00:00Z", [], "old launchd daemon plist notes"), seededEmbedding(999));
    const rs = await searchSemantic(t.db, { query: "launchd daemon plist", after: "2025-01-01", before: "2026-01-01", limit: 5 });
    expect(ids(rs)).toEqual(["mem-old"]);
  });
});

// ─── Semantic: event basis (item 2) ─────────────────────────────

describe("searchSemantic dateBasis=event", () => {
  it("memory filed in May about March: filed after April → included", async () => {
    seedFixture();
    const rs = await searchSemantic(t.db, { query: "launchd daemon plist", after: "2026-04-01", dateBasis: "filed" });
    expect(ids(rs)).toContain("mem-a");
  });

  it("event basis + after April → excluded (event was March)", async () => {
    seedFixture();
    const rs = await searchSemantic(t.db, { query: "launchd daemon plist", after: "2026-04-01", dateBasis: "event" });
    expect(ids(rs)).toEqual(["mem-b"]); // mem-b falls back to created_at (May)
  });

  it("event basis + before April → included", async () => {
    seedFixture();
    const rs = await searchSemantic(t.db, { query: "launchd daemon plist", before: "2026-04-01", dateBasis: "event" });
    expect(ids(rs)).toEqual(["mem-a", "mem-c"]);
  });

  it("NULL event_ts falls back to created_at", async () => {
    seedFixture();
    const row = t.db.prepare("SELECT event_ts FROM memories WHERE id = 'mem-b'").get() as { event_ts: number | null };
    expect(row.event_ts).toBeNull();
    const rs = await searchSemantic(t.db, { query: "launchd daemon plist", after: "2026-05-10", before: "2026-05-20", dateBasis: "event" });
    expect(ids(rs)).toEqual(["mem-b"]);
  });

  it("reports the basis date and raw timestamps in metadata", async () => {
    seedFixture();
    const filed = await searchSemantic(t.db, { query: "launchd daemon plist" });
    const a = filed.find((r) => r.id === "mem-a")!;
    expect(a.metadata.date).toBe("2026-05-01");
    expect(a.metadata.eventTs).toBe(epoch("2026-03-10T12:00:00Z"));
    expect(a.metadata.createdAt).toBe(epoch("2026-05-01T10:00:00Z"));

    const event = await searchSemantic(t.db, { query: "launchd daemon plist", dateBasis: "event", before: "2026-04-01" });
    expect(event.find((r) => r.id === "mem-a")!.metadata.date).toBe("2026-03-10");
    expect(event.find((r) => r.id === "mem-c")!.metadata.date).toBe("2026-02-01");
  });
});

// ─── Anniversary ("on this day") on both stores ────────────────

describe("anniversary matching", () => {
  it("semantic: matches month/day across years under the chosen basis", async () => {
    seedExchange("ex-2024", "2024-09-13T08:00:00Z");
    insertMemory(t.db, mem("m-2025", "2025-09-13T08:00:00Z"), seededEmbedding(11));
    insertMemory(t.db, mem("m-2026", "2026-09-13T20:00:00Z"), seededEmbedding(12));
    insertMemory(t.db, mem("m-near", "2026-09-12T23:00:00Z"), seededEmbedding(13));
    insertMemory(t.db, mem("m-about", "2026-06-01T00:00:00Z", ["ex-2024"]), seededEmbedding(14));
    mockedEmbedQuery.mockResolvedValue(seededEmbedding(11));

    const filed = await searchSemantic(t.db, { query: "launchd daemon plist", anniversary: { month: 9, day: 13 } });
    expect(ids(filed)).toEqual(["m-2025", "m-2026"]);

    const event = await searchSemantic(t.db, { query: "launchd daemon plist", anniversary: { month: 9, day: 13 }, dateBasis: "event" });
    expect(ids(event)).toEqual(["m-2025", "m-2026", "m-about"]);
  });

  it("episodic: matches exchange timestamps on the same month/day", async () => {
    seedExchange("e-2025", "2025-09-13T08:00:00Z");
    seedExchange("e-2026", "2026-09-13T20:00:00Z");
    seedExchange("e-near", "2026-09-14T00:30:00Z");

    const text = await searchEpisodic(t.db, { query: "launchd daemon", mode: "text", anniversary: { month: 9, day: 13 } });
    expect(ids(text.results)).toEqual(["e-2025", "e-2026"]);

    mockedEmbedQuery.mockResolvedValue(seededEmbedding("e-2025".length + 7));
    const vector = await searchEpisodic(t.db, { query: "launchd daemon", mode: "vector", anniversary: { month: 9, day: 13 } });
    expect(ids(vector.results)).toEqual(["e-2025", "e-2026"]);
  });
});

// ─── Episodic edges (regression guard for the shared filter) ────

describe("searchEpisodic edges via shared filter", () => {
  it("after is inclusive of the day, before excludes the named day", async () => {
    seedExchange("e-a", "2026-05-01T10:00:00Z");
    seedExchange("e-b", "2026-05-02T10:00:00Z");
    const inWin = await searchEpisodic(t.db, { query: "launchd daemon", mode: "text", after: "2026-05-01", before: "2026-05-02" });
    expect(ids(inWin.results)).toEqual(["e-a"]);
    const beforeOnly = await searchEpisodic(t.db, { query: "launchd daemon", mode: "text", before: "2026-05-01" });
    expect(ids(beforeOnly.results)).toEqual([]);
  });
});

// ─── unifiedSearch: dateHint + transparency (item 3) ────────────

describe("unifiedSearch dateHint", () => {
  const NOW = new Date("2026-06-10T12:00:00Z");

  it("resolves the hint, filters, and echoes dateFilter", async () => {
    seedFixture();
    const res = await unifiedSearch(t.db, {
      query: "launchd daemon plist",
      sources: ["semantic"],
      dateHint: "last month",
      now: NOW,
    });
    expect(res.dateFilter).toEqual({
      basis: "filed",
      hint: "last month",
      after: "2026-05-01",
      before: "2026-06-01",
    });
    expect(ids(res.results)).toEqual(["mem-a", "mem-b"]);

    const xml = formatRecallXml(res);
    expect(xml).toContain('<date_filter basis="filed" after="2026-05-01" before="2026-06-01" hint="last month"/>');
    expect(xml).toMatch(/<semantic [^>]*date="2026-05-01"/);
  });

  it("explicit after/before win over the hint and the override is documented", async () => {
    seedFixture();
    const res = await unifiedSearch(t.db, {
      query: "launchd daemon plist",
      sources: ["semantic"],
      dateHint: "last month",
      after: "2026-05-10",
      now: NOW,
    });
    expect(res.dateFilter).toMatchObject({
      after: "2026-05-10",
      before: "2026-06-01",
      overridden: ["after"],
    });
    expect(res.dateFilter!.note).toMatch(/explicit after overrode the hint/);
    expect(ids(res.results)).toEqual(["mem-b"]);
    expect(formatRecallXml(res)).toContain('overridden="after"');
  });

  it("unknown hint → no filter, note in metadata", async () => {
    seedFixture();
    const res = await unifiedSearch(t.db, {
      query: "launchd daemon plist",
      sources: ["semantic"],
      dateHint: "whenever",
      now: NOW,
    });
    expect(res.dateFilter).toEqual({
      basis: "filed",
      hint: "whenever",
      note: 'unrecognized date hint: "whenever"',
    });
    expect(ids(res.results)).toEqual(["mem-a", "mem-b", "mem-c"]);
    expect(formatRecallXml(res)).toContain('note="unrecognized date hint: &quot;whenever&quot;"');
  });

  it("event basis + 'in March' finds the memory ABOUT March, filed in May", async () => {
    seedFixture();
    const res = await unifiedSearch(t.db, {
      query: "launchd daemon plist",
      sources: ["semantic"],
      dateHint: "in March",
      dateBasis: "event",
      now: NOW,
    });
    expect(res.dateFilter).toEqual({
      basis: "event",
      hint: "in March",
      after: "2026-03-01",
      before: "2026-04-01",
    });
    expect(ids(res.results)).toEqual(["mem-a"]);

    const filed = await unifiedSearch(t.db, {
      query: "launchd daemon plist",
      sources: ["semantic"],
      dateHint: "in March",
      now: NOW,
    });
    expect(ids(filed.results)).toEqual([]);
  });

  it("anniversary hint flows to both stores", async () => {
    seedExchange("e-2025", "2025-06-10T08:00:00Z");
    seedExchange("e-other", "2025-06-11T08:00:00Z");
    insertMemory(t.db, mem("m-2024", "2024-06-10T08:00:00Z"), seededEmbedding(21));
    insertMemory(t.db, mem("m-other", "2024-06-12T08:00:00Z"), seededEmbedding(22));
    mockedEmbedQuery.mockResolvedValue(seededEmbedding(21));

    const res = await unifiedSearch(t.db, {
      query: "launchd daemon plist",
      dateHint: "on this day",
      now: NOW,
    });
    expect(res.dateFilter).toEqual({ basis: "filed", hint: "on this day", anniversary: { month: 6, day: 10 } });
    expect(ids(res.results)).toEqual(["e-2025", "m-2024"]);
    expect(formatRecallXml(res)).toContain('anniversary="06-10"');
  });

  it("no temporal params → no dateFilter on the response", async () => {
    seedFixture();
    const res = await unifiedSearch(t.db, { query: "launchd daemon plist", sources: ["semantic"] });
    expect(res.dateFilter).toBeUndefined();
    expect(formatRecallXml(res)).not.toContain("<date_filter");
  });
});
