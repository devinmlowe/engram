import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";
import { migrateInformativenessColumns } from "../../src/migration/add-informativeness-columns.js";

describe("informativeness columns migration", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it("adds conversation_count column to entities", () => {
    migrateInformativenessColumns(t.db);
    const info = t.db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
    const cols = info.map(c => c.name);
    expect(cols).toContain("conversation_count");
  });

  it("adds informativeness column to entities", () => {
    migrateInformativenessColumns(t.db);
    const info = t.db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
    const cols = info.map(c => c.name);
    expect(cols).toContain("informativeness");
  });

  it("is idempotent — can run twice safely", () => {
    migrateInformativenessColumns(t.db);
    migrateInformativenessColumns(t.db); // should not throw
    const info = t.db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
    expect(info.map(c => c.name)).toContain("informativeness");
  });

  it("defaults conversation_count to 0 and informativeness to 0", () => {
    t.db.prepare("INSERT INTO entities (id, name, type) VALUES ('e1', 'test', 'tool')").run();
    migrateInformativenessColumns(t.db);
    const row = t.db.prepare("SELECT conversation_count, informativeness FROM entities WHERE id = 'e1'").get() as any;
    expect(row.conversation_count).toBe(0);
    expect(row.informativeness).toBe(0);
  });
});
