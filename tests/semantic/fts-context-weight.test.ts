/**
 * #42: memories_fts indexes `content` and `context`. The Hermes mirror stores
 * a constant `context` ("mirrored from built-in memory: add") on every
 * mirrored memory, so a query word that only appears in that note must not
 * outrank a memory whose *content* matches.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { insertMemory } from "../../src/semantic/memory.js";
import { buildMemoriesFtsSql, MEMORIES_FTS_WEIGHTS } from "../../src/semantic/search.js";
import { buildFtsMatchQuery } from "../../src/_core/search/fts-query.js";
import { createTestDb, type TestDb } from "../helpers.js";
import type { Memory } from "../../src/semantic/types.js";

let t: TestDb;
beforeEach(() => { t = createTestDb(); });
afterEach(() => { t.cleanup(); });

function vec(seed: number): number[] {
  const v = Array.from({ length: 256 }, (_, i) => Math.sin(seed * 31 + i));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

function mem(id: string, content: string, context?: string): Memory {
  return {
    id, type: "fact", content, context, confidence: 0.5, importance: 0.5, accessCount: 0,
    createdAt: 1_700_000_000, sourceExchanges: [], isActive: true,
  } as Memory;
}

function ftsIds(query: string): string[] {
  const sql = buildMemoriesFtsSql(["memories_fts MATCH ?", "m.is_active = 1"]);
  const expr = buildFtsMatchQuery(query)!;
  return (t.db.prepare(sql).all(expr, 10) as Array<{ id: string }>).map((r) => r.id);
}

describe("memories_fts ranks content above context (#42)", () => {
  it("weights context below content", () => {
    expect(MEMORIES_FTS_WEIGHTS.context).toBeLessThan(MEMORIES_FTS_WEIGHTS.content);
    expect(buildMemoriesFtsSql(["memories_fts MATCH ?"])).toContain(`bm25(memories_fts, ${MEMORIES_FTS_WEIGHTS.content}, ${MEMORIES_FTS_WEIGHTS.context})`);
  });

  it("a content match outranks a memory that matches only through the constant mirror context", () => {
    // Several mirrored memories, each carrying the same context note but unrelated content.
    for (let i = 0; i < 5; i++) {
      insertMemory(t.db, mem(`mirror-${i}`, `Prefers dark terminal themes and short commit messages ${i}`, "mirrored from built-in memory: add"), vec(i));
    }
    insertMemory(t.db, mem("real", "The memory system uses FSRS reinforcement on recall"), vec(99));
    const ids = ftsIds("memory reinforcement");
    expect(ids[0]).toBe("real");
    // still findable through context, just not first
    expect(ftsIds("mirrored memory")).toEqual(expect.arrayContaining(["mirror-0"]));
  });
});
