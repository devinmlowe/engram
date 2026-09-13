/**
 * Legacy event_ts recovery from the dream pipeline's pending-facts files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backfillEventTsFromPendingFacts } from "../../src/migration/backfill-event-ts.js";
import { createTestDb, type TestDb } from "../helpers.js";

let t: TestDb;
let tmpDir: string;

const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function exchange(id: string, conv: string, index: number, timestamp: string) {
  t.db
    .prepare(
      `INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message, assistant_message, exchange_index)
       VALUES (?, ?, 'proj', ?, 'u', 'a', ?)`,
    )
    .run(id, conv, timestamp, index);
}

function memory(id: string, content: string, eventTs: number | null = null, sourceExchanges = '["0","1"]') {
  t.db
    .prepare(
      `INSERT INTO memories (id, type, content, created_at, source_exchanges, event_ts, source)
       VALUES (?, 'fact', ?, ?, ?, ?, 'dream')`,
    )
    .run(id, content, epoch("2026-05-01T00:00:00Z"), sourceExchanges, eventTs);
}

function pending(name: string, batches: unknown) {
  writeFileSync(join(tmpDir, `pending-facts-${name}.json`), JSON.stringify(batches));
}

beforeEach(() => {
  t = createTestDb();
  tmpDir = join(t.tmpDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });

  exchange("c1-0", "conv-1", 0, "2026-03-10T12:00:00Z");
  exchange("c1-1", "conv-1", 1, "2026-03-11T12:00:00Z");
  exchange("c1-2", "conv-1", 2, "2026-03-09T08:00:00Z");
  exchange("c2-0", "conv-2", 0, "2026-04-20T12:00:00Z");
});

afterEach(() => {
  t.cleanup();
});

describe("backfillEventTsFromPendingFacts", () => {
  it("dates legacy memories by exact content via conversation + exchange index", () => {
    memory("m-a", "Fact A about launchd");
    memory("m-b", "Fact B about plists");
    memory("m-untouched", "Nothing references me");
    pending("run1", [
      {
        conversationId: "conv-1",
        facts: [
          { content: "Fact A about launchd", sourceExchangeIds: ["1", "2"] }, // earliest = idx 2 (03-09)
          { content: "Fact B about plists", sourceExchangeIds: ["0"] },
          { content: "Never became a memory", sourceExchangeIds: ["0"] },
        ],
      },
    ]);

    const report = backfillEventTsFromPendingFacts(t.db, tmpDir);
    expect(report).toMatchObject({ files: 1, facts: 3, factsWithSources: 3, unresolvedFacts: 0, matched: 2, updated: 2, alreadySet: 0, dryRun: false });

    const ts = (id: string) => (t.db.prepare("SELECT event_ts FROM memories WHERE id = ?").get(id) as { event_ts: number | null }).event_ts;
    expect(ts("m-a")).toBe(epoch("2026-03-09T08:00:00Z"));
    expect(ts("m-b")).toBe(epoch("2026-03-10T12:00:00Z"));
    expect(ts("m-untouched")).toBeNull();
  });

  it("takes the earliest evidence across files and dates every duplicate row alike", () => {
    memory("m-dup-1", "Shared content");
    memory("m-dup-2", "Shared content");
    pending("later", [{ conversationId: "conv-2", facts: [{ content: "Shared content", sourceExchangeIds: ["0"] }] }]);
    pending("earlier", [{ conversationId: "conv-1", facts: [{ content: "Shared content", sourceExchangeIds: ["1"] }] }]);

    const report = backfillEventTsFromPendingFacts(t.db, tmpDir);
    expect(report.matched).toBe(2);
    expect(report.updated).toBe(2);
    const rows = t.db.prepare("SELECT event_ts FROM memories WHERE content = 'Shared content'").all() as Array<{ event_ts: number }>;
    expect(rows.map((r) => r.event_ts)).toEqual([epoch("2026-03-11T12:00:00Z"), epoch("2026-03-11T12:00:00Z")]);
  });

  it("never overwrites an existing event_ts, never touches other columns, and is idempotent", () => {
    memory("m-set", "Already dated", 1_700_000_000);
    memory("m-new", "Needs a date");
    pending("run", [{ conversationId: "conv-1", facts: [
      { content: "Already dated", sourceExchangeIds: ["0"] },
      { content: "Needs a date", sourceExchangeIds: ["0"] },
    ] }]);
    const before = t.db.prepare("SELECT id, content, source_exchanges, created_at, is_active FROM memories ORDER BY id").all();

    const first = backfillEventTsFromPendingFacts(t.db, tmpDir);
    expect(first).toMatchObject({ matched: 2, updated: 1, alreadySet: 1 });
    expect((t.db.prepare("SELECT event_ts FROM memories WHERE id = 'm-set'").get() as { event_ts: number }).event_ts).toBe(1_700_000_000);
    expect(t.db.prepare("SELECT id, content, source_exchanges, created_at, is_active FROM memories ORDER BY id").all()).toEqual(before);

    const second = backfillEventTsFromPendingFacts(t.db, tmpDir);
    expect(second).toMatchObject({ matched: 2, updated: 0, alreadySet: 2 });
  });

  it("dry run reports what it would do without writing", () => {
    memory("m-a", "Fact A about launchd");
    pending("run", [{ conversationId: "conv-1", facts: [{ content: "Fact A about launchd", sourceExchangeIds: ["0"] }] }]);
    const report = backfillEventTsFromPendingFacts(t.db, tmpDir, { dryRun: true });
    expect(report).toMatchObject({ matched: 1, updated: 1, dryRun: true });
    expect((t.db.prepare("SELECT event_ts FROM memories WHERE id = 'm-a'").get() as { event_ts: number | null }).event_ts).toBeNull();
  });

  it("skips unresolvable indexes, non-numeric refs, malformed files, and a missing directory", () => {
    memory("m-a", "Fact A about launchd");
    pending("bad-index", [{ conversationId: "conv-1", facts: [{ content: "Fact A about launchd", sourceExchangeIds: ["99", "abc"] }] }]);
    pending("wrong-conv", [{ conversationId: "conv-missing", facts: [{ content: "Fact A about launchd", sourceExchangeIds: ["0"] }] }]);
    pending("no-sources", [{ conversationId: "conv-1", facts: [{ content: "Fact A about launchd", sourceExchangeIds: [] }] }]);
    writeFileSync(join(tmpDir, "pending-facts-broken.json"), "{not json");
    writeFileSync(join(tmpDir, "pending-facts-object.json"), JSON.stringify({ conversationId: "conv-1" }));

    const report = backfillEventTsFromPendingFacts(t.db, tmpDir);
    expect(report).toMatchObject({ files: 3, facts: 3, factsWithSources: 2, unresolvedFacts: 2, matched: 0, updated: 0 });
    expect((t.db.prepare("SELECT event_ts FROM memories WHERE id = 'm-a'").get() as { event_ts: number | null }).event_ts).toBeNull();

    expect(backfillEventTsFromPendingFacts(t.db, join(t.tmpDir, "does-not-exist"))).toMatchObject({ files: 0, updated: 0 });
  });
});
