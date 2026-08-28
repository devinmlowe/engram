import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchSemantic } from "../../src/semantic/search.js";
import { insertMemory } from "../../src/semantic/memory.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { Memory } from "../../src/semantic/types.js";

// ─── Mock embeddings to avoid loading the real model ────────────

vi.mock("../../src/_core/embeddings/index.js", () => ({
  embedQuery: vi.fn(),
}));

import { embedQuery } from "../../src/_core/embeddings/index.js";

const mockedEmbedQuery = vi.mocked(embedQuery);

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

function mem(id: string, content: string, scope?: string): Memory {
  return {
    id,
    type: "fact",
    content,
    confidence: 0.9,
    importance: 0.7,
    accessCount: 0,
    createdAt: Math.floor(Date.now() / 1000),
    sourceExchanges: [],
    isActive: true,
    ...(scope ? { scope } : {}),
  } as Memory;
}

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
  vi.clearAllMocks();
});

// ADR-010: scoped reads — a Hermes profile recalls global + its own scope.
describe("scope-aware semantic memory (ADR-010)", () => {
  it("insertMemory persists scope; missing scope stores 'global'", () => {
    insertMemory(t.db, mem("m-g", "global fact"), seededEmbedding(1));
    insertMemory(t.db, mem("m-c", "career fact", "hermes:career"), seededEmbedding(2));
    const rows = t.db
      .prepare("SELECT id, scope FROM memories ORDER BY id")
      .all() as Array<{ id: string; scope: string }>;
    expect(rows).toEqual([
      { id: "m-c", scope: "hermes:career" },
      { id: "m-g", scope: "global" },
    ]);
  });

  it("searchSemantic filters by scopes when provided", async () => {
    insertMemory(t.db, mem("m-g", "kubernetes deployment strategy"), seededEmbedding(1));
    insertMemory(
      t.db,
      mem("m-c", "kubernetes interview prep notes", "hermes:career"),
      seededEmbedding(2),
    );
    insertMemory(
      t.db,
      mem("m-f", "kubernetes budget spreadsheet", "hermes:finance"),
      seededEmbedding(3),
    );
    mockedEmbedQuery.mockResolvedValue(seededEmbedding(1));

    const careerView = await searchSemantic(t.db, {
      query: "kubernetes",
      scopes: ["global", "hermes:career"],
    });
    const ids = careerView.map((r) => r.id).sort();
    expect(ids).toContain("m-g");
    expect(ids).toContain("m-c");
    expect(ids).not.toContain("m-f");
  });

  it("scoped searchSemantic still finds a tenant memory crowded out of the global top-20", async () => {
    // 40 global memories closer to the query than the tenant's one memory
    const query = seededEmbedding(100);
    for (let i = 0; i < 40; i++) {
      const near = query.map((v, j) => v + seededEmbedding(200 + i)[j] * 0.05);
      insertMemory(t.db, mem(`g-${i}`, `global note ${i}`), near);
    }
    const far = query.map((v, j) => v + seededEmbedding(999)[j] * 0.6);
    insertMemory(t.db, mem("c-1", "career note about interviews", "hermes:career"), far);
    mockedEmbedQuery.mockResolvedValue(query);

    const view = await searchSemantic(t.db, { query: "zzz", scopes: ["hermes:career"], limit: 5 });
    expect(view.map((r) => r.id)).toEqual(["c-1"]);
  });

  it("findNearestMemories with scope finds a same-scope neighbor beyond the global top-6", async () => {
    const { findNearestMemories } = await import("../../src/semantic/memory.js");
    const probe = seededEmbedding(300);
    for (let i = 0; i < 12; i++) {
      const near = probe.map((v, j) => v + seededEmbedding(400 + i)[j] * 0.02);
      insertMemory(t.db, mem(`g-${i}`, `global twin ${i}`), near);
    }
    const twin = probe.map((v, j) => v + seededEmbedding(555)[j] * 0.1);
    insertMemory(t.db, mem("f-1", "finance twin", "hermes:finance"), twin);

    const hits = findNearestMemories(t.db, probe, 3, "hermes:finance");
    expect(hits.map((h) => h.id)).toEqual(["f-1"]);
    // unscoped behaviour unchanged: global neighbours win
    expect(findNearestMemories(t.db, probe, 3).map((h) => h.id)).not.toContain("f-1");
  });

  it("searchSemantic without scopes returns all scopes (backward compatible)", async () => {
    insertMemory(t.db, mem("m-g", "typescript config"), seededEmbedding(1));
    insertMemory(t.db, mem("m-f", "typescript ledger", "hermes:finance"), seededEmbedding(2));
    mockedEmbedQuery.mockResolvedValue(seededEmbedding(1));

    const allView = await searchSemantic(t.db, { query: "typescript" });
    const ids = allView.map((r) => r.id);
    expect(ids).toContain("m-g");
    expect(ids).toContain("m-f");
  });
});
