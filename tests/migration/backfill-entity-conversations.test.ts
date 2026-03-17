import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import { migrateInformativenessColumns } from "../../src/migration/add-informativeness-columns.js";
import { backfillEntityConversations } from "../../src/migration/backfill-entity-conversations.js";

describe("backfillEntityConversations", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
    migrateInformativenessColumns(t.db);

    // Insert conversations with exchanges mentioning entity names
    t.db.prepare("INSERT INTO conversations (id, project) VALUES (?, ?)").run("conv-1", "test");
    t.db.prepare("INSERT INTO conversations (id, project) VALUES (?, ?)").run("conv-2", "test");

    t.db.prepare(`INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message)
      VALUES (?, ?, ?, ?, ?)`).run("x1", "conv-1", "test", "2026-01-01", "Let me open KiCad");
    t.db.prepare(`INSERT INTO exchanges (id, conversation_id, project, timestamp, assistant_message)
      VALUES (?, ?, ?, ?, ?)`).run("x2", "conv-1", "test", "2026-01-01", "Working on engram now");
    t.db.prepare(`INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message)
      VALUES (?, ?, ?, ?, ?)`).run("x3", "conv-2", "test", "2026-01-02", "engram search results");

    // Insert entities
    t.db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("e1", "KiCad", "tool", 10);
    t.db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("e2", "engram", "project", 20);
  });

  afterEach(() => {
    t.cleanup();
  });

  it("populates entity_conversations from exchange text search", () => {
    const result = backfillEntityConversations(t.db);
    expect(result.linked).toBeGreaterThan(0);

    // KiCad mentioned in conv-1 only
    const kicadLinks = t.db.prepare(
      "SELECT conversation_id FROM entity_conversations WHERE entity_id = 'e1'"
    ).all() as Array<{ conversation_id: string }>;
    expect(kicadLinks.map(l => l.conversation_id)).toContain("conv-1");
    expect(kicadLinks.map(l => l.conversation_id)).not.toContain("conv-2");

    // engram mentioned in both
    const engramLinks = t.db.prepare(
      "SELECT conversation_id FROM entity_conversations WHERE entity_id = 'e2'"
    ).all() as Array<{ conversation_id: string }>;
    expect(engramLinks).toHaveLength(2);
  });

  it("is idempotent", () => {
    backfillEntityConversations(t.db);
    const count1 = (t.db.prepare("SELECT COUNT(*) as c FROM entity_conversations").get() as any).c;
    backfillEntityConversations(t.db);
    const count2 = (t.db.prepare("SELECT COUNT(*) as c FROM entity_conversations").get() as any).c;
    expect(count2).toBe(count1);
  });

  it("skips entities with short names (length <= 2)", () => {
    t.db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("e3", "Go", "technology", 5);
    // Insert an exchange mentioning "Go"
    t.db.prepare(`INSERT INTO exchanges (id, conversation_id, project, timestamp, user_message)
      VALUES (?, ?, ?, ?, ?)`).run("x4", "conv-1", "test", "2026-01-01", "Let me use Go for this");

    const result = backfillEntityConversations(t.db);

    const goLinks = t.db.prepare(
      "SELECT * FROM entity_conversations WHERE entity_id = 'e3'"
    ).all();
    expect(goLinks).toHaveLength(0);
  });
});
