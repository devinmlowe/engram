import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import { migrateInformativenessColumns } from "../../src/migration/add-informativeness-columns.js";
import {
  computeConversationCounts,
  computeEntityIdf,
  computeInformativeness,
} from "../../src/graph/informativeness.js";

describe("informativeness scoring", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
    migrateInformativenessColumns(t.db);

    // Setup: 10 conversations
    for (let i = 1; i <= 10; i++) {
      t.db.prepare("INSERT INTO conversations (id, project) VALUES (?, ?)").run(`conv-${i}`, "test");
    }

    // Entity A: appears in all 10 conversations (stop-entity)
    t.db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("eA", "claude", "tool", 500);
    for (let i = 1; i <= 10; i++) {
      t.db.prepare("INSERT INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)").run("eA", `conv-${i}`);
    }

    // Entity B: appears in 2 conversations (discriminative)
    t.db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("eB", "KiCad", "tool", 50);
    t.db.prepare("INSERT INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)").run("eB", "conv-1");
    t.db.prepare("INSERT INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)").run("eB", "conv-2");

    // Entity C: appears in 5 conversations (moderate)
    t.db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES (?, ?, ?, ?)").run("eC", "engram", "project", 200);
    for (let i = 1; i <= 5; i++) {
      t.db.prepare("INSERT INTO entity_conversations (entity_id, conversation_id) VALUES (?, ?)").run("eC", `conv-${i}`);
    }
  });

  afterEach(() => {
    t.cleanup();
  });

  it("computes conversation counts from junction table", () => {
    computeConversationCounts(t.db);
    const eA = t.db.prepare("SELECT conversation_count FROM entities WHERE id = 'eA'").get() as any;
    const eB = t.db.prepare("SELECT conversation_count FROM entities WHERE id = 'eB'").get() as any;
    expect(eA.conversation_count).toBe(10);
    expect(eB.conversation_count).toBe(2);
  });

  it("computes Entity-IDF with correct relative ordering", () => {
    computeConversationCounts(t.db);
    const idfA = computeEntityIdf(10, 10); // claude: in all convos
    const idfB = computeEntityIdf(10, 2);  // KiCad: in 2 convos
    const idfC = computeEntityIdf(10, 5);  // engram: in 5 convos

    // KiCad should have highest IDF (most discriminative)
    expect(idfB).toBeGreaterThan(idfC);
    expect(idfC).toBeGreaterThan(idfA);
    // claude's IDF should be near zero
    expect(idfA).toBeLessThan(0.1);
  });

  it("computes composite informativeness score", () => {
    computeConversationCounts(t.db);
    computeInformativeness(t.db);

    const eA = t.db.prepare("SELECT informativeness FROM entities WHERE id = 'eA'").get() as any;
    const eB = t.db.prepare("SELECT informativeness FROM entities WHERE id = 'eB'").get() as any;
    const eC = t.db.prepare("SELECT informativeness FROM entities WHERE id = 'eC'").get() as any;

    // KiCad should score higher than claude despite fewer mentions
    expect(eB.informativeness).toBeGreaterThan(eA.informativeness);
    // engram should score higher than claude
    expect(eC.informativeness).toBeGreaterThan(eA.informativeness);
  });
});
