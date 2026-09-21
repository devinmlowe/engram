/**
 * W11: `engram export` / `engram import` — portable JSONL v1 transfer of
 * memories, entities, relationships, and commitments between databases.
 *
 * Contract pinned here:
 *   - header line first: kind=header, v=1, counts per kind, schema migrations,
 *     and an explicit note that embeddings are NOT in the file
 *   - one record per line: {kind, v, data} with JSON columns decoded
 *   - `--scope` filters memories on export and overrides scope on import
 *   - import is idempotent by id: existing id is updated only when the
 *     incoming record is newer, otherwise skipped
 *   - vectors and FTS rows are regenerated through the existing helpers
 *   - relationships with a missing endpoint are skipped and counted
 *   - a malformed line aborts the import before any write
 *   - `--dry-run` writes nothing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, type TestDb } from "../../helpers.js";
import { insertMemory, getMemory, getMemoryEmbedding } from "../../../src/semantic/memory.js";
import { insertEntity } from "../../../src/graph/entity.js";
import { insertRelationship } from "../../../src/graph/relationship.js";
import { getVector } from "../../../src/_core/db/index.js";
import type { Memory } from "../../../src/semantic/types.js";
import type { Entity, Relationship } from "../../../src/graph/types.js";

// Mock embeddings — same deterministic-vector pattern as remember-contract.
vi.mock("../../../src/_core/embeddings/index.js", () => {
  const dims = 256;
  function deterministicVector(seed: string): number[] {
    const vec = new Array<number>(dims);
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    for (let i = 0; i < dims; i++) {
      hash = ((hash << 5) - hash + i) | 0;
      vec[i] = (hash & 0xffff) / 0xffff - 0.5;
    }
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < dims; i++) vec[i] /= norm;
    return vec;
  }
  return {
    initEmbeddings: vi.fn().mockResolvedValue(undefined),
    embedQuery: vi.fn().mockImplementation((t: string) => Promise.resolve(deterministicVector(`query:${t}`))),
    embedDocument: vi.fn().mockImplementation((t: string) => Promise.resolve(deterministicVector(`doc:${t}`))),
    embedDocumentBatch: vi.fn().mockImplementation((ts: string[]) =>
      Promise.resolve(ts.map((t) => deterministicVector(`doc:${t}`))),
    ),
    getActiveModel: vi.fn().mockReturnValue("mock-model"),
    resetEmbeddings: vi.fn(),
  };
});

import {
  exportLines,
  importLines,
  parseExportLine,
  ImportFormatError,
  EXPORT_FORMAT_VERSION,
  ALL_KINDS,
  type ExportHeader,
  type ExportRecord,
  type ImportSummary,
} from "../../../src/interfaces/cli/transfer.js";

const NOW = 1_760_000_000;
const ZERO = new Array<number>(256).fill(0).map((_, i) => (i === 0 ? 1 : 0));

function mem(overrides: Partial<Memory> & { id: string; content: string }): Memory {
  return {
    type: "fact",
    confidence: 0.8,
    importance: 0.6,
    accessCount: 2,
    createdAt: NOW - 100,
    updatedAt: NOW - 50,
    sourceExchanges: ["exch-1", "exch-2"],
    isActive: true,
    source: "dream",
    scope: "global",
    stability: 12.5,
    eventTs: NOW - 5000,
    extractionBasis: "explicit",
    ...overrides,
  };
}

function ent(overrides: Partial<Entity> & { id: string; name: string }): Entity {
  return {
    type: "tool",
    description: `${overrides.name} description`,
    aliases: [overrides.name.toLowerCase()],
    firstSeen: NOW - 200,
    lastSeen: NOW - 10,
    mentionCount: 3,
    createdAt: NOW - 200,
    ...overrides,
  };
}

function rel(overrides: Partial<Relationship> & { id: string }): Relationship {
  return {
    sourceEntityId: "ent-a",
    targetEntityId: "ent-b",
    type: "uses",
    weight: 0.7,
    context: "a uses b",
    sourceMemories: ["mem-global-1"],
    createdAt: NOW - 90,
    updatedAt: NOW - 40,
    ...overrides,
  };
}

/** Seed: 3 active memories (2 global, 1 hermes:career), 1 inactive, 2 entities, 1 relationship, 1 commitment. */
function seed(t: TestDb): void {
  insertMemory(t.db, mem({ id: "mem-global-1", content: "Devin prefers the Fish shell" }), ZERO);
  insertMemory(t.db, mem({ id: "mem-global-2", content: "engram uses sqlite-vec for vectors", type: "pattern" }), ZERO);
  insertMemory(
    t.db,
    mem({ id: "mem-career-1", content: "Boeing application closes in September", scope: "hermes:career" }),
    ZERO,
  );
  insertMemory(
    t.db,
    mem({ id: "mem-inactive-1", content: "an old superseded fact", isActive: false, supersededBy: "mem-global-1" }),
    ZERO,
  );
  insertEntity(t.db, ent({ id: "ent-a", name: "Engram", type: "project" }), ZERO);
  insertEntity(t.db, ent({ id: "ent-b", name: "SQLite" }), ZERO);
  insertRelationship(t.db, rel({ id: "rel-1" }));
  t.db
    .prepare(
      `INSERT INTO commitments (id, content, status, origin, subject, source_exchanges, due_at, created_at, resolved_at, superseded_by)
       VALUES (?, ?, 'pending', 'stated', 'devin', ?, ?, ?, NULL, NULL)`,
    )
    .run("cmt-1", "Send the Boeing application", JSON.stringify(["exch-2"]), NOW + 86400, NOW - 30);
}

function parseAll(lines: string[]): { header: ExportHeader; records: ExportRecord[] } {
  const parsed = lines.map((l, i) => parseExportLine(l, i + 1));
  const header = parsed[0] as ExportHeader;
  return { header, records: parsed.slice(1) as ExportRecord[] };
}

function countRows(db: TestDb["db"], table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

let a: TestDb;
let b: TestDb;

beforeEach(() => {
  a = createTestDb();
  b = createTestDb();
  seed(a);
});

afterEach(() => {
  a.cleanup();
  b.cleanup();
});

describe("export", () => {
  it("writes a v1 header whose counts match the database (active memories only by default)", () => {
    const lines = exportLines(a.db);
    const { header, records } = parseAll(lines);

    expect(header.kind).toBe("header");
    expect(header.v).toBe(EXPORT_FORMAT_VERSION);
    expect(typeof header.exported_at).toBe("string");
    expect(Array.isArray(header.schema_version)).toBe(true);
    expect(header.schema_version).toContain("commitments_v1");
    expect(header.embeddings).toMatch(/not exported/i);
    expect(header.counts).toEqual({ memories: 3, entities: 2, relationships: 1, commitments: 1 });

    const byKind = (k: string) => records.filter((r) => r.kind === k).length;
    expect(byKind("memory")).toBe(3);
    expect(byKind("entity")).toBe(2);
    expect(byKind("relationship")).toBe(1);
    expect(byKind("commitment")).toBe(1);
    expect(records.every((r) => r.v === 1)).toBe(true);
    expect(records.map((r) => r.data.id)).not.toContain("mem-inactive-1");
  });

  it("decodes JSON columns and booleans in memory records", () => {
    const { records } = parseAll(exportLines(a.db));
    const m = records.find((r) => r.data.id === "mem-global-1")!.data;
    expect(m.source_exchanges).toEqual(["exch-1", "exch-2"]);
    expect(m.is_active).toBe(true);
    expect(m.stability).toBe(12.5);
    expect(m.scope).toBe("global");
    expect(m.extraction_basis).toBe("explicit");
    const e = records.find((r) => r.data.id === "ent-b")!.data;
    expect(e.aliases).toEqual(["sqlite"]);
    const r = records.find((r) => r.data.id === "rel-1")!.data;
    expect(r.source_memories).toEqual(["mem-global-1"]);
    const c = records.find((r) => r.data.id === "cmt-1")!.data;
    expect(c.source_exchanges).toEqual(["exch-2"]);
  });

  it("includes inactive memories with includeInactive", () => {
    const { header, records } = parseAll(exportLines(a.db, { includeInactive: true }));
    expect(header.counts.memories).toBe(4);
    const inactive = records.find((r) => r.data.id === "mem-inactive-1")!.data;
    expect(inactive.is_active).toBe(false);
    expect(inactive.superseded_by).toBe("mem-global-1");
  });

  it("never exports forgotten memories, even with includeInactive (#55)", () => {
    a.db
      .prepare("UPDATE memories SET is_active = 0, deleted_at = '2026-09-17T00:00:00.000Z', deleted_by = 'cli' WHERE id = 'mem-global-1'")
      .run();
    const { header, records } = parseAll(exportLines(a.db, { includeInactive: true }));
    expect(header.counts.memories).toBe(3);
    expect(records.find((r) => r.data.id === "mem-global-1")).toBeUndefined();
    const active = parseAll(exportLines(a.db));
    expect(active.records.find((r) => r.data.id === "mem-global-1")).toBeUndefined();
  });

  it("--scope exports only memories in that scope", () => {
    const { header, records } = parseAll(exportLines(a.db, { scopes: ["hermes:career"] }));
    expect(header.counts.memories).toBe(1);
    expect(header.scopes).toEqual(["hermes:career"]);
    const mems = records.filter((r) => r.kind === "memory");
    expect(mems.map((r) => r.data.id)).toEqual(["mem-career-1"]);
    expect(mems[0].data.scope).toBe("hermes:career");
  });

  it("--kinds restricts the exported record kinds", () => {
    const { header, records } = parseAll(exportLines(a.db, { kinds: ["memories", "commitments"] }));
    expect(header.counts).toEqual({ memories: 3, commitments: 1 });
    expect(new Set(records.map((r) => r.kind))).toEqual(new Set(["memory", "commitment"]));
    expect(ALL_KINDS).toEqual(["memories", "entities", "relationships", "commitments"]);
  });
});

describe("import round-trip", () => {
  it("export A -> import into empty B yields equal counts, equal fields, and searchable FTS/vectors", async () => {
    const lines = exportLines(a.db, { includeInactive: true });
    const summary = await importLines(b.db, lines);

    expect(summary.memories).toEqual({ inserted: 4, updated: 0, skipped: 0 });
    expect(summary.entities).toEqual({ inserted: 2, updated: 0, skipped: 0 });
    expect(summary.relationships).toEqual({ inserted: 1, updated: 0, skipped: 0, missingEndpoint: 0 });
    expect(summary.commitments).toEqual({ inserted: 1, updated: 0, skipped: 0 });

    for (const table of ["memories", "entities", "relationships", "commitments"]) {
      expect(countRows(b.db, table)).toBe(countRows(a.db, table));
    }

    const orig = getMemory(a.db, "mem-career-1")!;
    const copy = getMemory(b.db, "mem-career-1")!;
    expect(copy).toEqual(orig);
    expect(copy.stability).toBe(12.5);
    expect(copy.scope).toBe("hermes:career");
    expect(copy.isActive).toBe(true);
    expect(copy.eventTs).toBe(NOW - 5000);
    expect(getMemory(b.db, "mem-inactive-1")!.isActive).toBe(false);

    // Every raw column round-trips, including ones the Memory type omits.
    const rawA = a.db.prepare("SELECT * FROM memories WHERE id = ?").get("mem-global-2");
    const rawB = b.db.prepare("SELECT * FROM memories WHERE id = ?").get("mem-global-2");
    expect(rawB).toEqual(rawA);
    const entA = a.db.prepare("SELECT * FROM entities WHERE id = ?").get("ent-b");
    const entB = b.db.prepare("SELECT * FROM entities WHERE id = ?").get("ent-b");
    expect(entB).toEqual(entA);
    const cmtA = a.db.prepare("SELECT * FROM commitments WHERE id = ?").get("cmt-1");
    const cmtB = b.db.prepare("SELECT * FROM commitments WHERE id = ?").get("cmt-1");
    expect(cmtB).toEqual(cmtA);

    // FTS was regenerated through the helpers (external-content tables).
    const ftsHits = b.db
      .prepare("SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?")
      .all("Boeing") as Array<{ id: string }>;
    expect(ftsHits.map((r) => r.id)).toEqual(["mem-career-1"]);
    const entHits = b.db
      .prepare("SELECT e.id FROM entities_fts f JOIN entities e ON e.rowid = f.rowid WHERE entities_fts MATCH ?")
      .all("SQLite") as Array<{ id: string }>;
    expect(entHits.map((r) => r.id)).toEqual(["ent-b"]);

    // Vectors were regenerated from content (not copied — A holds a fixed unit vector).
    const vec = getMemoryEmbedding(b.db, "mem-career-1")!;
    expect(vec).toHaveLength(256);
    expect(vec).not.toEqual(ZERO);
    expect(getVector(b.db, "vec_entities", "ent-b")).toHaveLength(256);
  });

  it("is idempotent by id: a second import inserts nothing and skips everything", async () => {
    const lines = exportLines(a.db);
    await importLines(b.db, lines);
    const second = await importLines(b.db, lines);

    expect(second.memories).toEqual({ inserted: 0, updated: 0, skipped: 3 });
    expect(second.entities).toEqual({ inserted: 0, updated: 0, skipped: 2 });
    expect(second.relationships).toEqual({ inserted: 0, updated: 0, skipped: 1, missingEndpoint: 0 });
    expect(second.commitments).toEqual({ inserted: 0, updated: 0, skipped: 1 });
    expect(countRows(b.db, "memories")).toBe(3);
    // FTS index has exactly one row per memory (no duplicate tokens).
    const ftsHits = b.db.prepare("SELECT COUNT(*) AS c FROM memories_fts WHERE memories_fts MATCH ?").get("Fish") as { c: number };
    expect(ftsHits.c).toBe(1);
  });

  it("updates an existing id in place only when the incoming record is newer", async () => {
    await importLines(b.db, exportLines(a.db));

    // Newer copy of mem-global-1 in A: content changed, updated_at bumped.
    a.db
      .prepare("UPDATE memories SET content = ?, updated_at = ?, importance = 0.99 WHERE id = ?")
      .run("Devin prefers the Fish shell over zsh", NOW + 10, "mem-global-1");
    // Older copy of mem-global-2: updated_at rolled back — must be skipped.
    a.db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?").run("stale", NOW - 999, "mem-global-2");

    const summary = await importLines(b.db, exportLines(a.db));
    expect(summary.memories).toEqual({ inserted: 0, updated: 1, skipped: 2 });

    const updated = getMemory(b.db, "mem-global-1")!;
    expect(updated.content).toBe("Devin prefers the Fish shell over zsh");
    expect(updated.importance).toBe(0.99);
    expect(updated.updatedAt).toBe(NOW + 10);
    expect(getMemory(b.db, "mem-global-2")!.content).toBe("engram uses sqlite-vec for vectors");

    // FTS resynced: new token found, old-only token count unchanged at 1.
    const zsh = b.db.prepare("SELECT COUNT(*) AS c FROM memories_fts WHERE memories_fts MATCH ?").get("zsh") as { c: number };
    expect(zsh.c).toBe(1);
    const fish = b.db.prepare("SELECT COUNT(*) AS c FROM memories_fts WHERE memories_fts MATCH ?").get("Fish") as { c: number };
    expect(fish.c).toBe(1);
  });

  it("--scope override rewrites the scope on every imported memory", async () => {
    const summary = await importLines(b.db, exportLines(a.db), { scope: "hermes:personal" });
    expect(summary.memories.inserted).toBe(3);
    const scopes = b.db.prepare("SELECT DISTINCT scope FROM memories").all() as Array<{ scope: string }>;
    expect(scopes.map((s) => s.scope)).toEqual(["hermes:personal"]);
    expect(getMemory(b.db, "mem-career-1")!.scope).toBe("hermes:personal");
  });

  it("skips and counts relationships whose endpoints are missing", async () => {
    const lines = exportLines(a.db, { kinds: ["memories", "relationships", "commitments"] });
    const summary = await importLines(b.db, lines);
    expect(summary.relationships).toEqual({ inserted: 0, updated: 0, skipped: 1, missingEndpoint: 1 });
    expect(countRows(b.db, "relationships")).toBe(0);
    expect(summary.memories.inserted).toBe(3);
  });

  it("rejects a malformed line before writing anything", async () => {
    const lines = exportLines(a.db);
    lines.splice(2, 0, '{"kind":"memory","v":1,"data":{"id":"broken"');
    await expect(importLines(b.db, lines)).rejects.toThrow(ImportFormatError);
    await expect(importLines(b.db, lines)).rejects.toThrow(/line 3/);
    expect(countRows(b.db, "memories")).toBe(0);
    expect(countRows(b.db, "entities")).toBe(0);

    const unknownKind = [lines[0], '{"kind":"widget","v":1,"data":{"id":"x"}}'];
    await expect(importLines(b.db, unknownKind)).rejects.toThrow(ImportFormatError);
    const badVersion = [lines[0], '{"kind":"memory","v":2,"data":{"id":"x"}}'];
    await expect(importLines(b.db, badVersion)).rejects.toThrow(ImportFormatError);
    const missingRequired = [lines[0], '{"kind":"memory","v":1,"data":{"id":"x"}}'];
    await expect(importLines(b.db, missingRequired)).rejects.toThrow(ImportFormatError);
    expect(countRows(b.db, "memories")).toBe(0);
  });

  it("--dry-run reports what would happen and writes nothing", async () => {
    const lines = exportLines(a.db);
    const summary: ImportSummary = await importLines(b.db, lines, { dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.memories).toEqual({ inserted: 3, updated: 0, skipped: 0 });
    expect(summary.entities).toEqual({ inserted: 2, updated: 0, skipped: 0 });
    expect(summary.relationships).toEqual({ inserted: 1, updated: 0, skipped: 0, missingEndpoint: 0 });
    expect(summary.commitments).toEqual({ inserted: 1, updated: 0, skipped: 0 });
    for (const table of ["memories", "entities", "relationships", "commitments", "vec_memories", "vec_entities"]) {
      expect(countRows(b.db, table)).toBe(0);
    }
  });

  it("reports progress in batches", async () => {
    const seen: Array<[number, number]> = [];
    await importLines(b.db, exportLines(a.db), {
      batchSize: 2,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toEqual([7, 7]);
  });
});
