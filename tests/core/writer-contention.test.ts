/**
 * #26: several processes write one WAL database. Recall reinforcement must
 * never fail the recall it rides on when another writer holds the lock, and
 * must land once the lock is free. Exercised with a second real connection
 * (held IMMEDIATE transaction) and with a worker thread hammering writes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createTestDb, type TestDb } from "../helpers.js";
import { insertMemory } from "../../src/semantic/memory.js";
import { reinforceRecalledMemories } from "../../src/interfaces/shared/search.js";
import { isBusyError, withBusyRetry } from "../../src/_core/db/busy.js";
import { createRun, recordCheckpoint } from "../../src/dream/scheduler.js";
import type { Memory } from "../../src/semantic/types.js";
import type { SearchResult } from "../../src/_core/types/index.js";

let t: TestDb;
beforeEach(() => { t = createTestDb(); });
afterEach(() => { t.cleanup(); });

function vec(seed: number): number[] {
  const v = Array.from({ length: 256 }, (_, i) => Math.sin(seed * 7 + i));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
function seed(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `m${i}`;
    insertMemory(t.db, {
      id, type: "fact", content: `fact number ${i}`, confidence: 0.5, importance: 0.5, accessCount: 0,
      createdAt: 1_700_000_000, sourceExchanges: [], isActive: true,
    } as Memory, vec(i));
    ids.push(id);
  }
  return ids;
}
const asResults = (ids: string[]): SearchResult[] => ids.map((id) => ({ id, source: "semantic" }) as SearchResult);
const accessCount = (db: Database.Database, id: string) => (db.prepare("SELECT access_count AS c FROM memories WHERE id = ?").get(id) as { c: number }).c;

describe("withBusyRetry", () => {
  const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  it("recognises better-sqlite3 busy codes only", () => {
    expect(isBusyError(busy())).toBe(true);
    expect(isBusyError(Object.assign(new Error("x"), { code: "SQLITE_BUSY_SNAPSHOT" }))).toBe(true);
    expect(isBusyError(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }))).toBe(false);
    expect(isBusyError(new Error("x"))).toBe(false);
  });
  it("retries busy with growing backoff, then gives up; other errors propagate at once", () => {
    let n = 0;
    const sleeps: number[] = [];
    const v = withBusyRetry(() => { if (++n < 3) throw busy(); return "ok"; }, { attempts: 3, baseMs: 10, sleep: (ms) => sleeps.push(ms) });
    expect(v).toBe("ok");
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] / 2); // doubling base, jittered
    expect(() => withBusyRetry(() => { throw busy(); }, { attempts: 2, sleep: () => {} })).toThrow(/locked/);
    let calls = 0;
    expect(() => withBusyRetry(() => { calls++; throw new TypeError("nope"); }, { attempts: 3, sleep: () => {} })).toThrow(TypeError);
    expect(calls).toBe(1);
  });
});

describe("recall reinforcement under a held write lock (INV-3)", () => {
  it("skips the round without throwing while another connection holds BEGIN IMMEDIATE, then lands", () => {
    const ids = seed(3);
    const other = new Database(t.config.dbPath);
    other.pragma("busy_timeout = 5000");
    const mine = new Database(t.config.dbPath);
    mine.pragma("busy_timeout = 20"); // do not wait 5 s per attempt in a test
    try {
      other.exec("BEGIN IMMEDIATE");
      other.prepare("UPDATE memories SET importance = 0.9 WHERE id = ?").run(ids[0]);
      const t0 = Date.now();
      expect(() => reinforceRecalledMemories(mine, asResults(ids))).not.toThrow();
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(accessCount(mine, ids[0])).toBe(0); // skipped, not half-applied
      other.exec("COMMIT");
      reinforceRecalledMemories(mine, asResults(ids));
      for (const id of ids) expect(accessCount(mine, id)).toBe(1);
    } finally {
      try { other.exec("ROLLBACK"); } catch { /* already committed */ }
      other.close();
      mine.close();
    }
  });

  it("recordCheckpoint starts as a writer: under a held lock it fails cleanly at BEGIN, leaves no partial row, and succeeds once free", () => {
    const other = new Database(t.config.dbPath);
    const mine = new Database(t.config.dbPath);
    mine.pragma("busy_timeout = 30");
    const runId = createRun(mine); // dream_checkpoints.run_id -> dream_runs
    try {
      other.exec("BEGIN IMMEDIATE");
      let caught: unknown;
      try { recordCheckpoint(mine, runId, "consolidate", "conv-1"); } catch (e) { caught = e; }
      expect(isBusyError(caught)).toBe(true);
      expect(mine.prepare("SELECT COUNT(*) AS c FROM dream_checkpoints").get()).toEqual({ c: 0 });
      other.exec("COMMIT");
      recordCheckpoint(mine, runId, "consolidate", "conv-1");
      expect((mine.prepare("SELECT status FROM dream_checkpoints WHERE run_id = ?").get(runId) as { status: string }).status).toBe("success");
    } finally {
      try { other.exec("ROLLBACK"); } catch { /* committed */ }
      other.close();
      mine.close();
    }
  });
});

describe("parallel writer stress", () => {
  it("a worker hammering immediate transactions never makes reinforcement throw, and most rounds land", async () => {
    const ids = seed(5);
    const worker = new Worker(fileURLToPath(new URL("./fixtures/write-hammer.mjs", import.meta.url)), {
      workerData: { dbPath: t.config.dbPath, rounds: 150, holdMs: 2 },
    });
    const finished = new Promise<{ done: number }>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    const mine = new Database(t.config.dbPath);
    mine.pragma("busy_timeout = 50");
    let rounds = 0;
    const deadline = Date.now() + 1500;
    try {
      while (Date.now() < deadline) {
        expect(() => reinforceRecalledMemories(mine, asResults(ids))).not.toThrow();
        rounds++;
      }
      const { done } = await finished;
      expect(done).toBe(150);
      const landed = accessCount(mine, ids[0]);
      expect(rounds).toBeGreaterThan(5);
      expect(landed).toBeGreaterThan(0);
      expect(landed).toBeLessThanOrEqual(rounds);
    } finally {
      mine.close();
      await worker.terminate();
    }
  }, 20_000);
});
