/**
 * Query-plan regression guard for the memories full-text lookup.
 *
 * Incident: with `JOIN memories`, SQLite chose idx_memories_active as the
 * outer loop and evaluated `memories_fts MATCH` once per active row — 0.5s
 * for a 3-term query and 9.5s (134s unbounded) for an 80-word prefetch
 * query on the live store. That latency is what blocked /health on the
 * single-threaded server and later got worker threads killed. CROSS JOIN
 * pins memories_fts as the outer loop (single-digit ms). This test asserts
 * the plan so a future "tidy-up" back to JOIN fails loudly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import { buildMemoriesFtsSql } from "../../src/semantic/search.js";
import { buildFtsMatchQuery } from "../../src/_core/search/fts-query.js";

let testDb: TestDb;

beforeAll(() => {
  testDb = createTestDb();
  const { db } = testDb;
  const insert = db.prepare(`
    INSERT INTO memories (id, type, content, confidence, importance, access_count, created_at, is_active, scope)
    VALUES (?, 'fact', ?, 0.8, 0.5, 0, unixepoch(), ?, 'global')
  `);
  const fts = db.prepare("INSERT INTO memories_fts (rowid, content) SELECT rowid, content FROM memories WHERE id = ?");
  for (let i = 0; i < 200; i++) {
    const id = `plan-mem-${i}`;
    insert.run(id, `memory ${i} about gateway shutdown and worker ${i % 7} restarts`, i % 10 === 0 ? 0 : 1);
    fts.run(id);
  }
  db.exec("ANALYZE");
});

afterAll(() => testDb.cleanup());

function planFor(sql: string, ...params: unknown[]): string[] {
  return (testDb.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail);
}

describe("memories FTS query plan", () => {
  const expr = buildFtsMatchQuery("gateway shutdown restarts");

  it("drives from memories_fts (not idx_memories_active) with the is_active filter", () => {
    const sql = buildMemoriesFtsSql(["memories_fts MATCH ?", "m.is_active = 1"]);
    const plan = planFor(sql, expr, 20);
    expect(plan[0]).toMatch(/SCAN fts VIRTUAL TABLE/);
    expect(plan.join(" | ")).not.toMatch(/idx_memories_active/);
    expect(plan.join(" | ")).toMatch(/SEARCH m USING INTEGER PRIMARY KEY/);
  });

  it("keeps the same plan when type and scope filters are added", () => {
    const sql = buildMemoriesFtsSql(["memories_fts MATCH ?", "m.is_active = 1", "m.type IN (?)", "m.scope IN (?)"]);
    const plan = planFor(sql, expr, "fact", "global", 20);
    expect(plan[0]).toMatch(/SCAN fts VIRTUAL TABLE/);
  });

  it("returns only active rows, ranked, within the limit", () => {
    const sql = buildMemoriesFtsSql(["memories_fts MATCH ?", "m.is_active = 1"]);
    const rows = testDb.db.prepare(sql).all(expr, 15) as Array<{ id: string; rank: number }>;
    expect(rows.length).toBe(15);
    const active = new Set(
      (testDb.db.prepare("SELECT id FROM memories WHERE is_active = 1").all() as Array<{ id: string }>).map((r) => r.id),
    );
    for (const r of rows) expect(active.has(r.id)).toBe(true);
    const ranks = rows.map((r) => r.rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});
