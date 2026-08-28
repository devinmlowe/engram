import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers.js";

// ADR-010 Phase 2: per-tenant scoping for Hermes integration.
// memories.scope: 'global' (Claude Code / dream derived) or 'hermes:<profile>'.
describe("memories scope column (ADR-010)", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it("memories table has a scope column defaulting to 'global'", () => {
    const cols = (t.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("scope");
    t.db
      .prepare("INSERT INTO memories (id, type, content) VALUES ('m1', 'fact', 'scoped test')")
      .run();
    const row = t.db.prepare("SELECT scope FROM memories WHERE id = 'm1'").get() as {
      scope: string;
    };
    expect(row.scope).toBe("global");
  });

  it("accepts hermes profile scopes on insert", () => {
    t.db
      .prepare(
        "INSERT INTO memories (id, type, content, scope) VALUES ('m2', 'fact', 'career note', 'hermes:career')",
      )
      .run();
    const row = t.db.prepare("SELECT scope FROM memories WHERE id = 'm2'").get() as {
      scope: string;
    };
    expect(row.scope).toBe("hermes:career");
  });

  it("has an index on scope for filtered recall", () => {
    const indexes = (
      t.db.prepare("PRAGMA index_list(memories)").all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_memories_scope");
  });
});
