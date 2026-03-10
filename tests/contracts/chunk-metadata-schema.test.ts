/**
 * Contract: chunk_metadata table schema and operations.
 *
 * Phase 7C.2 — validates the chunk_metadata table used for
 * adaptive chunking diagnostics exists with the correct schema,
 * supports insert/query, and has the expected index.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";

describe("chunk_metadata table", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it("chunk_metadata table exists in a fresh DB", () => {
    const tables = t.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_metadata'`,
      )
      .all() as { name: string }[];

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("chunk_metadata");
  });

  it("chunk_metadata table has all required columns", () => {
    const cols = t.db.prepare("PRAGMA table_info(chunk_metadata)").all() as {
      name: string;
      type: string;
    }[];
    const colNames = cols.map((c) => c.name);

    const required = [
      "id",
      "conversation_id",
      "chunk_index",
      "start_exchange",
      "end_exchange",
      "exchange_count",
      "avg_density",
      "created_at",
    ];

    for (const col of required) {
      expect(colNames, `missing column: ${col}`).toContain(col);
    }
  });

  it("inserting and querying chunk metadata works", () => {
    const stmt = t.db.prepare(
      `INSERT INTO chunk_metadata (id, conversation_id, chunk_index, start_exchange, end_exchange, exchange_count, avg_density)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    stmt.run("conv-1:0", "conv-1", 0, 0, 10, 10, 0.75);
    stmt.run("conv-1:1", "conv-1", 1, 8, 20, 12, 0.42);
    stmt.run("conv-2:0", "conv-2", 0, 0, 25, 25, null);

    // Query by conversation_id
    const rows = t.db
      .prepare("SELECT * FROM chunk_metadata WHERE conversation_id = ? ORDER BY chunk_index")
      .all("conv-1") as Array<{
        id: string;
        conversation_id: string;
        chunk_index: number;
        start_exchange: number;
        end_exchange: number;
        exchange_count: number;
        avg_density: number | null;
      }>;

    expect(rows).toHaveLength(2);

    expect(rows[0].id).toBe("conv-1:0");
    expect(rows[0].chunk_index).toBe(0);
    expect(rows[0].start_exchange).toBe(0);
    expect(rows[0].end_exchange).toBe(10);
    expect(rows[0].exchange_count).toBe(10);
    expect(rows[0].avg_density).toBeCloseTo(0.75);

    expect(rows[1].id).toBe("conv-1:1");
    expect(rows[1].chunk_index).toBe(1);
    expect(rows[1].avg_density).toBeCloseTo(0.42);

    // Verify null avg_density works
    const conv2 = t.db
      .prepare("SELECT avg_density FROM chunk_metadata WHERE id = ?")
      .get("conv-2:0") as { avg_density: number | null };
    expect(conv2.avg_density).toBeNull();
  });

  it("INSERT OR REPLACE overwrites existing chunk metadata", () => {
    const stmt = t.db.prepare(
      `INSERT OR REPLACE INTO chunk_metadata (id, conversation_id, chunk_index, start_exchange, end_exchange, exchange_count, avg_density)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    stmt.run("conv-1:0", "conv-1", 0, 0, 10, 10, 0.5);
    stmt.run("conv-1:0", "conv-1", 0, 0, 15, 15, 0.8);

    const rows = t.db
      .prepare("SELECT * FROM chunk_metadata WHERE id = ?")
      .all("conv-1:0") as Array<{ exchange_count: number; avg_density: number }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].exchange_count).toBe(15);
    expect(rows[0].avg_density).toBeCloseTo(0.8);
  });

  it("conversation_id index exists", () => {
    const indexes = t.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chunk_metadata'`,
      )
      .all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_chunk_metadata_conversation");
  });
});
