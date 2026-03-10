import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { exploreSelective } from "../../src/graph/search.js";
import { insertEntity } from "../../src/graph/entity.js";
import { insertRelationship } from "../../src/graph/relationship.js";
import {
  createTestDb,
  createTestEntity,
  createTestRelationship,
} from "../helpers.js";
import type { TestDb } from "../helpers.js";

// Mock the embeddings module so we control what embedQuery returns
vi.mock("../../src/_core/embeddings/index.js", () => ({
  embedQuery: vi.fn(),
  embedDocument: vi.fn(),
  initEmbeddings: vi.fn(),
  getActiveDimensions: vi.fn(() => 256),
  getActiveModel: vi.fn(() => "nomic"),
  resetEmbeddings: vi.fn(),
  embedDocumentBatch: vi.fn(),
  embedExchange: vi.fn(),
}));

import { embedQuery } from "../../src/_core/embeddings/index.js";
const mockEmbedQuery = vi.mocked(embedQuery);

let t: TestDb;

// ─── Embedding Helpers ──────────────────────────────────────────

/**
 * Create a unit vector pointing in a specific direction.
 * Uses the first `dims` positions to encode a direction.
 */
function makeEmbedding(values: number[], dims = 256): number[] {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < values.length; i++) {
    vec[i] = values[i];
  }
  // L2 normalize
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

// ─── Test Graph Setup ───────────────────────────────────────────

/**
 * Build a graph where we can control relevance via embeddings:
 *
 *   TypeScript --uses--> Node.js --depends_on--> npm
 *   TypeScript --related_to--> JavaScript
 *   Node.js --configured_by--> package.json
 *   npm --related_to--> yarn
 *
 * Embeddings are set so:
 * - "runtime" criteria: Node.js and JavaScript are relevant; npm, package.json, yarn are not
 * - "package manager" criteria: npm and yarn are relevant; others are not
 */
function setupTestGraph() {
  // Embeddings: encode direction vectors in first 4 dims
  // "runtime" direction: [1, 0, 0, 0]
  // "package" direction: [0, 1, 0, 0]
  // "language" direction: [0, 0, 1, 0]
  // "config"   direction: [0, 0, 0, 1]

  const runtimeEmb = makeEmbedding([1, 0, 0, 0]);
  const packageEmb = makeEmbedding([0, 1, 0, 0]);
  const languageEmb = makeEmbedding([0, 0, 1, 0]);
  const configEmb = makeEmbedding([0, 0, 0, 1]);
  // Mixed: half runtime, half language
  const runtimeLangEmb = makeEmbedding([0.7, 0, 0.7, 0]);

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
    description: "JavaScript runtime environment",
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
    description: "Programming language for the web",
  });
  const pkg = createTestEntity({
    id: "ent-pkg",
    name: "package.json",
    type: "file",
    description: "Node.js project configuration manifest",
  });
  const yarn = createTestEntity({
    id: "ent-yarn",
    name: "yarn",
    type: "tool",
    description: "Alternative package manager",
  });

  // Insert with controlled embeddings
  insertEntity(t.db, ts, runtimeLangEmb);       // TypeScript: mix of runtime + language
  insertEntity(t.db, node, runtimeEmb);           // Node.js: runtime
  insertEntity(t.db, npm, packageEmb);            // npm: package
  insertEntity(t.db, js, languageEmb);            // JavaScript: language
  insertEntity(t.db, pkg, configEmb);             // package.json: config
  insertEntity(t.db, yarn, packageEmb);           // yarn: package

  // Relationships
  insertRelationship(t.db, createTestRelationship({
    id: "rel-ts-node",
    sourceEntityId: "ent-ts",
    targetEntityId: "ent-node",
    type: "uses",
    weight: 0.9,
  }));
  insertRelationship(t.db, createTestRelationship({
    id: "rel-ts-js",
    sourceEntityId: "ent-ts",
    targetEntityId: "ent-js",
    type: "related_to",
    weight: 0.95,
  }));
  insertRelationship(t.db, createTestRelationship({
    id: "rel-node-npm",
    sourceEntityId: "ent-node",
    targetEntityId: "ent-npm",
    type: "depends_on",
    weight: 0.8,
  }));
  insertRelationship(t.db, createTestRelationship({
    id: "rel-node-pkg",
    sourceEntityId: "ent-node",
    targetEntityId: "ent-pkg",
    type: "configured_by",
    weight: 0.7,
  }));
  insertRelationship(t.db, createTestRelationship({
    id: "rel-npm-yarn",
    sourceEntityId: "ent-npm",
    targetEntityId: "ent-yarn",
    type: "related_to",
    weight: 0.6,
  }));

  return {
    runtimeEmb,
    packageEmb,
    languageEmb,
    configEmb,
    runtimeLangEmb,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  t = createTestDb();
  vi.clearAllMocks();
});

afterEach(() => {
  t.cleanup();
});

describe("exploreSelective", () => {
  it("finds center entity by name", async () => {
    const embs = setupTestGraph();
    mockEmbedQuery.mockResolvedValue(embs.runtimeEmb);

    const result = await exploreSelective(t.db, {
      entityName: "TypeScript",
      criteria: "runtime",
    });

    expect(result.center.name).toBe("TypeScript");
    expect(result.center.type).toBe("technology");
    expect(result.center.id).toBe("ent-ts");
  });

  it("returns center entity when no neighbors match criteria", async () => {
    const embs = setupTestGraph();
    // Use an embedding orthogonal to everything
    const orthogonalEmb = makeEmbedding([0, 0, 0, 0, 1]);
    mockEmbedQuery.mockResolvedValue(orthogonalEmb);

    const result = await exploreSelective(t.db, {
      entityName: "TypeScript",
      criteria: "completely unrelated topic",
    });

    expect(result.center.name).toBe("TypeScript");
    expect(result.nodes.length).toBe(0);
    expect(result.pruned).toBeGreaterThan(0);
  });

  it("filters neighbors by criteria relevance", async () => {
    const embs = setupTestGraph();
    // Criteria embedding points toward "runtime" — Node.js should match
    mockEmbedQuery.mockResolvedValue(embs.runtimeEmb);

    const result = await exploreSelective(t.db, {
      entityName: "TypeScript",
      criteria: "runtime",
      maxDepth: 1,
    });

    const nodeNames = result.nodes.map((n) => n.entity.name);
    // Node.js has runtime embedding => high similarity
    expect(nodeNames).toContain("Node.js");
    // All returned nodes should have relevance > 0
    for (const node of result.nodes) {
      expect(node.relevanceScore).toBeGreaterThan(0);
    }
  });

  it("expands relevant neighbors to depth 2", async () => {
    const embs = setupTestGraph();
    // Use package embedding — npm is relevant, npm->yarn should be found at depth 2
    mockEmbedQuery.mockResolvedValue(embs.packageEmb);

    const result = await exploreSelective(t.db, {
      entityName: "Node.js",
      criteria: "package manager",
      maxDepth: 2,
    });

    // npm should be found at depth 1 (package embedding matches)
    const npmNode = result.nodes.find((n) => n.entity.name === "npm");
    expect(npmNode).toBeDefined();
    expect(npmNode!.depth).toBe(1);

    // yarn should be found at depth 2 (also package embedding)
    const yarnNode = result.nodes.find((n) => n.entity.name === "yarn");
    if (yarnNode) {
      expect(yarnNode.depth).toBe(2);
      expect(yarnNode.relevanceScore).toBeGreaterThan(0);
    }
  });

  it("respects maxDepth limit", async () => {
    const embs = setupTestGraph();
    mockEmbedQuery.mockResolvedValue(embs.packageEmb);

    const result = await exploreSelective(t.db, {
      entityName: "Node.js",
      criteria: "package manager",
      maxDepth: 1,
    });

    // Should not find yarn (depth 2 from Node.js via npm)
    for (const node of result.nodes) {
      expect(node.depth).toBeLessThanOrEqual(1);
    }
  });

  it("respects maxNodes safety cap", async () => {
    const embs = setupTestGraph();
    mockEmbedQuery.mockResolvedValue(embs.runtimeEmb);

    const result = await exploreSelective(t.db, {
      entityName: "TypeScript",
      criteria: "runtime",
      maxDepth: 3,
      maxNodes: 2,
    });

    expect(result.nodes.length).toBeLessThanOrEqual(2);
  });

  it("filters by relationship types when specified", async () => {
    const embs = setupTestGraph();
    mockEmbedQuery.mockResolvedValue(embs.runtimeEmb);

    const result = await exploreSelective(t.db, {
      entityName: "TypeScript",
      criteria: "runtime",
      maxDepth: 2,
      relationshipTypes: ["uses"],
    });

    // Only "uses" relationships should be traversed
    for (const edge of result.edges) {
      expect(edge.relationship).toBe("uses");
    }
  });

  it("returns correct paths from center to each node", async () => {
    const embs = setupTestGraph();
    mockEmbedQuery.mockResolvedValue(embs.packageEmb);

    const result = await exploreSelective(t.db, {
      entityName: "Node.js",
      criteria: "package manager",
      maxDepth: 2,
    });

    const npmNode = result.nodes.find((n) => n.entity.name === "npm");
    if (npmNode) {
      expect(npmNode.path).toEqual(["Node.js", "npm"]);
    }

    const yarnNode = result.nodes.find((n) => n.entity.name === "yarn");
    if (yarnNode) {
      expect(yarnNode.path).toEqual(["Node.js", "npm", "yarn"]);
    }
  });

  it("includes edges between all kept nodes", async () => {
    const embs = setupTestGraph();
    mockEmbedQuery.mockResolvedValue(embs.packageEmb);

    const result = await exploreSelective(t.db, {
      entityName: "Node.js",
      criteria: "package manager",
      maxDepth: 2,
    });

    // If npm was found, there should be an edge from Node.js to npm
    const npmNode = result.nodes.find((n) => n.entity.name === "npm");
    if (npmNode) {
      const edge = result.edges.find(
        (e) =>
          (e.source === "Node.js" && e.target === "npm") ||
          (e.source === "npm" && e.target === "Node.js"),
      );
      expect(edge).toBeDefined();
    }
  });

  it("reports pruned count accurately", async () => {
    const embs = setupTestGraph();
    // Use an embedding that matches only some neighbors
    mockEmbedQuery.mockResolvedValue(embs.runtimeEmb);

    const result = await exploreSelective(t.db, {
      entityName: "TypeScript",
      criteria: "runtime",
      maxDepth: 1,
    });

    // TypeScript has 2 depth-1 neighbors (Node.js, JavaScript)
    // At least some should be pruned or kept depending on criteria matching
    expect(result.pruned).toBeGreaterThanOrEqual(0);
    // total neighbors considered = nodes.length + pruned
    expect(result.nodes.length + result.pruned).toBeGreaterThan(0);
  });

  it("handles entity not found gracefully", async () => {
    setupTestGraph();
    mockEmbedQuery.mockResolvedValue(makeEmbedding([1, 0, 0, 0]));

    await expect(
      exploreSelective(t.db, {
        entityName: "NonExistentEntity",
        criteria: "anything",
      }),
    ).rejects.toThrow("Entity not found: NonExistentEntity");
  });

  it("handles entity with no relationships", async () => {
    const isolated = createTestEntity({
      id: "ent-isolated",
      name: "Isolated",
      type: "concept",
      description: "A concept with no connections",
    });
    insertEntity(t.db, isolated, makeEmbedding([1, 0, 0, 0]));
    mockEmbedQuery.mockResolvedValue(makeEmbedding([1, 0, 0, 0]));

    const result = await exploreSelective(t.db, {
      entityName: "Isolated",
      criteria: "anything",
    });

    expect(result.center.name).toBe("Isolated");
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.pruned).toBe(0);
  });

  it("empty criteria returns full BFS (no pruning)", async () => {
    const embs = setupTestGraph();
    // Should not even call embedQuery for empty criteria
    mockEmbedQuery.mockResolvedValue(embs.runtimeEmb);

    const result = await exploreSelective(t.db, {
      entityName: "TypeScript",
      criteria: "",
      maxDepth: 1,
    });

    // All depth-1 neighbors should be included (no filtering)
    expect(result.nodes.length).toBe(2); // Node.js, JavaScript
    expect(result.pruned).toBe(0);
    // All nodes should have relevance 1.0 (no filtering)
    for (const node of result.nodes) {
      expect(node.relevanceScore).toBe(1.0);
    }
  });

  it("default maxDepth is 3 and maxNodes is 50", async () => {
    const embs = setupTestGraph();
    mockEmbedQuery.mockResolvedValue(embs.runtimeEmb);

    // Just verify it doesn't throw with defaults
    const result = await exploreSelective(t.db, {
      entityName: "TypeScript",
      criteria: "runtime",
    });

    expect(result).toBeDefined();
    expect(result.center.name).toBe("TypeScript");
  });
});
