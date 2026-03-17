import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanBlockedEntities } from "../../src/graph/cleanup.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  // Insert test entities
  const insert = t.db.prepare(
    "INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)"
  );
  insert.run("e1", "KiCad", "tool", 50);
  insert.run("e2", "---", "concept", 200);
  insert.run("e3", "engram", "project", 100);
  insert.run("e4", "##", "concept", 150);
  insert.run("e5", "**bold**", "concept", 10);
});

afterEach(() => {
  t.cleanup();
});

describe("cleanBlockedEntities", () => {
  it("removes entities matching the blocklist", () => {
    const removed = cleanBlockedEntities(t.db);
    expect(removed).toBeGreaterThanOrEqual(2);

    const remaining = t.db.prepare("SELECT name FROM entities").all();
    const names = remaining.map((r: any) => r.name);
    expect(names).toContain("KiCad");
    expect(names).toContain("engram");
    expect(names).not.toContain("---");
    expect(names).not.toContain("##");
  });

  it("cleans up orphaned relationships", () => {
    // Create a relationship involving a blocked entity
    t.db.prepare(
      "INSERT INTO relationships (id, source_entity_id, target_entity_id, type) VALUES (?, ?, ?, ?)"
    ).run("r1", "e1", "e2", "related_to");
    t.db.prepare(
      "INSERT INTO relationships (id, source_entity_id, target_entity_id, type) VALUES (?, ?, ?, ?)"
    ).run("r2", "e1", "e3", "related_to");

    cleanBlockedEntities(t.db);

    const rels = t.db.prepare("SELECT id FROM relationships").all();
    expect(rels).toHaveLength(1); // only r2 survives
  });
});
