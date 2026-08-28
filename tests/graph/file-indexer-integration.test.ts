/**
 * Integration tests for file structure indexing (Phase 7B.1).
 *
 * Tests indexFileStructure() end-to-end: parsing, entity creation,
 * relationship creation, idempotency, and schema migration.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFileStructure } from "../../src/graph/file-indexer.js";
import { exploreEntity } from "../../src/graph/search.js";
import { ftsSearchEntities } from "../../src/graph/entity.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";

let t: TestDb;
let fixtureDirs: string[] = [];

function writeTempFile(filename: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-integ-"));
  fixtureDirs.push(dir);
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  fixtureDirs = [];
});

const SAMPLE_TS = `
/**
 * Initialize the database connection.
 */
export function initDatabase(config: Config): Database {
  const db = new Database(config.path);
  return db;
}

export class EntityManager {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  save(entity: Entity): void {
    // ...
  }
}

export const formatDate = (date: Date): string => {
  return date.toISOString();
};
`.trimStart();

describe("File Indexer Integration", () => {
  it("structural entities stay out of vector search (no zero-vector rows)", () => {
    const filePath = writeTempFile("sample.ts", SAMPLE_TS);
    indexFileStructure(t.db, filePath);

    const indexed = t.db.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number };
    expect(indexed.n).toBeGreaterThan(1);

    // A zero vector sits at L2 distance 1.0 from every unit query and would
    // out-rank real entities; structural entities must not be in vec_entities
    const vecRows = t.db.prepare("SELECT COUNT(*) AS n FROM vec_entities").get() as { n: number };
    expect(vecRows.n).toBe(0);

    // Still reachable by full-text search on the symbol name
    expect(ftsSearchEntities(t.db, "initDatabase").map((e) => e.name)).toContain("initDatabase");
  });

  it("indexes a TS file creating entities with correct types", () => {
    const filePath = writeTempFile("server.ts", SAMPLE_TS);

    const result = indexFileStructure(t.db, filePath);

    // 1 file entity + 3 symbol entities (initDatabase, EntityManager, formatDate)
    expect(result.entitiesCreated).toBe(4);
    expect(result.relationshipsCreated).toBe(3);

    // Verify entity types in DB
    const entities = t.db
      .prepare("SELECT name, type FROM entities ORDER BY name")
      .all() as Array<{ name: string; type: string }>;

    const entityMap = new Map(entities.map((e) => [e.name, e.type]));

    expect(entityMap.get("server.ts")).toBe("file");
    expect(entityMap.get("initDatabase")).toBe("function");
    expect(entityMap.get("EntityManager")).toBe("class");
    expect(entityMap.get("formatDate")).toBe("function");
  });

  it("is idempotent — indexing same file twice creates no duplicates", () => {
    const filePath = writeTempFile("server.ts", SAMPLE_TS);

    const result1 = indexFileStructure(t.db, filePath);
    expect(result1.entitiesCreated).toBe(4);
    expect(result1.relationshipsCreated).toBe(3);

    const result2 = indexFileStructure(t.db, filePath);
    expect(result2.entitiesCreated).toBe(0);
    expect(result2.relationshipsCreated).toBe(0);

    // Total entities should still be 4
    const count = (
      t.db.prepare("SELECT COUNT(*) as count FROM entities").get() as {
        count: number;
      }
    ).count;
    expect(count).toBe(4);
  });

  it("explore file entity shows contains relationships to symbols", () => {
    const filePath = writeTempFile("utils.ts", SAMPLE_TS);

    indexFileStructure(t.db, filePath);

    const result = exploreEntity(t.db, { entity: "utils.ts", depth: 1 });

    expect(result.centerEntity.name).toBe("utils.ts");
    expect(result.centerEntity.type).toBe("file");
    expect(result.neighbors.length).toBe(3);

    const neighborNames = result.neighbors.map((n) => n.entity.name).sort();
    expect(neighborNames).toEqual(["EntityManager", "formatDate", "initDatabase"]);

    // All relationships should be "contains"
    for (const neighbor of result.neighbors) {
      expect(neighbor.relationship.type).toBe("contains");
      expect(neighbor.relationship.direction).toBe("outgoing");
    }
  });

  it("schema migration supports new entity and relationship types", () => {
    // The createTestDb() calls initDatabase() which runs createSchema() with
    // migrateExpandedTypes(). Verify we can insert entities with new types.

    // Function entity
    t.db.prepare(
      "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
    ).run("test-fn", "myFunction", "function");

    // Class entity
    t.db.prepare(
      "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
    ).run("test-cls", "MyClass", "class");

    // Module entity
    t.db.prepare(
      "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
    ).run("test-mod", "myModule", "module");

    // Verify all three exist
    const count = (
      t.db.prepare("SELECT COUNT(*) as count FROM entities WHERE type IN ('function', 'class', 'module')").get() as {
        count: number;
      }
    ).count;
    expect(count).toBe(3);

    // Contains relationship
    t.db.prepare(
      "INSERT INTO entities (id, name, type) VALUES (?, ?, ?)",
    ).run("test-file", "test.ts", "file");

    t.db.prepare(
      "INSERT INTO relationships (id, source_entity_id, target_entity_id, type) VALUES (?, ?, ?, ?)",
    ).run("rel-test", "test-file", "test-fn", "contains");

    const rel = t.db
      .prepare("SELECT type FROM relationships WHERE id = ?")
      .get("rel-test") as { type: string };
    expect(rel.type).toBe("contains");
  });
});
