/**
 * #55 forget tool — semantic layer.
 *
 * Decision #56: soft delete + retention purge, vector/FTS rows removed
 * immediately. Decision #57: forget decrements graph counts and flags
 * stale_since; dream prune deletes flagged orphans. One test per recall
 * path proves a forgotten memory stays out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import {
  insertMemory,
  findNearestMemories,
  getActiveMemories,
  getMemory,
  getMemoryEmbedding,
  recordAccess,
  deactivateMemory,
} from "../../src/semantic/memory.js";
import { searchSemantic } from "../../src/semantic/search.js";
import {
  forgetMemory,
  editMemory,
  restoreMemory,
  purgeConversation,
  purgeForgottenMemories,
  filterSuppressedFacts,
  isSuppressed,
  clearSuppression,
  contentHash,
  detachMemoryEvidence,
  MemoryNotFoundError,
  MemoryScopeError,
  MemoryAlreadyForgottenError,
} from "../../src/semantic/forget.js";
import { listMemories, getMemoryProvenance, listMemoryChanges, resolveMemoryId } from "../../src/semantic/inspect.js";
import { drillIntoResult } from "../../src/_core/search/drill.js";
import { pruneOrphanEntities } from "../../src/graph/reflection.js";
import { linkMemoryToEntities } from "../../src/interfaces/shared/remember.js";
import { recordEntityMention } from "../../src/graph/entity.js";
import { findOrCreateRelationship } from "../../src/graph/relationship.js";
import type { Memory } from "../../src/semantic/types.js";

// ─── Deterministic embeddings ───────────────────────────────────

const DIMS = 256;
function vec(seed: string): number[] {
  const v = new Array(DIMS);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  for (let i = 0; i < DIMS; i++) {
    hash = ((hash << 5) - hash + i) | 0;
    v[i] = (hash & 0xffff) / 0xffff - 0.5;
  }
  const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0));
  return v.map((x: number) => x / norm);
}

vi.mock("../../src/_core/embeddings/index.js", () => ({
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  embedQuery: vi.fn().mockImplementation((text: string) => Promise.resolve(vec(`doc:${text}`))),
  embedDocument: vi.fn().mockImplementation((text: string) => Promise.resolve(vec(`doc:${text}`))),
  embedDocumentBatch: vi.fn().mockImplementation((texts: string[]) => Promise.resolve(texts.map((t) => vec(`doc:${t}`)))),
  getActiveModel: vi.fn().mockReturnValue("mock-model"),
  resetEmbeddings: vi.fn(),
}));

// ─── Fixtures ───────────────────────────────────────────────────

let t: TestDb;

function seed(id: string, content: string, extra: Partial<Memory> = {}): Memory {
  const memory: Memory = {
    id,
    type: "fact",
    content,
    confidence: 0.9,
    importance: 0.7,
    accessCount: 0,
    createdAt: Math.floor(Date.now() / 1000),
    sourceExchanges: [],
    isActive: true,
    source: "user",
    scope: "global",
    ...extra,
  };
  insertMemory(t.db, memory, vec(`doc:${content}`));
  return memory;
}

function ftsRowids(): number[] {
  t.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.mem_vocab USING fts5vocab('main', 'memories_fts', 'instance')");
  try {
    return (t.db.prepare("SELECT DISTINCT doc FROM temp.mem_vocab").all() as Array<{ doc: number }>).map((r) => r.doc);
  } finally {
    t.db.exec("DROP TABLE IF EXISTS temp.mem_vocab");
  }
}

function rowidOf(id: string): number {
  return (t.db.prepare("SELECT rowid FROM memories WHERE id = ?").get(id) as { rowid: number }).rowid;
}

function ftsHits(term: string): string[] {
  return (
    t.db
      .prepare("SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?")
      .all(term) as Array<{ id: string }>
  ).map((r) => r.id);
}

function addEntity(id: string, name: string, mentionCount = 1): void {
  t.db
    .prepare("INSERT INTO entities (id, name, type, mention_count, first_seen, last_seen) VALUES (?, ?, 'concept', ?, unixepoch(), unixepoch())")
    .run(id, name, mentionCount);
}

function entity(id: string): { mention_count: number; stale_since: string | null } | undefined {
  return t.db.prepare("SELECT mention_count, stale_since FROM entities WHERE id = ?").get(id) as
    | { mention_count: number; stale_since: string | null }
    | undefined;
}

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

// ─── Soft delete (#56) ──────────────────────────────────────────

describe("forgetMemory", () => {
  it("soft-deletes in one transaction: flags, unindexes, logs and suppresses", () => {
    seed("m1", "The zebrafish lab moved to building 7");
    const rowid = rowidOf("m1");
    expect(ftsRowids()).toContain(rowid);
    expect(getMemoryEmbedding(t.db, "m1")).not.toBeNull();

    const now = new Date("2026-09-17T10:00:00.000Z");
    const result = forgetMemory(t.db, { memoryId: "m1", actor: "claude-code", now });

    expect(result).toMatchObject({ memoryId: "m1", hard: false, scope: "global", deletedAt: now.toISOString() });
    const row = t.db.prepare("SELECT is_active, deleted_at, deleted_by FROM memories WHERE id = 'm1'").get() as {
      is_active: number;
      deleted_at: string;
      deleted_by: string;
    };
    expect(row).toEqual({ is_active: 0, deleted_at: now.toISOString(), deleted_by: "claude-code" });

    // vector + FTS rows are gone immediately
    expect(getMemoryEmbedding(t.db, "m1")).toBeNull();
    expect(ftsRowids()).not.toContain(rowid);
    expect(ftsHits("zebrafish")).toEqual([]);

    // change log row with before = content and the actor
    const changes = listMemoryChanges(t.db, { memoryId: "m1" });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ op: "forget", before: "The zebrafish lab moved to building 7", after: null, actor: "claude-code", at: now.toISOString() });

    // suppression hash
    expect(isSuppressed(t.db, "the zebrafish lab moved to building 7!")).toBe(true);
    const sup = t.db.prepare("SELECT memory_id, scope FROM memory_suppressions WHERE content_hash = ?").get(contentHash("The zebrafish lab moved to building 7")) as { memory_id: string; scope: string };
    expect(sup).toEqual({ memory_id: "m1", scope: "global" });
  });

  it("throws for an unknown id, and refuses to soft-forget twice", () => {
    expect(() => forgetMemory(t.db, { memoryId: "nope", actor: "cli" })).toThrow(MemoryNotFoundError);
    seed("m1", "one");
    forgetMemory(t.db, { memoryId: "m1", actor: "cli" });
    expect(() => forgetMemory(t.db, { memoryId: "m1", actor: "cli" })).toThrow(MemoryAlreadyForgottenError);
    expect(listMemoryChanges(t.db, { memoryId: "m1" })).toHaveLength(1);
  });

  it("hard: true deletes the row outright and logs forget + purge", () => {
    seed("m1", "hard delete me");
    const result = forgetMemory(t.db, { memoryId: "m1", actor: "cli", hard: true });
    expect(result.hard).toBe(true);
    expect(getMemory(t.db, "m1")).toBeNull();
    expect(getMemoryEmbedding(t.db, "m1")).toBeNull();
    expect(listMemoryChanges(t.db, { memoryId: "m1" }).map((c) => c.op)).toEqual(["purge", "forget"]);
    // suppression survives the row
    expect(isSuppressed(t.db, "hard delete me")).toBe(true);
  });

  it("hard: true on an already-forgotten memory purges it (retention bypass) without double-unindexing", () => {
    seed("m1", "soft then hard");
    forgetMemory(t.db, { memoryId: "m1", actor: "cli" });
    const result = forgetMemory(t.db, { memoryId: "m1", actor: "cli", hard: true });
    expect(result.hard).toBe(true);
    expect(getMemory(t.db, "m1")).toBeNull();
    expect(() => t.db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')").run()).not.toThrow();
    expect(listMemoryChanges(t.db, { memoryId: "m1" }).map((c) => c.op)).toEqual(["purge", "forget"]);
  });

  it("unindexes a superseded (inactive but still indexed) memory too", () => {
    seed("old", "old version of the fact");
    seed("new", "new version of the fact");
    deactivateMemory(t.db, "old", "new");
    expect(ftsRowids()).toContain(rowidOf("old"));
    forgetMemory(t.db, { memoryId: "old", actor: "cli" });
    expect(ftsRowids()).not.toContain(rowidOf("old"));
    expect(getMemoryEmbedding(t.db, "old")).toBeNull();
    expect(() => t.db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')").run()).not.toThrow();
  });
});

// ─── Every recall path stays clean ──────────────────────────────

describe("forgotten memories stay out of every recall path", () => {
  const CONTENT = "Prefer pnpm over npm for the frontend monorepo";

  beforeEach(() => {
    seed("m1", CONTENT);
    seed("m2", "Unrelated: the office plant is watered on Fridays");
    forgetMemory(t.db, { memoryId: "m1", actor: "cli" });
  });

  it("vector path (findNearestMemories)", () => {
    const ids = findNearestMemories(t.db, vec(`doc:${CONTENT}`), 5).map((r) => r.id);
    expect(ids).not.toContain("m1");
    expect(ids).toContain("m2");
  });

  it("FTS path (memories_fts MATCH)", () => {
    expect(ftsHits("pnpm")).toEqual([]);
    expect(ftsHits("plant")).toEqual(["m2"]);
  });

  it("hybrid semantic search (vector + FTS + RRF)", async () => {
    const results = await searchSemantic(t.db, { query: CONTENT, limit: 10 });
    expect(results.map((r) => r.id)).not.toContain("m1");
  });

  it("session drill (recall_drill on a stale session result)", async () => {
    await expect(
      drillIntoResult({ id: "m1", source: "semantic", score: 1, content: CONTENT, metadata: { type: "fact" }, tokenEstimate: 10 }, t.db),
    ).rejects.toThrow(/forgotten/);
  });

  it("reinforcement (recordAccess is a no-op)", () => {
    const before = t.db.prepare("SELECT access_count, stability FROM memories WHERE id = 'm1'").get();
    recordAccess(t.db, "m1");
    expect(t.db.prepare("SELECT access_count, stability FROM memories WHERE id = 'm1'").get()).toEqual(before);
    recordAccess(t.db, "m2");
    expect((t.db.prepare("SELECT access_count FROM memories WHERE id = 'm2'").get() as { access_count: number }).access_count).toBe(1);
  });

  it("decay / prune scan and consolidation dedup (active-only readers)", () => {
    expect(getActiveMemories(t.db).map((m) => m.id)).toEqual(["m2"]);
    // The dream prune scan reads the same predicate
    const scanned = t.db.prepare("SELECT id FROM memories WHERE is_active = 1").all() as Array<{ id: string }>;
    expect(scanned.map((r) => r.id)).toEqual(["m2"]);
  });

  it("listing (memories list) hides it unless --deleted is asked for", () => {
    expect(listMemories(t.db).map((m) => m.id)).toEqual(["m2"]);
    const withDeleted = listMemories(t.db, { includeDeleted: true });
    expect(withDeleted.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(withDeleted.find((m) => m.id === "m1")?.deletedBy).toBe("cli");
  });
});

// ─── Graph (#57) ────────────────────────────────────────────────

describe("forget and the graph (#57)", () => {
  it("decrements mention_count on evidenced entities, flags stale_since at 0, never deletes", () => {
    addEntity("e-a", "Alpha", 1);
    addEntity("e-b", "Beta", 1);
    seed("m1", "Alpha depends on Beta");
    // remember's entity linking: bumps both to 2 and creates one related_to edge evidenced by m1
    expect(linkMemoryToEntities(t.db, "m1", ["Alpha", "Beta"])).toBe(2);
    expect(entity("e-a")!.mention_count).toBe(2);

    // Alpha loses one mention (still evidenced elsewhere); simulate Beta having only this evidence
    t.db.prepare("UPDATE entities SET mention_count = 1 WHERE id = 'e-b'").run();

    const now = new Date("2026-09-17T12:00:00.000Z");
    const result = forgetMemory(t.db, { memoryId: "m1", actor: "cli", now });

    expect(result.graph.entities.map((e) => ({ id: e.id, mentionCount: e.mentionCount, stale: e.stale })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "e-a", mentionCount: 1, stale: false },
      { id: "e-b", mentionCount: 0, stale: true },
    ]);
    expect(entity("e-a")).toEqual({ mention_count: 1, stale_since: null });
    expect(entity("e-b")).toEqual({ mention_count: 0, stale_since: now.toISOString() });

    // relationship kept, evidence emptied, flagged
    const rel = t.db.prepare("SELECT source_memories, stale_since, weight FROM relationships").get() as { source_memories: string; stale_since: string; weight: number };
    expect(JSON.parse(rel.source_memories)).toEqual([]);
    expect(rel.stale_since).toBe(now.toISOString());
    expect(rel.weight).toBe(1.0);
    expect(result.graph.relationships).toEqual([{ id: expect.any(String), remainingEvidence: 0, stale: true }]);

    // nothing was deleted
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number }).n).toBe(2);
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM relationships").get() as { n: number }).n).toBe(1);
  });

  it("an entity still evidenced by another memory keeps a positive count and no flag", () => {
    addEntity("e-a", "Alpha", 1);
    addEntity("e-b", "Beta", 1);
    seed("m1", "first fact about alpha and beta");
    seed("m2", "second fact about alpha and beta");
    linkMemoryToEntities(t.db, "m1", ["Alpha", "Beta"]);
    linkMemoryToEntities(t.db, "m2", ["Alpha", "Beta"]);
    expect(entity("e-a")!.mention_count).toBe(3);
    const rel = t.db.prepare("SELECT id, source_memories, weight FROM relationships").get() as { id: string; source_memories: string; weight: number };
    expect(JSON.parse(rel.source_memories)).toEqual(["m1", "m2"]);
    expect(rel.weight).toBe(1.5);

    forgetMemory(t.db, { memoryId: "m1", actor: "cli" });
    expect(entity("e-a")).toEqual({ mention_count: 2, stale_since: null });
    const after = t.db.prepare("SELECT source_memories, stale_since, weight FROM relationships").get() as { source_memories: string; stale_since: string | null; weight: number };
    expect(JSON.parse(after.source_memories)).toEqual(["m2"]);
    expect(after.stale_since).toBeNull();
    expect(after.weight).toBe(1.0);
  });

  it("fresh evidence clears stale_since", () => {
    addEntity("e-a", "Alpha", 1);
    addEntity("e-b", "Beta", 1);
    seed("m1", "alpha beta");
    linkMemoryToEntities(t.db, "m1", ["Alpha", "Beta"]);
    t.db.prepare("UPDATE entities SET mention_count = 1").run();
    forgetMemory(t.db, { memoryId: "m1", actor: "cli" });
    expect(entity("e-a")!.stale_since).not.toBeNull();

    recordEntityMention(t.db, "e-a");
    expect(entity("e-a")).toEqual({ mention_count: 1, stale_since: null });

    const relId = (t.db.prepare("SELECT id FROM relationships").get() as { id: string }).id;
    findOrCreateRelationship(t.db, "e-a", "e-b", "related_to", undefined, "m9");
    expect((t.db.prepare("SELECT stale_since FROM relationships WHERE id = ?").get(relId) as { stale_since: string | null }).stale_since).toBeNull();
  });

  it("detachMemoryEvidence handles nested one-element arrays in source_memories", () => {
    addEntity("e-a", "Alpha", 2);
    addEntity("e-b", "Beta", 2);
    t.db
      .prepare("INSERT INTO relationships (id, source_entity_id, target_entity_id, type, weight, source_memories) VALUES ('r1', 'e-a', 'e-b', 'uses', 1.5, ?)")
      .run(JSON.stringify([["m1"], "conv-1"]));
    const touch = detachMemoryEvidence(t.db, "m1", "2026-09-17T00:00:00.000Z");
    expect(touch.relationships).toEqual([{ id: "r1", remainingEvidence: 1, stale: false }]);
    expect(JSON.parse((t.db.prepare("SELECT source_memories FROM relationships WHERE id = 'r1'").get() as { source_memories: string }).source_memories)).toEqual(["conv-1"]);
  });

  it("pruneOrphanEntities removes stale rows with zero evidence regardless of age, keeps the rest", () => {
    addEntity("e-a", "Alpha", 1);
    addEntity("e-b", "Beta", 1);
    addEntity("e-c", "Gamma", 5);
    seed("m1", "alpha and beta");
    linkMemoryToEntities(t.db, "m1", ["Alpha", "Beta"]);
    t.db.prepare("UPDATE entities SET mention_count = 1 WHERE id IN ('e-a', 'e-b')").run();
    forgetMemory(t.db, { memoryId: "m1", actor: "cli" });
    // Gamma is flagged but still has a mention: must survive
    t.db.prepare("UPDATE entities SET stale_since = '2026-09-01T00:00:00Z' WHERE id = 'e-c'").run();

    const result = pruneOrphanEntities(t.db, { minMentions: 2, maxAgeDays: 90 });
    expect(result.staleRelationshipsPruned).toBe(1);
    expect(result.staleEntitiesPruned).toBe(2);
    expect(result.pruned).toBe(2);
    expect((t.db.prepare("SELECT id FROM entities ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["e-c"]);
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM relationships").get() as { n: number }).n).toBe(0);
  });

  it("pruneOrphanEntities keeps a stale entity whose relationship still has evidence", () => {
    addEntity("e-a", "Alpha", 0);
    addEntity("e-b", "Beta", 3);
    t.db.prepare("UPDATE entities SET stale_since = '2026-09-01T00:00:00Z' WHERE id = 'e-a'").run();
    t.db
      .prepare("INSERT INTO relationships (id, source_entity_id, target_entity_id, type, weight, source_memories, stale_since) VALUES ('r1', 'e-a', 'e-b', 'uses', 1.0, ?, '2026-09-01T00:00:00Z')")
      .run(JSON.stringify(["m-other"]));
    const result = pruneOrphanEntities(t.db);
    expect(result.staleRelationshipsPruned).toBe(0);
    expect(result.staleEntitiesPruned).toBe(0);
    expect(entity("e-a")).toBeDefined();
  });
});

// ─── Scope (#25) ────────────────────────────────────────────────

describe("forget respects read_scopes", () => {
  beforeEach(() => {
    seed("career", "Databricks interview is on Thursday", { scope: "hermes:career" });
    seed("home", "The boiler service is due in October", { scope: "hermes:home" });
  });

  it("refuses a memory outside read_scopes", () => {
    expect(() => forgetMemory(t.db, { memoryId: "home", actor: "hermes", readScopes: ["global", "hermes:career"] })).toThrow(MemoryScopeError);
    expect(getMemory(t.db, "home")!.isActive).toBe(true);
    expect(listMemoryChanges(t.db)).toEqual([]);
  });

  it("acts within read_scopes, and scope: \"global\" overrides the gate", () => {
    forgetMemory(t.db, { memoryId: "career", actor: "hermes", readScopes: ["global", "hermes:career"] });
    expect(getMemory(t.db, "career")!.isActive).toBe(false);
    forgetMemory(t.db, { memoryId: "home", actor: "hermes", readScopes: ["global", "hermes:career"], scope: "global" });
    expect(getMemory(t.db, "home")!.isActive).toBe(false);
  });

  it("no read_scopes = every scope (CLI default)", () => {
    forgetMemory(t.db, { memoryId: "home", actor: "cli" });
    expect(getMemory(t.db, "home")!.deletedBy).toBe("cli");
  });
});

// ─── Edit / restore ─────────────────────────────────────────────

describe("editMemory / restoreMemory", () => {
  it("edit replaces content, re-indexes, and logs before/after", async () => {
    seed("m1", "Alan owns the Q3 roadmap");
    const change = editMemory(t.db, { memoryId: "m1", content: "Priya owns the Q3 roadmap", embedding: vec("doc:Priya owns the Q3 roadmap"), actor: "cli" });
    expect(change).toMatchObject({ op: "edit", before: "Alan owns the Q3 roadmap", after: "Priya owns the Q3 roadmap", actor: "cli" });
    expect(getMemory(t.db, "m1")!.content).toBe("Priya owns the Q3 roadmap");
    expect(ftsHits("priya")).toEqual(["m1"]);
    expect(ftsHits("alan")).toEqual([]);
    const results = await searchSemantic(t.db, { query: "Priya owns the Q3 roadmap", limit: 5 });
    expect(results[0]?.id).toBe("m1");
    expect(() => t.db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')").run()).not.toThrow();
  });

  it("edit refuses forgotten memories, empty content and no-op content", () => {
    seed("m1", "same");
    expect(() => editMemory(t.db, { memoryId: "m1", content: "  ", embedding: vec("x"), actor: "cli" })).toThrow(/empty/);
    expect(() => editMemory(t.db, { memoryId: "m1", content: "same", embedding: vec("x"), actor: "cli" })).toThrow(/already has/);
    forgetMemory(t.db, { memoryId: "m1", actor: "cli" });
    expect(() => editMemory(t.db, { memoryId: "m1", content: "changed", embedding: vec("x"), actor: "cli" })).toThrow(/restore/);
  });

  it("restore reactivates, re-indexes, lifts the suppression and logs", async () => {
    seed("m1", "restore me please");
    forgetMemory(t.db, { memoryId: "m1", actor: "cli" });
    expect(isSuppressed(t.db, "restore me please")).toBe(true);

    const change = restoreMemory(t.db, { memoryId: "m1", embedding: vec("doc:restore me please"), actor: "cli" });
    expect(change).toMatchObject({ op: "restore", before: null, after: "restore me please" });
    const m = getMemory(t.db, "m1")!;
    expect(m.isActive).toBe(true);
    expect(m.deletedAt).toBeUndefined();
    expect(isSuppressed(t.db, "restore me please")).toBe(false);
    expect(ftsHits("restore")).toEqual(["m1"]);
    const results = await searchSemantic(t.db, { query: "restore me please", limit: 5 });
    expect(results[0]?.id).toBe("m1");
    expect(() => restoreMemory(t.db, { memoryId: "m1", embedding: vec("x"), actor: "cli" })).toThrow(/not forgotten/);
  });
});

// ─── Purge by conversation / retention (#56) ───────────────────

describe("purgeConversation", () => {
  it("forgets every memory derived from the conversation's exchanges", () => {
    t.db.prepare("INSERT INTO conversations (id, project) VALUES ('conv-1', 'p'), ('conv-2', 'p')").run();
    t.db
      .prepare("INSERT INTO exchanges (id, conversation_id, project, timestamp, exchange_index) VALUES ('x1', 'conv-1', 'p', '2026-09-01T00:00:00Z', 0), ('x2', 'conv-1', 'p', '2026-09-01T00:01:00Z', 1), ('y1', 'conv-2', 'p', '2026-09-02T00:00:00Z', 0)")
      .run();
    seed("a", "from conv 1 first", { sourceExchanges: ["x1"] });
    seed("b", "from conv 1 second", { sourceExchanges: ["x2", "y1"] });
    seed("c", "from conv 2", { sourceExchanges: ["y1"] });
    seed("d", "legacy conversation reference", { sourceExchanges: ["conv-1"] });
    seed("e", "user remembered, no sources" );
    forgetMemory(t.db, { memoryId: "a", actor: "cli" });

    const result = purgeConversation(t.db, { conversationId: "conv-1", actor: "cli" });
    expect(result.forgotten.map((f) => f.memoryId).sort()).toEqual(["b", "d"]);
    expect(result.alreadyForgotten).toBe(1);
    expect(getMemory(t.db, "c")!.isActive).toBe(true);
    expect(getMemory(t.db, "e")!.isActive).toBe(true);
    expect(getMemory(t.db, "b")!.deletedBy).toBe("cli");
  });
});

describe("purgeForgottenMemories (retention, #56)", () => {
  it("hard-deletes memories forgotten longer than retentionDays ago, logs purge, keeps suppressions", () => {
    seed("old", "forgotten forty days ago");
    seed("recent", "forgotten yesterday");
    seed("live", "never forgotten");
    const now = new Date("2026-09-17T00:00:00.000Z");
    forgetMemory(t.db, { memoryId: "old", actor: "cli", now: new Date("2026-08-08T00:00:00.000Z") });
    forgetMemory(t.db, { memoryId: "recent", actor: "cli", now: new Date("2026-09-16T00:00:00.000Z") });

    const result = purgeForgottenMemories(t.db, { retentionDays: 30, now });
    expect(result.purged).toEqual(["old"]);
    expect(getMemory(t.db, "old")).toBeNull();
    expect(getMemory(t.db, "recent")).not.toBeNull();
    expect(getMemory(t.db, "live")!.isActive).toBe(true);
    expect(listMemoryChanges(t.db, { memoryId: "old" }).map((c) => `${c.op}:${c.actor}`)).toEqual(["purge:dream", "forget:cli"]);
    expect(isSuppressed(t.db, "forgotten forty days ago")).toBe(true);
    expect(() => t.db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')").run()).not.toThrow();
  });

  it("retentionDays 0 purges every forgotten memory on the next prune", () => {
    seed("a", "a");
    seed("b", "b");
    forgetMemory(t.db, { memoryId: "a", actor: "cli" });
    const result = purgeForgottenMemories(t.db, { retentionDays: 0 });
    expect(result.purged).toEqual(["a"]);
    expect(getMemory(t.db, "b")!.isActive).toBe(true);
  });
});

// ─── Suppression ────────────────────────────────────────────────

describe("extraction suppression", () => {
  it("filterSuppressedFacts drops forgotten content (normalised) and keeps the rest", () => {
    seed("m1", "We deploy on Fridays, never on Mondays.");
    forgetMemory(t.db, { memoryId: "m1", actor: "cli" });
    const facts = [
      { type: "fact" as const, content: "we deploy on fridays never on mondays", importance: 0.5, sourceExchangeIds: [] },
      { type: "fact" as const, content: "Deploys happen on Tuesdays", importance: 0.5, sourceExchangeIds: [] },
    ];
    const { kept, suppressed } = filterSuppressedFacts(t.db, facts);
    expect(suppressed.map((f) => f.content)).toEqual(["we deploy on fridays never on mondays"]);
    expect(kept.map((f) => f.content)).toEqual(["Deploys happen on Tuesdays"]);
  });

  it("clearSuppression lifts it (an explicit remember wins)", () => {
    seed("m1", "keep me after all");
    forgetMemory(t.db, { memoryId: "m1", actor: "cli" });
    expect(clearSuppression(t.db, "Keep me after all")).toBe(true);
    expect(isSuppressed(t.db, "keep me after all")).toBe(false);
    expect(clearSuppression(t.db, "keep me after all")).toBe(false);
  });
});

// ─── Inspection ─────────────────────────────────────────────────

describe("inspect", () => {
  it("getMemoryProvenance reports conversation, source, extraction basis, scope, FSRS stats, graph evidence and deletion", () => {
    t.db.prepare("INSERT INTO conversations (id, project, summary, started_at, archive_path, scope) VALUES ('conv-1', 'engram', 'Planning the forget tool', '2026-09-17T09:00:00Z', '/archive/conv-1.jsonl', 'global')").run();
    t.db
      .prepare("INSERT INTO exchanges (id, conversation_id, project, timestamp, exchange_index, user_message) VALUES ('x1', 'conv-1', 'engram', '2026-09-17T09:00:00Z', 3, 'Should forget be a soft delete?')")
      .run();
    addEntity("e-a", "Alpha", 1);
    addEntity("e-b", "Beta", 1);
    seed("m1", "Forget is a soft delete with a 30-day retention", { sourceExchanges: ["x1", "legacy-7"], source: "dream", extractionBasis: "explicit", scope: "global" });
    linkMemoryToEntities(t.db, "m1", ["Alpha", "Beta"]);

    const p = getMemoryProvenance(t.db, "m1")!;
    expect(p.memory.source).toBe("dream");
    expect(p.memory.extractionBasis).toBe("explicit");
    expect(p.memory.scope).toBe("global");
    expect(p.hasEmbedding).toBe(true);
    expect(p.health.stability).toBeGreaterThan(0);
    expect(p.sourceExchanges).toEqual([
      expect.objectContaining({ id: "x1", conversationId: "conv-1", exchangeIndex: 3, userPreview: "Should forget be a soft delete?" }),
    ]);
    expect(p.unresolvedSources).toEqual(["legacy-7"]);
    expect(p.conversations).toEqual([
      expect.objectContaining({ id: "conv-1", title: "Planning the forget tool", archivePath: "/archive/conv-1.jsonl", exchangeCount: 1 }),
    ]);
    expect(p.entities.map((e) => e.name).sort()).toEqual(["Alpha", "Beta"]);
    expect(p.changes).toEqual([]);

    forgetMemory(t.db, { memoryId: "m1", actor: "claude-code" });
    const after = getMemoryProvenance(t.db, "m1")!;
    expect(after.memory.deletedBy).toBe("claude-code");
    expect(after.hasEmbedding).toBe(false);
    expect(after.changes[0].op).toBe("forget");
    // its evidence was detached, so it no longer evidences any entity
    expect(after.entities).toEqual([]);
  });

  it("resolveMemoryId accepts a unique prefix of 6+ chars and rejects ambiguity", () => {
    seed("abcdef-1", "one");
    seed("abcdef-2", "two");
    seed("zzzzzz-1", "three");
    expect(resolveMemoryId(t.db, "zzzzzz")).toBe("zzzzzz-1");
    expect(resolveMemoryId(t.db, "abcde")).toBeNull();
    expect(() => resolveMemoryId(t.db, "abcdef")).toThrow(/ambiguous/);
    expect(getMemoryProvenance(t.db, "missing-id")).toBeNull();
  });

  it("listMemories filters by type, scope, since and query", () => {
    seed("f1", "fact one", { type: "fact", scope: "global", createdAt: 1_000 });
    seed("d1", "decision one", { type: "decision", scope: "hermes:career", createdAt: 2_000_000_000 });
    expect(listMemories(t.db, { type: "decision" }).map((m) => m.id)).toEqual(["d1"]);
    expect(listMemories(t.db, { scopes: ["global"] }).map((m) => m.id)).toEqual(["f1"]);
    expect(listMemories(t.db, { since: "2026-01-01" }).map((m) => m.id)).toEqual(["d1"]);
    expect(listMemories(t.db, { query: "ONE" }).map((m) => m.id).sort()).toEqual(["d1", "f1"]);
    expect(listMemories(t.db, { query: "%" })).toEqual([]);
    expect(() => listMemories(t.db, { since: "not a date" })).toThrow(/since/);
  });

  it("listMemoryChanges filters by memory and op, newest first", () => {
    seed("m1", "a");
    seed("m2", "b");
    forgetMemory(t.db, { memoryId: "m1", actor: "cli", now: new Date("2026-09-17T00:00:00Z") });
    forgetMemory(t.db, { memoryId: "m2", actor: "claude", now: new Date("2026-09-17T00:00:01Z") });
    expect(listMemoryChanges(t.db).map((c) => c.memoryId)).toEqual(["m2", "m1"]);
    expect(listMemoryChanges(t.db, { memoryId: "m1" })).toHaveLength(1);
    expect(listMemoryChanges(t.db, { op: "purge" })).toEqual([]);
    expect(listMemoryChanges(t.db, { limit: 1 })).toHaveLength(1);
  });
});
