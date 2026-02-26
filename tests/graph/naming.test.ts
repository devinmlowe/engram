import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import type { CommunityResult } from "../../src/graph/types.js";
import { persistAnalysis, analyzeGraph } from "../../src/graph/analyzer.js";

// ─── Mock intelligence layer ─────────────────────────────────────

vi.mock("../../src/dream/intelligence.js", () => ({
  generateStructured: vi.fn(),
  buildIntelligenceConfig: vi.fn(() => ({
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "qwen2.5:7b",
    apiModel: "claude-sonnet-4-20250514",
    apiFallbackModel: "claude-haiku-4-20250414",
    timeoutMs: 120_000,
  })),
}));

// Import after mock is set up
import { generateStructured } from "../../src/dream/intelligence.js";
import {
  generateCommunityName,
  nameCommunities,
} from "../../src/graph/naming.js";
import type { IntelligenceConfig } from "../../src/dream/intelligence.js";

const mockedGenerateStructured = vi.mocked(generateStructured);

// ─── Helpers ─────────────────────────────────────────────────────

function insertTestEntity(
  db: Database.Database,
  id: string,
  name: string,
  type: string,
) {
  db.prepare(
    "INSERT INTO entities (id, name, type, aliases, first_seen, last_seen, mention_count, created_at) VALUES (?, ?, ?, '[]', unixepoch(), unixepoch(), 1, unixepoch())",
  ).run(id, name, type);
}

function insertTestRelationship(
  db: Database.Database,
  id: string,
  sourceId: string,
  targetId: string,
  type: string,
  weight: number,
) {
  db.prepare(
    "INSERT INTO relationships (id, source_entity_id, target_entity_id, type, weight, source_memories, created_at) VALUES (?, ?, ?, ?, ?, '[]', unixepoch())",
  ).run(id, sourceId, targetId, type, weight);
}

const TEST_CONFIG: IntelligenceConfig = {
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "qwen2.5:7b",
  apiModel: "claude-sonnet-4-20250514",
  apiFallbackModel: "claude-haiku-4-20250414",
  timeoutMs: 120_000,
};

/**
 * Build a small community with known entities and relationships.
 * Returns the entity IDs.
 */
function buildTestCommunity(db: Database.Database): string[] {
  insertTestEntity(db, "ts-1", "TypeScript", "technology");
  insertTestEntity(db, "react-1", "React", "technology");
  insertTestEntity(db, "node-1", "Node.js", "technology");
  insertTestRelationship(db, "rel-ts-react", "ts-1", "react-1", "uses", 2.0);
  insertTestRelationship(db, "rel-ts-node", "ts-1", "node-1", "depends_on", 1.5);
  return ["ts-1", "react-1", "node-1"];
}

/**
 * Build two separate communities for nameCommunities testing.
 */
function buildTwoCommunities(db: Database.Database): {
  communityA: string[];
  communityB: string[];
} {
  // Community A: web tech
  insertTestEntity(db, "ts-1", "TypeScript", "technology");
  insertTestEntity(db, "react-1", "React", "technology");
  insertTestRelationship(db, "rel-ts-react", "ts-1", "react-1", "uses", 2.0);

  // Community B: databases
  insertTestEntity(db, "pg-1", "PostgreSQL", "technology");
  insertTestEntity(db, "sqlite-1", "SQLite", "technology");
  insertTestRelationship(db, "rel-pg-sql", "pg-1", "sqlite-1", "related_to", 1.0);

  return {
    communityA: ["ts-1", "react-1"],
    communityB: ["pg-1", "sqlite-1"],
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Community Naming", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    t.cleanup();
  });

  // ─── generateCommunityName ──────────────────────────────────

  describe("generateCommunityName", () => {
    it("returns LLM-generated name and description", async () => {
      const entityIds = buildTestCommunity(t.db);
      const community: CommunityResult = {
        communityId: 0,
        entityIds,
        coherenceScore: 0.85,
      };

      mockedGenerateStructured.mockResolvedValueOnce({
        result: {
          name: "Web Development Stack",
          description: "A community centered on modern web development technologies including TypeScript, React, and Node.js.",
          keywords: ["web", "typescript", "react", "node"],
        },
        source: "local",
        model: "qwen2.5:7b",
        durationMs: 500,
      });

      const naming = await generateCommunityName(t.db, community, TEST_CONFIG);

      expect(naming.communityId).toBe(0);
      expect(naming.name).toBe("Web Development Stack");
      expect(naming.description).toContain("modern web development");
      expect(naming.topicKeywords).toEqual(["web", "typescript", "react", "node"]);
    });

    it("queries correct entities from DB", async () => {
      const entityIds = buildTestCommunity(t.db);
      const community: CommunityResult = {
        communityId: 0,
        entityIds,
        coherenceScore: 0.85,
      };

      mockedGenerateStructured.mockResolvedValueOnce({
        result: {
          name: "Test Name",
          description: "Test description.",
          keywords: ["test"],
        },
        source: "local",
        model: "qwen2.5:7b",
        durationMs: 100,
      });

      await generateCommunityName(t.db, community, TEST_CONFIG);

      // Verify the prompt sent to generateStructured includes entity names
      expect(mockedGenerateStructured).toHaveBeenCalledOnce();
      const [_system, userPrompt] = mockedGenerateStructured.mock.calls[0];
      expect(userPrompt).toContain("TypeScript");
      expect(userPrompt).toContain("React");
      expect(userPrompt).toContain("Node.js");
    });

    it("includes relationship context in prompt", async () => {
      const entityIds = buildTestCommunity(t.db);
      const community: CommunityResult = {
        communityId: 0,
        entityIds,
        coherenceScore: 0.85,
      };

      mockedGenerateStructured.mockResolvedValueOnce({
        result: {
          name: "Test Name",
          description: "Test description.",
          keywords: ["test"],
        },
        source: "local",
        model: "qwen2.5:7b",
        durationMs: 100,
      });

      await generateCommunityName(t.db, community, TEST_CONFIG);

      const [_system, userPrompt] = mockedGenerateStructured.mock.calls[0];
      expect(userPrompt).toContain("uses");
      expect(userPrompt).toContain("depends_on");
    });

    it("falls back to generic name when LLM fails", async () => {
      const entityIds = buildTestCommunity(t.db);
      const community: CommunityResult = {
        communityId: 3,
        entityIds,
        coherenceScore: 0.75,
      };

      mockedGenerateStructured.mockRejectedValueOnce(
        new Error("LLM unavailable"),
      );

      const naming = await generateCommunityName(t.db, community, TEST_CONFIG);

      expect(naming.communityId).toBe(3);
      expect(naming.name).toBe("Community 3");
      expect(naming.description).toContain("TypeScript");
      expect(naming.description).toContain("3 entities");
    });

    it("falls back when entity IDs have no matching DB rows", async () => {
      const community: CommunityResult = {
        communityId: 5,
        entityIds: ["nonexistent-1", "nonexistent-2"],
        coherenceScore: 0.5,
      };

      const naming = await generateCommunityName(t.db, community, TEST_CONFIG);

      expect(naming.communityId).toBe(5);
      expect(naming.name).toBe("Community 5");
      // Should not call LLM when no entities found
      expect(mockedGenerateStructured).not.toHaveBeenCalled();
    });

    it("passes JSON schema to generateStructured", async () => {
      const entityIds = buildTestCommunity(t.db);
      const community: CommunityResult = {
        communityId: 0,
        entityIds,
        coherenceScore: 0.85,
      };

      mockedGenerateStructured.mockResolvedValueOnce({
        result: {
          name: "Test Name",
          description: "Test description.",
          keywords: ["test"],
        },
        source: "local",
        model: "qwen2.5:7b",
        durationMs: 100,
      });

      await generateCommunityName(t.db, community, TEST_CONFIG);

      const [_system, _user, schema] = mockedGenerateStructured.mock.calls[0];
      expect(schema).toHaveProperty("properties");
      expect((schema as Record<string, unknown>).required).toEqual(
        expect.arrayContaining(["name", "description", "keywords"]),
      );
    });
  });

  // ─── nameCommunities ────────────────────────────────────────

  describe("nameCommunities", () => {
    it("processes all communities and returns names", async () => {
      const { communityA, communityB } = buildTwoCommunities(t.db);

      const communities: CommunityResult[] = [
        { communityId: 0, entityIds: communityA, coherenceScore: 0.9 },
        { communityId: 1, entityIds: communityB, coherenceScore: 0.8 },
      ];

      mockedGenerateStructured
        .mockResolvedValueOnce({
          result: {
            name: "Frontend Web Technologies",
            description: "TypeScript and React web development.",
            keywords: ["frontend", "typescript", "react"],
          },
          source: "local",
          model: "qwen2.5:7b",
          durationMs: 300,
        })
        .mockResolvedValueOnce({
          result: {
            name: "Database Technologies",
            description: "Relational database systems.",
            keywords: ["database", "postgresql", "sqlite"],
          },
          source: "local",
          model: "qwen2.5:7b",
          durationMs: 250,
        });

      const results = await nameCommunities(t.db, communities, TEST_CONFIG);

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe("Frontend Web Technologies");
      expect(results[0].communityId).toBe(0);
      expect(results[1].name).toBe("Database Technologies");
      expect(results[1].communityId).toBe(1);
      expect(mockedGenerateStructured).toHaveBeenCalledTimes(2);
    });

    it("returns empty array for empty communities list", async () => {
      const results = await nameCommunities(t.db, [], TEST_CONFIG);

      expect(results).toEqual([]);
      expect(mockedGenerateStructured).not.toHaveBeenCalled();
    });

    it("handles mixed LLM success and failure", async () => {
      const { communityA, communityB } = buildTwoCommunities(t.db);

      const communities: CommunityResult[] = [
        { communityId: 0, entityIds: communityA, coherenceScore: 0.9 },
        { communityId: 1, entityIds: communityB, coherenceScore: 0.8 },
      ];

      mockedGenerateStructured
        .mockResolvedValueOnce({
          result: {
            name: "Frontend Web Technologies",
            description: "TypeScript and React web development.",
            keywords: ["frontend", "typescript", "react"],
          },
          source: "local",
          model: "qwen2.5:7b",
          durationMs: 300,
        })
        .mockRejectedValueOnce(new Error("LLM timeout"));

      const results = await nameCommunities(t.db, communities, TEST_CONFIG);

      expect(results).toHaveLength(2);
      // First community: LLM-generated
      expect(results[0].name).toBe("Frontend Web Technologies");
      // Second community: fallback
      expect(results[1].name).toBe("Community 1");
      expect(results[1].description).toContain("PostgreSQL");
    });
  });

  // ─── persistAnalysis with communityNames ────────────────────

  describe("persistAnalysis with communityNames", () => {
    it("uses LLM-generated names when communityNames provided", () => {
      // Build entities so analyzeGraph can detect communities
      insertTestEntity(t.db, "a1", "Alpha", "technology");
      insertTestEntity(t.db, "a2", "Beta", "technology");
      insertTestRelationship(t.db, "rel-a1-a2", "a1", "a2", "related_to", 2.0);

      const analysis = analyzeGraph(t.db);
      expect(analysis.communities.length).toBeGreaterThanOrEqual(1);

      const communityId = analysis.communities[0].communityId;
      const communityNames = [
        {
          communityId,
          name: "Greek Letters Tech",
          description: "Technologies named after Greek letters.",
          topicKeywords: ["greek", "tech"],
        },
      ];

      persistAnalysis(t.db, analysis, communityNames);

      const clusters = t.db
        .prepare("SELECT name, description FROM topic_clusters")
        .all() as Array<{ name: string; description: string }>;

      expect(clusters.length).toBeGreaterThanOrEqual(1);
      const named = clusters.find((c) => c.name === "Greek Letters Tech");
      expect(named).toBeDefined();
      expect(named!.description).toBe("Technologies named after Greek letters.");
    });

    it("falls back to generic names for communities without naming", () => {
      insertTestEntity(t.db, "a1", "Alpha", "technology");
      insertTestEntity(t.db, "a2", "Beta", "technology");
      insertTestEntity(t.db, "b1", "Gamma", "concept");
      insertTestRelationship(t.db, "rel-a", "a1", "a2", "related_to", 2.0);

      const analysis = analyzeGraph(t.db);

      // Provide naming for only one community (the first one)
      const firstCommunity = analysis.communities[0];
      const communityNames = [
        {
          communityId: firstCommunity.communityId,
          name: "Named Community",
          description: "This one has a name.",
          topicKeywords: ["named"],
        },
      ];

      persistAnalysis(t.db, analysis, communityNames);

      const clusters = t.db
        .prepare("SELECT name, description FROM topic_clusters")
        .all() as Array<{ name: string; description: string }>;

      // At least one should be named, others should have generic fallback
      const namedCluster = clusters.find((c) => c.name === "Named Community");
      expect(namedCluster).toBeDefined();

      // If there are additional communities without naming, they use generic names
      const genericClusters = clusters.filter((c) =>
        c.name.startsWith("Community "),
      );
      for (const gc of genericClusters) {
        expect(gc.description).toContain("Auto-detected community");
      }
    });

    it("works without communityNames (backward compatible)", () => {
      insertTestEntity(t.db, "a1", "Alpha", "technology");
      insertTestEntity(t.db, "a2", "Beta", "technology");
      insertTestRelationship(t.db, "rel-a", "a1", "a2", "related_to", 2.0);

      const analysis = analyzeGraph(t.db);

      // Call without communityNames (old behavior)
      persistAnalysis(t.db, analysis);

      const clusters = t.db
        .prepare("SELECT name, description FROM topic_clusters")
        .all() as Array<{ name: string; description: string }>;

      expect(clusters.length).toBe(analysis.communities.length);
      for (const cluster of clusters) {
        expect(cluster.name).toMatch(/^Community \d+$/);
        expect(cluster.description).toContain("Auto-detected community");
      }
    });
  });
});
