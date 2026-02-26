import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  exploreEntity,
  traverseNeighborhood,
  findEntityByNameOrAlias,
} from "../../src/graph/search.js";
import { insertEntity } from "../../src/graph/entity.js";
import { insertRelationship } from "../../src/graph/relationship.js";
import {
  createTestDb,
  createTestEntity,
  createTestRelationship,
} from "../helpers.js";
import type { TestDb } from "../helpers.js";

let t: TestDb;

function randomEmbedding(dims = 256): number[] {
  return Array.from({ length: dims }, () => Math.random() * 2 - 1);
}

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

/**
 * Helper: set up a small graph for testing.
 *
 *   TypeScript --uses--> Node.js --depends_on--> npm
 *   TypeScript --related_to--> JavaScript
 *   Node.js --configured_by--> package.json
 */
function setupTestGraph() {
  const ts = createTestEntity({
    id: "ent-ts",
    name: "TypeScript",
    type: "technology",
    description: "A typed superset of JavaScript",
    aliases: ["ts"],
  });
  const node = createTestEntity({
    id: "ent-node",
    name: "Node.js",
    type: "technology",
    description: "JavaScript runtime",
  });
  const npm = createTestEntity({
    id: "ent-npm",
    name: "npm",
    type: "tool",
    description: "Node package manager",
  });
  const js = createTestEntity({
    id: "ent-js",
    name: "JavaScript",
    type: "technology",
    description: "Programming language",
  });
  const pkg = createTestEntity({
    id: "ent-pkg",
    name: "package.json",
    type: "file",
    description: "Node.js project manifest",
  });

  insertEntity(t.db, ts, randomEmbedding());
  insertEntity(t.db, node, randomEmbedding());
  insertEntity(t.db, npm, randomEmbedding());
  insertEntity(t.db, js, randomEmbedding());
  insertEntity(t.db, pkg, randomEmbedding());

  const rel1 = createTestRelationship({
    id: "rel-ts-node",
    sourceEntityId: "ent-ts",
    targetEntityId: "ent-node",
    type: "uses",
    weight: 0.9,
    context: "TypeScript compiles to run on Node.js",
  });
  const rel2 = createTestRelationship({
    id: "rel-node-npm",
    sourceEntityId: "ent-node",
    targetEntityId: "ent-npm",
    type: "depends_on",
    weight: 0.8,
  });
  const rel3 = createTestRelationship({
    id: "rel-ts-js",
    sourceEntityId: "ent-ts",
    targetEntityId: "ent-js",
    type: "related_to",
    weight: 0.95,
    context: "TypeScript is a superset of JavaScript",
  });
  const rel4 = createTestRelationship({
    id: "rel-node-pkg",
    sourceEntityId: "ent-node",
    targetEntityId: "ent-pkg",
    type: "configured_by",
    weight: 0.7,
  });

  insertRelationship(t.db, rel1);
  insertRelationship(t.db, rel2);
  insertRelationship(t.db, rel3);
  insertRelationship(t.db, rel4);
}

describe("findEntityByNameOrAlias", () => {
  it("finds entity by exact name", () => {
    setupTestGraph();
    const result = findEntityByNameOrAlias(t.db, "TypeScript");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ent-ts");
  });

  it("finds entity by name case-insensitively", () => {
    setupTestGraph();
    const result = findEntityByNameOrAlias(t.db, "typescript");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ent-ts");
  });

  it("finds entity by alias", () => {
    setupTestGraph();
    const result = findEntityByNameOrAlias(t.db, "ts");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ent-ts");
  });

  it("returns null for unknown entity", () => {
    setupTestGraph();
    const result = findEntityByNameOrAlias(t.db, "Rust");
    expect(result).toBeNull();
  });
});

describe("exploreEntity", () => {
  it("finds entity by name (case-insensitive)", () => {
    setupTestGraph();
    const result = exploreEntity(t.db, { entity: "typescript" });
    expect(result.centerEntity.name).toBe("TypeScript");
    expect(result.centerEntity.type).toBe("technology");
  });

  it("finds entity by alias", () => {
    setupTestGraph();
    const result = exploreEntity(t.db, { entity: "ts" });
    expect(result.centerEntity.name).toBe("TypeScript");
  });

  it("returns correct neighbors at depth 1", () => {
    setupTestGraph();
    const result = exploreEntity(t.db, { entity: "TypeScript", depth: 1 });

    // TypeScript has edges to Node.js and JavaScript
    expect(result.neighbors.length).toBe(2);

    const names = result.neighbors.map((n) => n.entity.name).sort();
    expect(names).toEqual(["JavaScript", "Node.js"]);

    // All at depth 1
    for (const n of result.neighbors) {
      expect(n.depth).toBe(1);
    }
  });

  it("returns neighbors at depth 2", () => {
    setupTestGraph();
    const result = exploreEntity(t.db, { entity: "TypeScript", depth: 2 });

    // Depth 1: Node.js, JavaScript
    // Depth 2: npm (via Node.js), package.json (via Node.js)
    expect(result.neighbors.length).toBe(4);

    const names = result.neighbors.map((n) => n.entity.name).sort();
    expect(names).toEqual(["JavaScript", "Node.js", "npm", "package.json"]);

    // Check depths
    const depth1 = result.neighbors.filter((n) => n.depth === 1);
    const depth2 = result.neighbors.filter((n) => n.depth === 2);
    expect(depth1.length).toBe(2);
    expect(depth2.length).toBe(2);
  });

  it("respects maxDepth limit", () => {
    setupTestGraph();
    const result = exploreEntity(t.db, { entity: "TypeScript", depth: 1 });

    // Should only have depth-1 neighbors
    expect(result.neighbors.length).toBe(2);
    for (const n of result.neighbors) {
      expect(n.depth).toBe(1);
    }
  });

  it("filters by relationship type", () => {
    setupTestGraph();
    const result = exploreEntity(t.db, {
      entity: "TypeScript",
      depth: 1,
      relationshipTypes: ["uses"],
    });

    expect(result.neighbors.length).toBe(1);
    expect(result.neighbors[0].entity.name).toBe("Node.js");
    expect(result.neighbors[0].relationship.type).toBe("uses");
  });

  it("throws for unknown entity", () => {
    setupTestGraph();
    expect(() => exploreEntity(t.db, { entity: "Rust" })).toThrow(
      "Entity not found: Rust",
    );
  });

  it("includes relationship direction", () => {
    setupTestGraph();
    const result = exploreEntity(t.db, { entity: "TypeScript", depth: 1 });

    // TypeScript is source in both relationships, so both should be outgoing
    for (const n of result.neighbors) {
      expect(n.relationship.direction).toBe("outgoing");
    }
  });

  it("shows incoming direction for target entity", () => {
    setupTestGraph();
    const result = exploreEntity(t.db, { entity: "Node.js", depth: 1 });

    // Node.js has:
    // - incoming: TypeScript --uses--> Node.js
    // - outgoing: Node.js --depends_on--> npm
    // - outgoing: Node.js --configured_by--> package.json
    const incoming = result.neighbors.filter(
      (n) => n.relationship.direction === "incoming",
    );
    const outgoing = result.neighbors.filter(
      (n) => n.relationship.direction === "outgoing",
    );

    expect(incoming.length).toBe(1);
    expect(incoming[0].entity.name).toBe("TypeScript");
    expect(outgoing.length).toBe(2);
  });

  it("includes relationship context", () => {
    setupTestGraph();
    const result = exploreEntity(t.db, { entity: "TypeScript", depth: 1 });

    const nodeNeighbor = result.neighbors.find(
      (n) => n.entity.name === "Node.js",
    );
    expect(nodeNeighbor).toBeDefined();
    expect(nodeNeighbor!.relationship.context).toBe(
      "TypeScript compiles to run on Node.js",
    );
  });
});

describe("traverseNeighborhood", () => {
  it("returns bidirectional results", () => {
    setupTestGraph();

    // Node.js has both incoming (from TypeScript) and outgoing (to npm, package.json)
    const results = traverseNeighborhood(t.db, "ent-node", 1);

    expect(results.length).toBe(3);

    const names = results
      .map((r) => {
        const entity = t.db
          .prepare("SELECT name FROM entities WHERE id = ?")
          .get(r.entityId) as { name: string };
        return entity.name;
      })
      .sort();

    expect(names).toEqual(["TypeScript", "npm", "package.json"]);

    // Check directions
    const incoming = results.filter(
      (r) => r.relationship.direction === "incoming",
    );
    const outgoing = results.filter(
      (r) => r.relationship.direction === "outgoing",
    );
    expect(incoming.length).toBe(1); // TypeScript -> Node.js
    expect(outgoing.length).toBe(2); // Node.js -> npm, Node.js -> package.json
  });

  it("handles isolated entity with no neighbors", () => {
    // Create a standalone entity with no relationships
    const isolated = createTestEntity({
      id: "ent-isolated",
      name: "Isolated",
      type: "concept",
    });
    insertEntity(t.db, isolated, randomEmbedding());

    const results = traverseNeighborhood(t.db, "ent-isolated", 1);
    expect(results).toEqual([]);
  });

  it("filters by relationship types", () => {
    setupTestGraph();

    const results = traverseNeighborhood(t.db, "ent-node", 1, ["uses"]);

    // Only the TypeScript -> Node.js "uses" edge should match
    expect(results.length).toBe(1);
    expect(results[0].relationship.type).toBe("uses");
  });

  it("traverses multiple depths", () => {
    setupTestGraph();

    // Starting from npm, depth 2:
    // depth 1: Node.js (via depends_on)
    // depth 2: TypeScript (via uses), package.json (via configured_by)
    const results = traverseNeighborhood(t.db, "ent-npm", 2);

    expect(results.length).toBe(3);

    const depth1 = results.filter((r) => r.depth === 1);
    const depth2 = results.filter((r) => r.depth === 2);
    expect(depth1.length).toBe(1);
    expect(depth2.length).toBe(2);
  });
});
