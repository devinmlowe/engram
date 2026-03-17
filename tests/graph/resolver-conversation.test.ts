import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTestEntity, type TestDb } from "../helpers.js";
import { insertEntity, recordEntityConversation } from "../../src/graph/entity.js";
import { embedDocument } from "../../src/_core/embeddings/index.js";

describe("entity-conversation tracking", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it("records entity_conversations link via recordEntityConversation", () => {
    // Insert a test entity
    const entity = createTestEntity({ id: "e1", name: "KiCad" });
    const dims = t.config.embedding.dimensions;
    const embedding = Array.from({ length: dims }, () => Math.random());
    insertEntity(t.db, entity, embedding);

    recordEntityConversation(t.db, "e1", "conv-123");

    const links = t.db.prepare(
      "SELECT * FROM entity_conversations WHERE entity_id = ? AND conversation_id = ?"
    ).all("e1", "conv-123");
    expect(links).toHaveLength(1);
  });

  it("deduplicates conversation links (idempotent)", () => {
    const entity = createTestEntity({ id: "e2", name: "engram" });
    const dims = t.config.embedding.dimensions;
    const embedding = Array.from({ length: dims }, () => Math.random());
    insertEntity(t.db, entity, embedding);

    recordEntityConversation(t.db, "e2", "conv-456");
    recordEntityConversation(t.db, "e2", "conv-456"); // same conv again

    const links = t.db.prepare(
      "SELECT * FROM entity_conversations WHERE entity_id = 'e2'"
    ).all();
    expect(links).toHaveLength(1); // not 2
  });

  it("tracks multiple conversations per entity", () => {
    const entity = createTestEntity({ id: "e3", name: "TypeScript" });
    const dims = t.config.embedding.dimensions;
    const embedding = Array.from({ length: dims }, () => Math.random());
    insertEntity(t.db, entity, embedding);

    recordEntityConversation(t.db, "e3", "conv-a");
    recordEntityConversation(t.db, "e3", "conv-b");
    recordEntityConversation(t.db, "e3", "conv-c");

    const links = t.db.prepare(
      "SELECT * FROM entity_conversations WHERE entity_id = 'e3'"
    ).all();
    expect(links).toHaveLength(3);
  });
});
