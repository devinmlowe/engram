/**
 * End-to-end knowledge graph integration tests.
 *
 * Tests the full pipeline: entity insertion -> relationship creation ->
 * graph analysis -> community persistence -> search -> explore -> XML output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { insertEntity } from "../../src/graph/entity.js";
import { insertRelationship } from "../../src/graph/relationship.js";
import { analyzeGraph, persistAnalysis } from "../../src/graph/analyzer.js";
import { exploreEntity, findEntityByNameOrAlias } from "../../src/graph/search.js";
import { formatRecallXml } from "../../src/episodic/search.js";
import {
  createTestDb,
  createTestEntity,
  createTestRelationship,
} from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { RecallResponse, SearchResult } from "../../src/_core/types/index.js";

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
 * Set up a realistic knowledge graph for integration tests:
 *
 *   engram (project)
 *     --uses--> SQLite (technology)
 *     --uses--> TypeScript (technology)
 *     --depends_on--> graphology (tool)
 *
 *   TypeScript --related_to--> JavaScript (technology)
 *   SQLite --part_of--> better-sqlite3 (tool)
 *   graphology --solved_by--> Louvain (concept)
 */
function setupIntegrationGraph() {
  const entities = [
    createTestEntity({
      id: "ent-engram",
      name: "engram",
      type: "project",
      description: "Cognitive memory system for Claude Code",
      mentionCount: 10,
    }),
    createTestEntity({
      id: "ent-sqlite",
      name: "SQLite",
      type: "technology",
      description: "Lightweight embedded database",
      mentionCount: 8,
    }),
    createTestEntity({
      id: "ent-ts",
      name: "TypeScript",
      type: "technology",
      description: "Typed superset of JavaScript",
      aliases: ["ts", "TS"],
      mentionCount: 15,
    }),
    createTestEntity({
      id: "ent-graphology",
      name: "graphology",
      type: "tool",
      description: "JavaScript graph library",
      mentionCount: 3,
    }),
    createTestEntity({
      id: "ent-js",
      name: "JavaScript",
      type: "technology",
      description: "Programming language",
      mentionCount: 12,
    }),
    createTestEntity({
      id: "ent-bsqlite3",
      name: "better-sqlite3",
      type: "tool",
      description: "Node.js SQLite binding",
      mentionCount: 5,
    }),
    createTestEntity({
      id: "ent-louvain",
      name: "Louvain",
      type: "concept",
      description: "Community detection algorithm",
      mentionCount: 2,
    }),
  ];

  for (const entity of entities) {
    insertEntity(t.db, entity, randomEmbedding());
  }

  const relationships = [
    createTestRelationship({
      id: "rel-engram-sqlite",
      sourceEntityId: "ent-engram",
      targetEntityId: "ent-sqlite",
      type: "uses",
      weight: 0.9,
      context: "engram stores data in SQLite",
    }),
    createTestRelationship({
      id: "rel-engram-ts",
      sourceEntityId: "ent-engram",
      targetEntityId: "ent-ts",
      type: "uses",
      weight: 0.85,
      context: "engram is written in TypeScript",
    }),
    createTestRelationship({
      id: "rel-engram-graphology",
      sourceEntityId: "ent-engram",
      targetEntityId: "ent-graphology",
      type: "depends_on",
      weight: 0.7,
    }),
    createTestRelationship({
      id: "rel-ts-js",
      sourceEntityId: "ent-ts",
      targetEntityId: "ent-js",
      type: "related_to",
      weight: 0.95,
    }),
    createTestRelationship({
      id: "rel-sqlite-bsqlite3",
      sourceEntityId: "ent-sqlite",
      targetEntityId: "ent-bsqlite3",
      type: "part_of",
      weight: 0.8,
    }),
    createTestRelationship({
      id: "rel-graphology-louvain",
      sourceEntityId: "ent-graphology",
      targetEntityId: "ent-louvain",
      type: "solved_by",
      weight: 0.6,
    }),
  ];

  for (const rel of relationships) {
    insertRelationship(t.db, rel);
  }
}

describe("Knowledge Graph Integration", () => {
  describe("Entity and Relationship Pipeline", () => {
    it("entities and relationships are queryable after insertion", () => {
      setupIntegrationGraph();

      // Verify entity count
      const entityCount = (
        t.db.prepare("SELECT COUNT(*) as count FROM entities").get() as {
          count: number;
        }
      ).count;
      expect(entityCount).toBe(7);

      // Verify relationship count
      const relCount = (
        t.db.prepare("SELECT COUNT(*) as count FROM relationships").get() as {
          count: number;
        }
      ).count;
      expect(relCount).toBe(6);

      // Verify FTS index is populated
      const ftsResults = t.db
        .prepare(
          "SELECT e.name FROM entities e JOIN entities_fts fts ON e.rowid = fts.rowid WHERE entities_fts MATCH 'engram'",
        )
        .all() as Array<{ name: string }>;
      expect(ftsResults.length).toBeGreaterThan(0);
      expect(ftsResults[0].name).toBe("engram");
    });
  });

  describe("Graph Analysis Pipeline", () => {
    it("analyzeGraph detects communities", () => {
      setupIntegrationGraph();

      const result = analyzeGraph(t.db);

      expect(result.totalNodes).toBe(7);
      expect(result.totalEdges).toBe(6);
      expect(result.communities.length).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("persistAnalysis writes communities to topic_clusters", () => {
      setupIntegrationGraph();

      const analysis = analyzeGraph(t.db);
      persistAnalysis(t.db, analysis);

      const clusterCount = (
        t.db.prepare("SELECT COUNT(*) as count FROM topic_clusters").get() as {
          count: number;
        }
      ).count;

      expect(clusterCount).toBe(analysis.communities.length);

      // Verify each cluster has entity_ids
      const clusters = t.db
        .prepare("SELECT entity_ids FROM topic_clusters")
        .all() as Array<{ entity_ids: string }>;

      for (const cluster of clusters) {
        const entityIds = JSON.parse(cluster.entity_ids);
        expect(Array.isArray(entityIds)).toBe(true);
        expect(entityIds.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Explore Pipeline", () => {
    it("exploreEntity returns correct neighborhood", () => {
      setupIntegrationGraph();

      const result = exploreEntity(t.db, { entity: "engram", depth: 1 });

      expect(result.centerEntity.name).toBe("engram");
      expect(result.centerEntity.type).toBe("project");
      expect(result.neighbors.length).toBe(3); // SQLite, TypeScript, graphology

      const neighborNames = result.neighbors
        .map((n) => n.entity.name)
        .sort();
      expect(neighborNames).toEqual(["SQLite", "TypeScript", "graphology"]);
    });

    it("exploreEntity depth 2 reaches transitive connections", () => {
      setupIntegrationGraph();

      const result = exploreEntity(t.db, { entity: "engram", depth: 2 });

      // Depth 1: SQLite, TypeScript, graphology
      // Depth 2: JavaScript (via TypeScript), better-sqlite3 (via SQLite), Louvain (via graphology)
      expect(result.neighbors.length).toBe(6);

      const depth2Names = result.neighbors
        .filter((n) => n.depth === 2)
        .map((n) => n.entity.name)
        .sort();
      expect(depth2Names).toEqual(["JavaScript", "Louvain", "better-sqlite3"]);
    });

    it("exploreEntity includes community after persistAnalysis", () => {
      setupIntegrationGraph();

      const analysis = analyzeGraph(t.db);
      persistAnalysis(t.db, analysis);

      const result = exploreEntity(t.db, { entity: "engram", depth: 1 });

      // The community field should be populated because persistAnalysis
      // wrote communities that include the engram entity
      expect(result.community).toBeDefined();
      expect(result.community!.entityCount).toBeGreaterThan(0);
    });
  });

  describe("Entity Lookup", () => {
    it("findEntityByNameOrAlias works with name and alias", () => {
      setupIntegrationGraph();

      // By name
      const byName = findEntityByNameOrAlias(t.db, "TypeScript");
      expect(byName).not.toBeNull();
      expect(byName!.id).toBe("ent-ts");

      // By alias
      const byAlias = findEntityByNameOrAlias(t.db, "ts");
      expect(byAlias).not.toBeNull();
      expect(byAlias!.id).toBe("ent-ts");

      // Case-insensitive
      const lower = findEntityByNameOrAlias(t.db, "sqlite");
      expect(lower).not.toBeNull();
      expect(lower!.id).toBe("ent-sqlite");
    });
  });

  describe("XML Output", () => {
    it("formatRecallXml includes graph tags for graph results", () => {
      const graphResult: SearchResult = {
        id: "ent-engram",
        source: "graph",
        score: 0.9,
        content: "engram (project): Cognitive memory system for Claude Code\nRelationships: -> uses SQLite, -> uses TypeScript",
        metadata: {
          entityName: "engram",
          entityType: "project",
          mentionCount: 10,
        },
        tokenEstimate: 30,
      };

      const semanticResult: SearchResult = {
        id: "mem-1",
        source: "semantic",
        score: 0.8,
        content: "engram uses SQLite for storage",
        metadata: {
          type: "fact",
          confidence: 0.85,
          importance: 0.7,
        },
        tokenEstimate: 15,
      };

      const response: RecallResponse = {
        results: [graphResult, semanticResult],
        tokensUsed: 45,
        totalResults: 2,
        query: "engram database",
      };

      const xml = formatRecallXml(response);

      // Should contain both graph and semantic tags
      expect(xml).toContain("<graph");
      expect(xml).toContain('entity="engram"');
      expect(xml).toContain("<semantic");
      expect(xml).toContain("<engram_memory");
      expect(xml).toContain("</engram_memory>");
    });
  });
});
