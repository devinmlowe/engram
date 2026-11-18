import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalModule } from "./_support/load.ts";

export const TRACES = ["SPEC-002", "SPEC-007"];

const capturedPair = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "captured-conflict-pair.json"), "utf8"),
);

let mini: { dbPath: string; cleanup: () => void } | null = null;

describe("SPEC-002 conflict replay suite (primary)", () => {
  beforeAll(async () => {
    const fixtures = await loadEvalModule<Record<string, any>>("fixtures/mini-store.js");
    const dir = mkdtempSync(join(tmpdir(), "spec002-"));
    mini = await fixtures.buildMiniStore(dir, {
      conflictPairs: [
        {
          conflict: capturedPair.conflict,
          surviving: capturedPair.surviving,
          stale: capturedPair.stale,
        },
      ],
      changes: [],
      suppressions: [],
    });
    mini.cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    };
  }, 240_000);

  it("fixture provenance: captured pair cites the live conflict row it derives from", () => {
    expect(capturedPair.provenance.capture).toMatch(/d385a95a/);
    expect(capturedPair.surviving.is_active).toBe(true);
    expect(capturedPair.stale.is_active).toBe(false);
    expect(capturedPair.stale.superseded_by).toBe(capturedPair.surviving.id);
  });

  it("score functions compute stale-surfacing and recall@k exactly", async () => {
    const score = await loadEvalModule<Record<string, any>>("score.js");
    // Case: surviving ranked 1st, stale ranked 2nd → not stale-surfacing at k=1
    const good = { survivingRank: 1, staleRank: 2, surfacedStale: false };
    // Case: stale ranked above surviving → stale-surfacing
    const bad = { survivingRank: 4, staleRank: 1, surfacedStale: true };
    const cases = [good, bad, good, good];
    expect(score.staleSurfacingRate(cases)).toBeCloseTo(0.25);
    // recall@k: surviving memory appears in top-k
    expect(score.recallAtK([{ survivingRank: 1 }, { survivingRank: 7 }], 3)).toBeCloseTo(0.5);
    expect(score.recallAtK([{ survivingRank: 7 }], 10)).toBeCloseTo(1);
    expect(score.recallAtK([], 5)).toBe(0);
  });

  it("runs the replay suite on the mini-DB through repo recall code", async () => {
    const suites = await loadEvalModule<Record<string, any>>("suites/conflicts.js");
    const store = await loadEvalModule<Record<string, any>>("store.js");
    const db = store.openStoreReadonly(mini!.dbPath);
    try {
      const result = await suites.runConflictSuite(db, { k: 10 });
      // Result contract
      expect(result).toBeTruthy();
      expect(result.n).toBe(1);
      expect(result.staleSurfacingRate).toBeTypeOf("number");
      expect(result.recallAtK).toEqual(
        expect.arrayContaining([expect.objectContaining({ k: 1 })]),
      );
      // Each case records the query and the ranked ids so the recall path is auditable
      const case0 = result.perCase[0];
      expect(case0.rankedIds).toBeInstanceOf(Array);
      expect(case0.query).toBeTypeOf("string");
      expect(case0.survivingId).toBe(capturedPair.surviving.id);
      expect(case0.staleId).toBe(capturedPair.stale.id);
    } finally {
      db.close();
    }
  }, 240_000);

  it("the suite uses Engram's own searchSemantic, not a reimplementation", async () => {
    // Static traceability: the conflicts suite module must import the repo's
    // semantic search module. Read its source and assert the import.
    const { readFileSync: rf } = await import("node:fs");
    const src = rf(join(import.meta.dirname, "..", "src", "suites", "conflicts.ts"), "utf8");
    expect(src).toMatch(/from\s+["'].*semantic\/search(\.js)?["']/);
    expect(src).not.toMatch(/SELECT .* FROM vec_memories/s);
  });

  afterAll(() => mini?.cleanup());
});
