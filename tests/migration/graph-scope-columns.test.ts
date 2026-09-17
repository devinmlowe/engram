/**
 * #25: tenant `scope` on exchanges, entities, relationships and commitments,
 * stamped on write and honoured on read (episodic search, graph search,
 * explore, commitments list). Graph rows seen from a second scope widen to
 * 'global' instead of being duplicated per tenant.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import { GRAPH_SCOPE_MIGRATION, SCOPED_TABLES, migrateGraphScope } from "../../src/_core/db/schema.js";
import { scopeVisible, scopeInClause, widenScope } from "../../src/_core/db/scope.js";
import { insertEntity, getEntity } from "../../src/graph/entity.js";
import { findOrCreateRelationship, insertRelationship, getRelationship } from "../../src/graph/relationship.js";
import { exploreEntity } from "../../src/graph/search.js";
import { insertExchange, getExchange } from "../../src/episodic/store.js";
import { insertCommitments, listCommitments } from "../../src/semantic/commitments.js";

let t: TestDb;
beforeEach(() => { t = createTestDb(); });
afterEach(() => { t.cleanup(); });

const vec = (seed: number) => {
  const v = Array.from({ length: 256 }, (_, i) => Math.sin(seed * 13 + i));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};
function entity(id: string, name: string, scope?: string) {
  insertEntity(t.db, { id, name, type: "concept", aliases: [], firstSeen: 1, lastSeen: 1, mentionCount: 1, createdAt: 1, scope }, vec(id.length + name.length));
}

describe("graph scope migration", () => {
  it("every scoped table has a scope column defaulting to 'global', an index, and the checkpoint is recorded", () => {
    for (const table of SCOPED_TABLES) {
      const cols = (t.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; dflt_value: string | null }>);
      const scope = cols.find((c) => c.name === "scope");
      expect(scope, table).toBeDefined();
      expect(scope!.dflt_value).toBe("'global'");
      const indexes = (t.db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes, table).toContain(`idx_${table}_scope`);
    }
    expect(t.db.prepare("SELECT 1 AS ok FROM schema_migrations WHERE name = ?").get(GRAPH_SCOPE_MIGRATION)).toEqual({ ok: 1 });
    expect(migrateGraphScope(t.db)).toBe(false); // idempotent re-run adds nothing
  });

  it("helpers: visibility, IN clause, widening", () => {
    expect(scopeVisible("global", undefined)).toBe(true);
    expect(scopeVisible("hermes:a", ["global"])).toBe(false);
    expect(scopeVisible(null, ["global"])).toBe(true);
    expect(scopeInClause("e.scope", ["a", "b"])).toEqual({ sql: "e.scope IN (?, ?)", params: ["a", "b"] });
    expect(scopeInClause("e.scope", [])).toBeNull();
    entity("e1", "Engram", "hermes:a");
    expect(widenScope(t.db, "entities", "e1", "hermes:a")).toBe(false); // same scope: unchanged
    expect(getEntity(t.db, "e1")!.scope).toBe("hermes:a");
    expect(widenScope(t.db, "entities", "e1", "hermes:b")).toBe(true);  // second tenant: global
    expect(getEntity(t.db, "e1")!.scope).toBe("global");
    expect(widenScope(t.db, "entities", "e1", "hermes:c")).toBe(false); // already global
  });
});

describe("write side stamps scope", () => {
  it("exchanges keep the scope they were ingested with", () => {
    insertExchange(t.db, {
      id: "x1", conversationId: "c1", project: "p", timestamp: "2026-09-17T00:00:00Z",
      userMessage: "hi", assistantMessage: "hello", exchangeIndex: 0, tokenEstimate: 2, createdAt: 1, scope: "hermes:career",
    }, vec(1), []);
    insertExchange(t.db, {
      id: "x2", conversationId: "c1", project: "p", timestamp: "2026-09-17T00:00:01Z",
      userMessage: "hi", assistantMessage: "hello", exchangeIndex: 1, tokenEstimate: 2, createdAt: 1,
    }, vec(2), []);
    expect(getExchange(t.db, "x1")!.scope).toBe("hermes:career");
    expect(getExchange(t.db, "x2")!.scope).toBe("global");
  });

  it("entities and relationships: new rows take the scope, a second tenant widens them to global", () => {
    entity("a", "Alpha", "hermes:x");
    entity("b", "Beta", "hermes:x");
    const rel = findOrCreateRelationship(t.db, "a", "b", "uses", undefined, undefined, "hermes:x");
    expect(rel.scope).toBe("hermes:x");
    const again = findOrCreateRelationship(t.db, "a", "b", "uses", undefined, undefined, "hermes:y");
    expect(again.id).toBe(rel.id);
    expect(again.scope).toBe("global");
    insertRelationship(t.db, { id: "r2", sourceEntityId: "b", targetEntityId: "a", type: "related_to", weight: 1, sourceMemories: [], createdAt: 1 });
    expect(getRelationship(t.db, "r2")!.scope).toBe("global");
  });

  it("commitments inherit the scope they are inserted with and list filters by it", () => {
    const stamps = new Map<string, string>();
    insertCommitments(t.db, [{ content: "Send the deck", origin: "stated", subject: "devin", sourceExchangeIds: [], dueHint: null }], stamps, "hermes:work");
    insertCommitments(t.db, [{ content: "Call the bank", origin: "stated", subject: "devin", sourceExchangeIds: [], dueHint: null }], stamps);
    expect(listCommitments(t.db).items.map((c) => c.content).sort()).toEqual(["Call the bank", "Send the deck"]);
    const work = listCommitments(t.db, { scopes: ["global", "hermes:work"] });
    expect(work.total).toBe(2);
    const other = listCommitments(t.db, { scopes: ["global", "hermes:home"] });
    expect(other.items.map((c) => c.content)).toEqual(["Call the bank"]);
    expect(other.items[0].scope).toBe("global");
  });
});

describe("explore honours scopes", () => {
  it("center and neighbours outside the caller's scopes are invisible; global ones always show", () => {
    entity("hub", "Hub", "global");
    entity("mine", "Mine", "hermes:a");
    entity("theirs", "Theirs", "hermes:b");
    findOrCreateRelationship(t.db, "hub", "mine", "uses", undefined, undefined, "hermes:a");
    findOrCreateRelationship(t.db, "hub", "theirs", "uses", undefined, undefined, "hermes:b");
    const all = exploreEntity(t.db, { entity: "Hub" });
    expect(all.neighbors.map((n) => n.entity.name).sort()).toEqual(["Mine", "Theirs"]);
    const a = exploreEntity(t.db, { entity: "Hub", scopes: ["global", "hermes:a"] });
    expect(a.neighbors.map((n) => n.entity.name)).toEqual(["Mine"]);
    expect(() => exploreEntity(t.db, { entity: "Theirs", scopes: ["global", "hermes:a"] })).toThrow(/Entity not found/);
    expect(exploreEntity(t.db, { entity: "Theirs", scopes: ["hermes:b"] }).centerEntity.name).toBe("Theirs");
  });
});
