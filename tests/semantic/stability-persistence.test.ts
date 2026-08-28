import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import { insertMemory, recordAccess, applyContradiction } from "../../src/semantic/memory.js";
import { computeRetrievability } from "../../src/semantic/decay.js";
import { INITIAL_STABILITY, type Memory } from "../../src/semantic/types.js";

let t: TestDb;

function seededEmbedding(seed: number, dims: number = 256): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff - 0.5;
  };
  const vec = Array.from({ length: dims }, () => next());
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

function mem(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    type: "fact",
    content: `content for ${id}`,
    confidence: 0.9,
    importance: 0.5,
    accessCount: 0,
    createdAt: Math.floor(Date.now() / 1000) - 90 * 86400,
    lastAccessed: Math.floor(Date.now() / 1000) - 60 * 86400, // 60 days ago -> R < 1
    sourceExchanges: [],
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

// ADR-010 upgrade: FSRS stability must be persisted, not recomputed from
// the type constant every time (growth/penalty were previously discarded).
describe("persisted decay stability", () => {
  it("memories table has a nullable stability column", () => {
    const cols = t.db.prepare("PRAGMA table_info(memories)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const stab = cols.find((c) => c.name === "stability");
    expect(stab).toBeDefined();
    expect(stab!.notnull).toBe(0);
  });

  it("recordAccess persists grown stability and bumped importance", () => {
    insertMemory(t.db, mem("m1"), seededEmbedding(1));
    recordAccess(t.db, "m1");
    const row = t.db
      .prepare("SELECT stability, importance, access_count FROM memories WHERE id = 'm1'")
      .get() as { stability: number | null; importance: number; access_count: number };
    expect(row.access_count).toBe(1);
    expect(row.stability).not.toBeNull();
    // 60 days since access on a 30-day-stability fact -> R well below 1 -> growth
    expect(row.stability!).toBeGreaterThan(INITIAL_STABILITY.fact);
    expect(row.importance).toBeCloseTo(0.52, 5);
  });

  it("stability compounds across repeated accesses", () => {
    insertMemory(t.db, mem("m2"), seededEmbedding(2));
    recordAccess(t.db, "m2");
    const first = (
      t.db.prepare("SELECT stability FROM memories WHERE id = 'm2'").get() as {
        stability: number;
      }
    ).stability;
    // Age the memory again so R < 1 on the second access
    t.db
      .prepare("UPDATE memories SET last_accessed = unixepoch() - 60*86400 WHERE id = 'm2'")
      .run();
    recordAccess(t.db, "m2");
    const second = (
      t.db.prepare("SELECT stability FROM memories WHERE id = 'm2'").get() as {
        stability: number;
      }
    ).stability;
    expect(second).toBeGreaterThan(first);
  });

  it("applyContradiction persists the 0.8 penalty", () => {
    insertMemory(t.db, mem("m3"), seededEmbedding(3));
    applyContradiction(t.db, "m3");
    const row = t.db.prepare("SELECT stability FROM memories WHERE id = 'm3'").get() as {
      stability: number | null;
    };
    expect(row.stability).toBeCloseTo(INITIAL_STABILITY.fact * 0.8, 5);
  });

  it("computeRetrievability uses persisted stability when present", () => {
    const aged = mem("m4");
    const withPersisted: Memory = { ...aged, stability: 300 };
    // Same age, much higher stability -> much higher retrievability
    expect(computeRetrievability(withPersisted)).toBeGreaterThan(computeRetrievability(aged));
  });
});
