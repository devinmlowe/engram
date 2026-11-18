import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalModule } from "./_support/load.ts";

export const TRACES = ["SPEC-003"];

describe("SPEC-003 thin temporal suite + read-only enforcement", () => {
  it("scores ordering/supersede behavior on seeded change rows", async () => {
    const fixtures = await loadEvalModule<Record<string, any>>("fixtures/mini-store.js");
    const suites = await loadEvalModule<Record<string, any>>("suites/temporal.js");
    const score = await loadEvalModule<Record<string, any>>("score.js");
    const dir = mkdtempSync(join(tmpdir(), "spec003-"));
    try {
      const mini = await fixtures.buildMiniStore(dir, {
        conflictPairs: [],
        changes: [
          {
            id: "chg-1",
            memoryId: "m-live",
            op: "edit",
            before: "old value statement",
            after: "new value statement",
            at: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "chg-2",
            memoryId: "m-forgotten",
            op: "forget",
            before: "forgotten content",
            after: null,
            at: "2026-01-03T00:00:00.000Z",
          },
        ],
        suppressions: [],
      });
      const store = await loadEvalModule<Record<string, any>>("store.js");
      const db = store.openStoreReadonly(mini.dbPath);
      try {
        const result = await suites.runTemporalSuite(db);
        expect(result).toBeTruthy();
        expect(result.n).toBe(2);
        expect(result.orderingCorrectRate).toBeTypeOf("number");
        expect(result.perCase.length).toBe(2);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it("full hermetic run leaves schema and row counts unchanged", async () => {
    // The SPEC-003 no-write test must exercise the same open path the suites
    // use: openStoreReadonly (better-sqlite3 readonly: true).
    const fixtures = await loadEvalModule<Record<string, any>>("fixtures/mini-store.js");
    const store = await loadEvalModule<Record<string, any>>("store.js");
    const suites = await loadEvalModule<Record<string, any>>("suites/conflicts.js");
    const dir = mkdtempSync(join(tmpdir(), "spec003-ro-"));
    try {
      const mini = await fixtures.buildMiniStore(dir, {
        conflictPairs: [],
        changes: [],
        suppressions: [],
      });
      const snapshot = (db: any) => ({
        schema: db
          .prepare(
            "SELECT type, name, sql FROM sqlite_master ORDER BY type, name",
          )
          .all(),
        counts: db
          .prepare(
            `SELECT 'memories' t, COUNT(*) n FROM memories
             UNION ALL SELECT 'conflicts', COUNT(*) FROM conflicts
             UNION ALL SELECT 'memory_changes', COUNT(*) FROM memory_changes
             UNION ALL SELECT 'memory_suppressions', COUNT(*) FROM memory_suppressions`,
          )
          .all(),
      });
      // same open path as the suites: openStoreReadonly
      const ro = store.openStoreReadonly(mini.dbPath);
      const beforeSnap = snapshot(ro);
      ro.close();
      const db = store.openStoreReadonly(mini.dbPath);
      await suites.runConflictSuite(db, { k: 10 }).catch(() => {});
      db.close();
      const ro2 = store.openStoreReadonly(mini.dbPath);
      const afterSnap = snapshot(ro2);
      ro2.close();
      expect(afterSnap).toEqual(beforeSnap);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
