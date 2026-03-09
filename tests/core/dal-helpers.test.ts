import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import {
  getById,
  getAll,
  insertRow,
  updateRow,
  upsertRow,
  deleteRow,
  count,
  withTransaction,
  insertVector,
  searchVector,
  deleteVector,
  rebuildFts,
  insertFtsRow,
  deleteFtsRow,
  syncFts,
} from "../../src/_core/db/index.js";

describe("DAL helpers", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  // ─── CRUD helpers ───────────────────────────────────────────

  describe("insertRow", () => {
    it("inserts a row into a table", () => {
      const result = insertRow(t.db, "entities", {
        id: "ent-1",
        name: "TypeScript",
        type: "technology",
        description: "A typed superset of JS",
        aliases: "[]",
        first_seen: 1000,
        last_seen: 1000,
        mention_count: 1,
        created_at: 1000,
      });
      expect(result.changes).toBe(1);
    });
  });

  describe("getById", () => {
    it("retrieves a row by ID", () => {
      insertRow(t.db, "entities", {
        id: "ent-1",
        name: "TypeScript",
        type: "technology",
        mention_count: 1,
        created_at: 1000,
      });

      const row = getById<{ id: string; name: string }>(t.db, "entities", "ent-1");
      expect(row).toBeDefined();
      expect(row!.name).toBe("TypeScript");
    });

    it("returns undefined for missing row", () => {
      const row = getById(t.db, "entities", "nonexistent");
      expect(row).toBeUndefined();
    });
  });

  describe("getAll", () => {
    it("returns all rows", () => {
      insertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      });
      insertRow(t.db, "entities", {
        id: "ent-2", name: "JS", type: "technology", mention_count: 2, created_at: 1001,
      });

      const rows = getAll(t.db, "entities");
      expect(rows.length).toBe(2);
    });

    it("filters by where clause", () => {
      insertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      });
      insertRow(t.db, "entities", {
        id: "ent-2", name: "Alice", type: "person", mention_count: 1, created_at: 1000,
      });

      const rows = getAll(t.db, "entities", { type: "person" });
      expect(rows.length).toBe(1);
    });

    it("supports orderBy", () => {
      insertRow(t.db, "entities", {
        id: "ent-1", name: "B", type: "technology", mention_count: 1, created_at: 2000,
      });
      insertRow(t.db, "entities", {
        id: "ent-2", name: "A", type: "technology", mention_count: 1, created_at: 1000,
      });

      const rows = getAll<{ id: string; name: string }>(
        t.db, "entities", undefined, "name ASC",
      );
      expect(rows[0].name).toBe("A");
    });
  });

  describe("updateRow", () => {
    it("updates specified fields", () => {
      insertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      });

      updateRow(t.db, "entities", "ent-1", { name: "TypeScript", mention_count: 5 });

      const row = getById<{ name: string; mention_count: number }>(t.db, "entities", "ent-1");
      expect(row!.name).toBe("TypeScript");
      expect(row!.mention_count).toBe(5);
    });
  });

  describe("upsertRow", () => {
    it("inserts when no conflict", () => {
      upsertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      }, ["id"]);

      const row = getById<{ name: string }>(t.db, "entities", "ent-1");
      expect(row!.name).toBe("TS");
    });

    it("updates on conflict", () => {
      insertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      });

      upsertRow(t.db, "entities", {
        id: "ent-1", name: "TypeScript", type: "technology", mention_count: 5, created_at: 1000,
      }, ["id"]);

      const row = getById<{ name: string; mention_count: number }>(t.db, "entities", "ent-1");
      expect(row!.name).toBe("TypeScript");
      expect(row!.mention_count).toBe(5);
    });
  });

  describe("deleteRow", () => {
    it("deletes a row by ID", () => {
      insertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      });

      deleteRow(t.db, "entities", "ent-1");
      const row = getById(t.db, "entities", "ent-1");
      expect(row).toBeUndefined();
    });
  });

  describe("count", () => {
    it("counts all rows", () => {
      insertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      });
      insertRow(t.db, "entities", {
        id: "ent-2", name: "JS", type: "technology", mention_count: 1, created_at: 1000,
      });

      expect(count(t.db, "entities")).toBe(2);
    });

    it("counts with where clause", () => {
      insertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      });
      insertRow(t.db, "entities", {
        id: "ent-2", name: "Alice", type: "person", mention_count: 1, created_at: 1000,
      });

      expect(count(t.db, "entities", { type: "person" })).toBe(1);
    });
  });

  // ─── Transaction helper ──────────────────────────────────────

  describe("withTransaction", () => {
    it("commits on success", () => {
      withTransaction(t.db, () => {
        insertRow(t.db, "entities", {
          id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
        });
        insertRow(t.db, "entities", {
          id: "ent-2", name: "JS", type: "technology", mention_count: 1, created_at: 1000,
        });
      });

      expect(count(t.db, "entities")).toBe(2);
    });

    it("rolls back on error", () => {
      try {
        withTransaction(t.db, () => {
          insertRow(t.db, "entities", {
            id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
          });
          throw new Error("test rollback");
        });
      } catch {
        // expected
      }

      expect(count(t.db, "entities")).toBe(0);
    });

    it("returns the function result", () => {
      const result = withTransaction(t.db, () => {
        insertRow(t.db, "entities", {
          id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
        });
        return "done";
      });

      expect(result).toBe("done");
    });
  });

  // ─── Vector helpers ──────────────────────────────────────────

  describe("vector helpers", () => {
    const dims = t?.config?.embedding?.dimensions ?? 256;

    function makeEmbedding(seed: number): number[] {
      const emb = new Array(256).fill(0);
      emb[0] = seed;
      emb[1] = 1 - seed;
      return emb;
    }

    it("insertVector and searchVector", () => {
      // Insert entity first (for reference)
      insertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      });

      const emb = makeEmbedding(0.5);
      insertVector(t.db, "vec_entities", "ent-1", emb);

      const results = searchVector(t.db, "vec_entities", emb, 5);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("ent-1");
      expect(results[0].distance).toBeCloseTo(0, 1);
    });

    it("deleteVector removes entry", () => {
      insertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      });

      insertVector(t.db, "vec_entities", "ent-1", makeEmbedding(0.5));
      deleteVector(t.db, "vec_entities", "ent-1");

      const results = searchVector(t.db, "vec_entities", makeEmbedding(0.5), 5);
      expect(results.length).toBe(0);
    });

    it("insertVector replaces existing", () => {
      insertRow(t.db, "entities", {
        id: "ent-1", name: "TS", type: "technology", mention_count: 1, created_at: 1000,
      });

      insertVector(t.db, "vec_entities", "ent-1", makeEmbedding(0.1));
      insertVector(t.db, "vec_entities", "ent-1", makeEmbedding(0.9));

      const results = searchVector(t.db, "vec_entities", makeEmbedding(0.9), 5);
      expect(results.length).toBe(1);
      expect(results[0].distance).toBeCloseTo(0, 1);
    });
  });

  // ─── FTS helpers ────────────────────────────────────────────

  describe("FTS helpers", () => {
    it("insertFtsRow and rebuildFts", () => {
      // Insert a memory with FTS
      insertRow(t.db, "memories", {
        id: "mem-1",
        type: "fact",
        content: "SQLite is a great database",
        confidence: 0.9,
        importance: 0.8,
        access_count: 0,
        created_at: 1000,
        is_active: 1,
      });

      // Get rowid
      const row = t.db.prepare("SELECT rowid FROM memories WHERE id = ?").get("mem-1") as { rowid: number };

      insertFtsRow(t.db, "memories_fts", row.rowid, {
        content: "SQLite is a great database",
        context: null,
      });

      // Search should find it
      const results = t.db
        .prepare("SELECT m.id FROM memories_fts fts JOIN memories m ON m.rowid = fts.rowid WHERE memories_fts MATCH ?")
        .all("SQLite") as Array<{ id: string }>;
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("mem-1");
    });

    it("deleteFtsRow removes entry", () => {
      insertRow(t.db, "memories", {
        id: "mem-1", type: "fact", content: "unique test content",
        confidence: 0.9, importance: 0.8, access_count: 0, created_at: 1000, is_active: 1,
      });

      const row = t.db.prepare("SELECT rowid FROM memories WHERE id = ?").get("mem-1") as { rowid: number };
      insertFtsRow(t.db, "memories_fts", row.rowid, { content: "unique test content", context: null });
      deleteFtsRow(t.db, "memories_fts", row.rowid, { content: "unique test content", context: null });

      const results = t.db
        .prepare("SELECT m.id FROM memories_fts fts JOIN memories m ON m.rowid = fts.rowid WHERE memories_fts MATCH ?")
        .all("unique") as Array<{ id: string }>;
      expect(results.length).toBe(0);
    });

    it("syncFts updates FTS entry", () => {
      insertRow(t.db, "memories", {
        id: "mem-1", type: "fact", content: "old content",
        confidence: 0.9, importance: 0.8, access_count: 0, created_at: 1000, is_active: 1,
      });

      const row = t.db.prepare("SELECT rowid FROM memories WHERE id = ?").get("mem-1") as { rowid: number };
      insertFtsRow(t.db, "memories_fts", row.rowid, { content: "old content", context: null });

      // Update the row content
      updateRow(t.db, "memories", "mem-1", { content: "new content" });

      // Sync FTS
      syncFts(
        t.db, "memories_fts", row.rowid,
        { content: "old content", context: null },
        { content: "new content", context: null },
      );

      // Old search should not find it
      const oldResults = t.db
        .prepare("SELECT m.id FROM memories_fts fts JOIN memories m ON m.rowid = fts.rowid WHERE memories_fts MATCH ?")
        .all("old") as Array<{ id: string }>;
      expect(oldResults.length).toBe(0);

      // New search should find it
      const newResults = t.db
        .prepare("SELECT m.id FROM memories_fts fts JOIN memories m ON m.rowid = fts.rowid WHERE memories_fts MATCH ?")
        .all("new") as Array<{ id: string }>;
      expect(newResults.length).toBe(1);
    });

    it("rebuildFts rebuilds the index", () => {
      // Insert memory and manually sync FTS
      insertRow(t.db, "memories", {
        id: "mem-1", type: "fact", content: "rebuild test content",
        confidence: 0.9, importance: 0.8, access_count: 0, created_at: 1000, is_active: 1,
      });

      // Rebuild should not throw
      expect(() => rebuildFts(t.db, "memories_fts")).not.toThrow();
    });
  });
});
