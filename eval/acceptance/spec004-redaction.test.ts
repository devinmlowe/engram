import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalModule } from "./_support/load.ts";

export const TRACES = ["SPEC-004"];

// The redaction failure mode under test: a memory row that is still active
// whose content hash is present in memory_suppressions. Recall surfacing
// that content = leakage. The mini-store seeder computes the suppression
// content hash with Engram's own contentHash() from src/semantic/forget.ts.
const SUPPRESSED_CONTENT = "user api key sk-redacted0000 lives in the vault";

describe("SPEC-004 redaction axis", () => {
  it("leakage metric computes exactly", async () => {
    const score = await loadEvalModule<Record<string, any>>("score.js");
    const cases = [
      { hash: "h1", surfaced: true },
      { hash: "h2", surfaced: false },
      { hash: "h3", surfaced: false },
      { hash: "h4", surfaced: false },
    ];
    expect(score.redactionLeakageRate(cases)).toBeCloseTo(0.25);
    expect(score.redactionLeakageRate([])).toBe(0);
  });

  it("runRedactionSuite scores suppressed-hash surfacing on a seeded mini-DB", async () => {
    const fixtures = await loadEvalModule<Record<string, any>>("fixtures/mini-store.js");
    const suites = await loadEvalModule<Record<string, any>>("suites/redaction.js");
    const store = await loadEvalModule<Record<string, any>>("store.js");
    const { contentHash } = await import("../../src/semantic/forget.js");
    const dir = mkdtempSync(join(tmpdir(), "spec004-"));
    try {
      const mini = await fixtures.buildMiniStore(dir, {
        conflictPairs: [],
        changes: [],
        suppressions: [
          {
            memoryId: "m-suppressed",
            scope: "global",
            content: SUPPRESSED_CONTENT,
            keepActive: true,
          },
        ],
      });
      const db = store.openStoreReadonly(mini.dbPath);
      try {
        const result = await suites.runRedactionSuite(db, { k: 10 });
        expect(result.n).toBe(1);
        expect(result.leakageRate).toBeTypeOf("number");
        expect(result.perCase[0].hash).toBe(contentHash(SUPPRESSED_CONTENT));
        expect(result.perCase[0].surfaced).toBeTypeOf("boolean");
        // Ground truth: the suppressed memory is the ONLY row in this mini
        // store and was deliberately kept active — a query built from its own
        // content must surface it, so a correct suite measures a planted leak
        // (leakageRate 1). A suite that always reports 0 cannot detect leaks.
        expect(result.leakageRate).toBe(1);
        expect(result.perCase[0].surfaced).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
