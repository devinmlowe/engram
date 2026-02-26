import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";
import {
  detectEntityBursts,
  detectTopicEmergence,
  detectTopicDecay,
  trackCommunityEvolution,
  analyzeTemporalPatterns,
  persistTemporalPatterns,
  getTemporalPatterns,
} from "../../src/graph/temporal.js";
import type { TemporalPattern } from "../../src/graph/types.js";

// ─── Constants ────────────────────────────────────────────────────

const DAY = 86400; // seconds per day
const NOW = Math.floor(Date.now() / 1000);

// ─── Helpers ──────────────────────────────────────────────────────

function insertEntity(
  db: Database.Database,
  id: string,
  name: string,
  opts: {
    firstSeen?: number;
    lastSeen?: number;
    mentionCount?: number;
    type?: string;
  } = {},
) {
  db.prepare(
    `INSERT INTO entities (id, name, type, aliases, first_seen, last_seen, mention_count, created_at)
    VALUES (?, ?, ?, '[]', ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    opts.type ?? "concept",
    opts.firstSeen ?? NOW,
    opts.lastSeen ?? NOW,
    opts.mentionCount ?? 1,
    NOW,
  );
}

function insertCluster(
  db: Database.Database,
  id: string,
  name: string,
  entityIds: string[],
  generation: number,
) {
  db.prepare(
    `INSERT INTO topic_clusters (id, name, entity_ids, memory_ids, coherence_score, created_at, updated_at, generation)
    VALUES (?, ?, ?, '[]', 0.5, ?, ?, ?)`,
  ).run(id, name, JSON.stringify(entityIds), NOW, NOW, generation);
}

// ─── Tests ────────────────────────────────────────────────────────

describe("Temporal Pattern Analysis", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  // ─── detectEntityBursts ───────────────────────────────────────

  describe("detectEntityBursts", () => {
    it("detects a clear burst period exceeding 2x average", () => {
      // Week 1: 2 entities (normal)
      const week1Base = NOW - 21 * DAY;
      insertEntity(t.db, "w1-a", "Week1 A", { firstSeen: week1Base });
      insertEntity(t.db, "w1-b", "Week1 B", { firstSeen: week1Base + DAY });

      // Week 2: 2 entities (normal)
      const week2Base = NOW - 14 * DAY;
      insertEntity(t.db, "w2-a", "Week2 A", { firstSeen: week2Base });
      insertEntity(t.db, "w2-b", "Week2 B", { firstSeen: week2Base + DAY });

      // Week 3: 10 entities (BURST — 5x the normal rate of ~2)
      const week3Base = NOW - 7 * DAY;
      for (let i = 0; i < 10; i++) {
        insertEntity(t.db, `w3-${i}`, `Week3 Entity ${i}`, {
          firstSeen: week3Base + i * 1000,
        });
      }

      const patterns = detectEntityBursts(t.db, 7, 1);

      expect(patterns.length).toBeGreaterThanOrEqual(1);

      const burstPattern = patterns.find(
        (p) => p.entityIds.length === 10,
      );
      expect(burstPattern).toBeDefined();
      expect(burstPattern!.type).toBe("entity_burst");
      expect(burstPattern!.entityIds.length).toBe(10);
      expect(burstPattern!.confidence).toBeGreaterThan(0.5);
      expect(burstPattern!.generation).toBe(1);
      expect(burstPattern!.description).toContain("Burst of 10");
    });

    it("returns empty when all windows have similar counts", () => {
      // 3 entities per week for 3 weeks — uniform, no bursts
      for (let week = 0; week < 3; week++) {
        const base = NOW - (3 - week) * 7 * DAY;
        for (let i = 0; i < 3; i++) {
          insertEntity(t.db, `w${week}-${i}`, `Week${week} Entity ${i}`, {
            firstSeen: base + i * 1000,
          });
        }
      }

      const patterns = detectEntityBursts(t.db, 7, 1);
      expect(patterns.length).toBe(0);
    });

    it("returns empty for empty database", () => {
      const patterns = detectEntityBursts(t.db, 7, 1);
      expect(patterns.length).toBe(0);
    });

    it("returns empty when only one time window exists", () => {
      // All entities in the same window — no baseline to compare against
      for (let i = 0; i < 10; i++) {
        insertEntity(t.db, `ent-${i}`, `Entity ${i}`, {
          firstSeen: NOW + i * 100,
        });
      }

      const patterns = detectEntityBursts(t.db, 7, 1);
      expect(patterns.length).toBe(0);
    });

    it("includes correct time range in pattern", () => {
      // Create a burst with known timing
      const normalBase = NOW - 14 * DAY;
      insertEntity(t.db, "normal-a", "Normal A", { firstSeen: normalBase });

      const burstBase = NOW - 7 * DAY;
      for (let i = 0; i < 6; i++) {
        insertEntity(t.db, `burst-${i}`, `Burst ${i}`, {
          firstSeen: burstBase + i * 100,
        });
      }

      const patterns = detectEntityBursts(t.db, 7, 1);

      if (patterns.length > 0) {
        for (const p of patterns) {
          expect(p.timeStart).toBeLessThan(p.timeEnd);
          expect(p.timeEnd - p.timeStart).toBe(7 * DAY);
        }
      }
    });
  });

  // ─── detectTopicEmergence ─────────────────────────────────────

  describe("detectTopicEmergence", () => {
    it("detects clustered emergence when entities appear together", () => {
      // 5 entities appear in the same 7-day window
      const emergenceBase = NOW - 3 * DAY;
      for (let i = 0; i < 5; i++) {
        insertEntity(t.db, `cluster-${i}`, `Cluster Entity ${i}`, {
          firstSeen: emergenceBase + i * 3600,
        });
      }

      // 1 entity appears in a different window (isolated)
      insertEntity(t.db, "loner", "Loner", {
        firstSeen: NOW - 30 * DAY,
      });

      const patterns = detectTopicEmergence(t.db, 7, 3, 1);

      expect(patterns.length).toBeGreaterThanOrEqual(1);

      const emergence = patterns.find(
        (p) => p.entityIds.length >= 5,
      );
      expect(emergence).toBeDefined();
      expect(emergence!.type).toBe("topic_emergence");
      expect(emergence!.confidence).toBeGreaterThan(0.4);
      expect(emergence!.description).toContain("emerged together");
    });

    it("respects minEntities threshold", () => {
      // 2 entities — below minEntities of 3
      insertEntity(t.db, "pair-a", "Pair A", { firstSeen: NOW });
      insertEntity(t.db, "pair-b", "Pair B", { firstSeen: NOW + 100 });

      const patterns = detectTopicEmergence(t.db, 7, 3, 1);
      expect(patterns.length).toBe(0);
    });

    it("returns empty for empty database", () => {
      const patterns = detectTopicEmergence(t.db, 7, 3, 1);
      expect(patterns.length).toBe(0);
    });

    it("shows entity names in description", () => {
      insertEntity(t.db, "e1", "TypeScript", { firstSeen: NOW });
      insertEntity(t.db, "e2", "React", { firstSeen: NOW + 100 });
      insertEntity(t.db, "e3", "Node.js", { firstSeen: NOW + 200 });

      const patterns = detectTopicEmergence(t.db, 7, 3, 1);

      expect(patterns.length).toBeGreaterThanOrEqual(1);
      const p = patterns[0];
      // Should mention at least some entity names
      expect(
        p.description.includes("TypeScript") ||
        p.description.includes("React") ||
        p.description.includes("Node.js"),
      ).toBe(true);
    });

    it("detects multiple emergence windows", () => {
      // Window 1: 3 entities
      const base1 = NOW - 21 * DAY;
      for (let i = 0; i < 3; i++) {
        insertEntity(t.db, `g1-${i}`, `Group1 ${i}`, {
          firstSeen: base1 + i * 100,
        });
      }

      // Window 2: 4 entities
      const base2 = NOW - 7 * DAY;
      for (let i = 0; i < 4; i++) {
        insertEntity(t.db, `g2-${i}`, `Group2 ${i}`, {
          firstSeen: base2 + i * 100,
        });
      }

      const patterns = detectTopicEmergence(t.db, 7, 3, 1);
      expect(patterns.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── detectTopicDecay ─────────────────────────────────────────

  describe("detectTopicDecay", () => {
    it("detects entities that went stale together", () => {
      // 4 entities last seen 60 days ago, mention_count >= 2
      const staleTime = NOW - 60 * DAY;
      for (let i = 0; i < 4; i++) {
        insertEntity(t.db, `stale-${i}`, `Stale Entity ${i}`, {
          firstSeen: staleTime - 30 * DAY,
          lastSeen: staleTime + i * 100,
          mentionCount: 3,
        });
      }

      // 2 entities still active (last seen today)
      insertEntity(t.db, "active-a", "Active A", {
        lastSeen: NOW,
        mentionCount: 5,
      });
      insertEntity(t.db, "active-b", "Active B", {
        lastSeen: NOW,
        mentionCount: 5,
      });

      const patterns = detectTopicDecay(t.db, 30, 3, 1);

      expect(patterns.length).toBeGreaterThanOrEqual(1);

      const decay = patterns.find(
        (p) => p.entityIds.some((id) => id.startsWith("stale-")),
      );
      expect(decay).toBeDefined();
      expect(decay!.type).toBe("topic_decay");
      expect(decay!.description).toContain("inactive");
      expect(decay!.entityIds.length).toBeGreaterThanOrEqual(4);
    });

    it("ignores entities with mention_count < 2", () => {
      // Entities seen only once — shouldn't be flagged as "decayed"
      const staleTime = NOW - 60 * DAY;
      for (let i = 0; i < 5; i++) {
        insertEntity(t.db, `once-${i}`, `Once Entity ${i}`, {
          firstSeen: staleTime,
          lastSeen: staleTime,
          mentionCount: 1,
        });
      }

      const patterns = detectTopicDecay(t.db, 30, 3, 1);
      expect(patterns.length).toBe(0);
    });

    it("does not flag recently active entities", () => {
      // All entities recently active
      for (let i = 0; i < 5; i++) {
        insertEntity(t.db, `recent-${i}`, `Recent ${i}`, {
          lastSeen: NOW - 5 * DAY,
          mentionCount: 3,
        });
      }

      const patterns = detectTopicDecay(t.db, 30, 3, 1);
      expect(patterns.length).toBe(0);
    });

    it("returns empty for empty database", () => {
      const patterns = detectTopicDecay(t.db, 30, 3, 1);
      expect(patterns.length).toBe(0);
    });

    it("respects minEntities threshold", () => {
      // Only 2 stale entities, below minEntities of 3
      const staleTime = NOW - 60 * DAY;
      insertEntity(t.db, "stale-a", "Stale A", {
        lastSeen: staleTime,
        mentionCount: 3,
      });
      insertEntity(t.db, "stale-b", "Stale B", {
        lastSeen: staleTime,
        mentionCount: 3,
      });

      const patterns = detectTopicDecay(t.db, 30, 3, 1);
      expect(patterns.length).toBe(0);
    });
  });

  // ─── trackCommunityEvolution ──────────────────────────────────

  describe("trackCommunityEvolution", () => {
    it("detects community birth when no previous match exists", () => {
      // Generation 1: one cluster
      insertCluster(t.db, "c1-gen1", "Backend Tools", ["e1", "e2", "e3"], 1);

      // Generation 2: original plus a new cluster with completely different entities
      insertCluster(t.db, "c1-gen2", "Backend Tools", ["e1", "e2", "e3"], 2);
      insertCluster(
        t.db,
        "c2-gen2",
        "Frontend Framework",
        ["e10", "e11", "e12"],
        2,
      );

      const patterns = trackCommunityEvolution(t.db, 2);

      const birth = patterns.find(
        (p) => (p.metadata as Record<string, unknown>).changeType === "birth",
      );
      expect(birth).toBeDefined();
      expect(birth!.type).toBe("community_shift");
      expect(birth!.description).toContain("Frontend Framework");
      expect(birth!.description).toContain("emerged");
    });

    it("detects community death when previous cluster disappears", () => {
      // Generation 1: two clusters
      insertCluster(t.db, "c1-gen1", "Cluster Alpha", ["e1", "e2"], 1);
      insertCluster(t.db, "c2-gen1", "Cluster Beta", ["e5", "e6", "e7"], 1);

      // Generation 2: only one cluster remains (Cluster Beta disappears)
      insertCluster(t.db, "c1-gen2", "Cluster Alpha", ["e1", "e2"], 2);

      const patterns = trackCommunityEvolution(t.db, 2);

      const death = patterns.find(
        (p) => (p.metadata as Record<string, unknown>).changeType === "death",
      );
      expect(death).toBeDefined();
      expect(death!.type).toBe("community_shift");
      expect(death!.description).toContain("disappeared");
      expect(death!.description).toContain("Cluster Beta");
    });

    it("detects community growth", () => {
      // Generation 1: small cluster
      insertCluster(t.db, "c1-gen1", "DevOps", ["e1", "e2", "e3"], 1);

      // Generation 2: same cluster with additional entities
      insertCluster(
        t.db,
        "c1-gen2",
        "DevOps",
        ["e1", "e2", "e3", "e4", "e5"],
        2,
      );

      const patterns = trackCommunityEvolution(t.db, 2);

      const growth = patterns.find(
        (p) =>
          (p.metadata as Record<string, unknown>).changeType === "growth",
      );
      expect(growth).toBeDefined();
      expect(growth!.type).toBe("community_shift");
      expect(growth!.description).toContain("grew");
      expect(
        (growth!.metadata as Record<string, unknown>).previousSize,
      ).toBe(3);
      expect(
        (growth!.metadata as Record<string, unknown>).currentSize,
      ).toBe(5);
    });

    it("detects community contraction", () => {
      // Generation 1: big cluster
      insertCluster(
        t.db,
        "c1-gen1",
        "Testing Tools",
        ["e1", "e2", "e3", "e4", "e5"],
        1,
      );

      // Generation 2: same cluster shrank
      insertCluster(t.db, "c1-gen2", "Testing Tools", ["e1", "e2", "e3"], 2);

      const patterns = trackCommunityEvolution(t.db, 2);

      const contraction = patterns.find(
        (p) =>
          (p.metadata as Record<string, unknown>).changeType === "contraction",
      );
      expect(contraction).toBeDefined();
      expect(contraction!.type).toBe("community_shift");
      expect(contraction!.description).toContain("contracted");
    });

    it("returns empty for generation 1 (no previous to compare)", () => {
      insertCluster(t.db, "c1", "First Gen", ["e1", "e2"], 1);

      const patterns = trackCommunityEvolution(t.db, 1);
      expect(patterns.length).toBe(0);
    });

    it("returns empty when both generations are empty", () => {
      const patterns = trackCommunityEvolution(t.db, 2);
      expect(patterns.length).toBe(0);
    });

    it("includes Jaccard similarity in metadata for matched communities", () => {
      insertCluster(t.db, "c1-gen1", "Shared", ["e1", "e2", "e3"], 1);
      insertCluster(
        t.db,
        "c1-gen2",
        "Shared",
        ["e1", "e2", "e3", "e4"],
        2,
      );

      const patterns = trackCommunityEvolution(t.db, 2);
      const growth = patterns.find(
        (p) =>
          (p.metadata as Record<string, unknown>).changeType === "growth",
      );
      expect(growth).toBeDefined();
      const jaccard = (growth!.metadata as Record<string, unknown>)
        .jaccardSimilarity as number;
      // J({1,2,3}, {1,2,3,4}) = 3/4 = 0.75
      expect(jaccard).toBeCloseTo(0.75, 2);
    });
  });

  // ─── analyzeTemporalPatterns ──────────────────────────────────

  describe("analyzeTemporalPatterns", () => {
    it("runs all detectors and returns combined results", () => {
      // Set up data for entity burst
      const normalBase = NOW - 28 * DAY;
      insertEntity(t.db, "normal-1", "Normal 1", { firstSeen: normalBase });

      const burstBase = NOW - 7 * DAY;
      for (let i = 0; i < 8; i++) {
        insertEntity(t.db, `burst-${i}`, `Burst ${i}`, {
          firstSeen: burstBase + i * 100,
        });
      }

      // Set up data for topic decay
      const staleTime = NOW - 60 * DAY;
      for (let i = 0; i < 4; i++) {
        insertEntity(t.db, `decay-${i}`, `Decay ${i}`, {
          firstSeen: staleTime - 30 * DAY,
          lastSeen: staleTime + i * 100,
          mentionCount: 3,
        });
      }

      // Set up community evolution data
      insertCluster(t.db, "cluster-gen1", "Gen 1 Cluster", ["e1", "e2"], 1);
      insertCluster(
        t.db,
        "cluster-gen2",
        "Gen 2 New",
        ["e10", "e11", "e12"],
        2,
      );

      const patterns = analyzeTemporalPatterns(t.db, 2, {
        windowDays: 7,
        stalenessDays: 30,
        minEntities: 3,
      });

      // Should find patterns from multiple detectors
      expect(patterns.length).toBeGreaterThan(0);

      const types = new Set(patterns.map((p) => p.type));
      // At minimum, we expect at least one type to be detected
      expect(types.size).toBeGreaterThanOrEqual(1);
    });

    it("persists all detected patterns to the database", () => {
      // Create data that generates at least one pattern
      const normalBase = NOW - 28 * DAY;
      insertEntity(t.db, "n1", "Normal 1", { firstSeen: normalBase });

      const burstBase = NOW - 7 * DAY;
      for (let i = 0; i < 8; i++) {
        insertEntity(t.db, `b-${i}`, `Burst ${i}`, {
          firstSeen: burstBase + i * 100,
        });
      }

      const patterns = analyzeTemporalPatterns(t.db, 1, { windowDays: 7 });

      // Verify persistence
      const stored = getTemporalPatterns(t.db, 1);
      expect(stored.length).toBe(patterns.length);
    });

    it("uses default options when none provided", () => {
      // Just verify it doesn't throw with default options
      const patterns = analyzeTemporalPatterns(t.db, 1);
      expect(Array.isArray(patterns)).toBe(true);
    });

    it("returns empty array for empty database", () => {
      const patterns = analyzeTemporalPatterns(t.db, 1);
      expect(patterns.length).toBe(0);
    });
  });

  // ─── Persistence round-trip ───────────────────────────────────

  describe("persistTemporalPatterns + getTemporalPatterns", () => {
    it("round-trips patterns through the database correctly", () => {
      const pattern: TemporalPattern = {
        id: crypto.randomUUID(),
        type: "entity_burst",
        description: "Test burst pattern",
        entityIds: ["e1", "e2", "e3"],
        timeStart: NOW - 7 * DAY,
        timeEnd: NOW,
        confidence: 0.85,
        metadata: { count: 3, ratio: 2.5 },
        generation: 1,
      };

      persistTemporalPatterns(t.db, [pattern]);

      const retrieved = getTemporalPatterns(t.db, 1);

      expect(retrieved.length).toBe(1);
      const r = retrieved[0];
      expect(r.id).toBe(pattern.id);
      expect(r.type).toBe(pattern.type);
      expect(r.description).toBe(pattern.description);
      expect(r.entityIds).toEqual(pattern.entityIds);
      expect(r.timeStart).toBe(pattern.timeStart);
      expect(r.timeEnd).toBe(pattern.timeEnd);
      expect(r.confidence).toBe(pattern.confidence);
      expect(r.metadata).toEqual(pattern.metadata);
      expect(r.generation).toBe(pattern.generation);
    });

    it("persists multiple patterns in one call", () => {
      const patterns: TemporalPattern[] = [
        {
          id: crypto.randomUUID(),
          type: "entity_burst",
          description: "Burst 1",
          entityIds: ["e1"],
          timeStart: NOW - 14 * DAY,
          timeEnd: NOW - 7 * DAY,
          confidence: 0.6,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_emergence",
          description: "Emergence 1",
          entityIds: ["e2", "e3"],
          timeStart: NOW - 7 * DAY,
          timeEnd: NOW,
          confidence: 0.7,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_decay",
          description: "Decay 1",
          entityIds: ["e4", "e5", "e6"],
          timeStart: NOW - 60 * DAY,
          timeEnd: NOW - 30 * DAY,
          confidence: 0.8,
          metadata: {},
          generation: 1,
        },
      ];

      persistTemporalPatterns(t.db, patterns);

      const retrieved = getTemporalPatterns(t.db, 1);
      expect(retrieved.length).toBe(3);

      // Retrieved ordered by confidence DESC
      expect(retrieved[0].confidence).toBeGreaterThanOrEqual(
        retrieved[1].confidence,
      );
      expect(retrieved[1].confidence).toBeGreaterThanOrEqual(
        retrieved[2].confidence,
      );
    });

    it("stores all pattern types correctly", () => {
      const types: Array<TemporalPattern["type"]> = [
        "entity_burst",
        "community_shift",
        "phase_transition",
        "topic_emergence",
        "topic_decay",
        "bridge_formation",
      ];

      const patterns = types.map((type) => ({
        id: crypto.randomUUID(),
        type,
        description: `Pattern type: ${type}`,
        entityIds: ["e1"],
        timeStart: NOW - DAY,
        timeEnd: NOW,
        confidence: 0.5,
        metadata: {},
        generation: 1,
      }));

      persistTemporalPatterns(t.db, patterns);

      const retrieved = getTemporalPatterns(t.db, 1);
      expect(retrieved.length).toBe(types.length);

      const retrievedTypes = new Set(retrieved.map((p) => p.type));
      for (const type of types) {
        expect(retrievedTypes.has(type)).toBe(true);
      }
    });
  });

  // ─── getTemporalPatterns ──────────────────────────────────────

  describe("getTemporalPatterns", () => {
    it("retrieves patterns for a specific generation", () => {
      const gen1Pattern: TemporalPattern = {
        id: crypto.randomUUID(),
        type: "entity_burst",
        description: "Gen 1 pattern",
        entityIds: ["e1"],
        timeStart: NOW - 14 * DAY,
        timeEnd: NOW - 7 * DAY,
        confidence: 0.5,
        metadata: {},
        generation: 1,
      };

      const gen2Pattern: TemporalPattern = {
        id: crypto.randomUUID(),
        type: "topic_emergence",
        description: "Gen 2 pattern",
        entityIds: ["e2", "e3"],
        timeStart: NOW - 7 * DAY,
        timeEnd: NOW,
        confidence: 0.7,
        metadata: {},
        generation: 2,
      };

      persistTemporalPatterns(t.db, [gen1Pattern, gen2Pattern]);

      const gen1Results = getTemporalPatterns(t.db, 1);
      expect(gen1Results.length).toBe(1);
      expect(gen1Results[0].description).toBe("Gen 1 pattern");

      const gen2Results = getTemporalPatterns(t.db, 2);
      expect(gen2Results.length).toBe(1);
      expect(gen2Results[0].description).toBe("Gen 2 pattern");
    });

    it("retrieves latest generation when no generation specified", () => {
      persistTemporalPatterns(t.db, [
        {
          id: crypto.randomUUID(),
          type: "entity_burst",
          description: "Old pattern",
          entityIds: ["e1"],
          timeStart: NOW - 14 * DAY,
          timeEnd: NOW - 7 * DAY,
          confidence: 0.5,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_emergence",
          description: "New pattern",
          entityIds: ["e2"],
          timeStart: NOW - 7 * DAY,
          timeEnd: NOW,
          confidence: 0.7,
          metadata: {},
          generation: 3,
        },
      ]);

      const latest = getTemporalPatterns(t.db);

      expect(latest.length).toBe(1);
      expect(latest[0].description).toBe("New pattern");
      expect(latest[0].generation).toBe(3);
    });

    it("returns empty array when no patterns exist", () => {
      const results = getTemporalPatterns(t.db);
      expect(results.length).toBe(0);
    });

    it("returns empty array when generation has no patterns", () => {
      persistTemporalPatterns(t.db, [
        {
          id: crypto.randomUUID(),
          type: "entity_burst",
          description: "Gen 1",
          entityIds: ["e1"],
          timeStart: NOW,
          timeEnd: NOW,
          confidence: 0.5,
          metadata: {},
          generation: 1,
        },
      ]);

      const results = getTemporalPatterns(t.db, 99);
      expect(results.length).toBe(0);
    });

    it("returns patterns ordered by confidence descending", () => {
      persistTemporalPatterns(t.db, [
        {
          id: crypto.randomUUID(),
          type: "entity_burst",
          description: "Low confidence",
          entityIds: ["e1"],
          timeStart: NOW,
          timeEnd: NOW,
          confidence: 0.3,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_emergence",
          description: "High confidence",
          entityIds: ["e2"],
          timeStart: NOW,
          timeEnd: NOW,
          confidence: 0.9,
          metadata: {},
          generation: 1,
        },
        {
          id: crypto.randomUUID(),
          type: "topic_decay",
          description: "Medium confidence",
          entityIds: ["e3"],
          timeStart: NOW,
          timeEnd: NOW,
          confidence: 0.6,
          metadata: {},
          generation: 1,
        },
      ]);

      const results = getTemporalPatterns(t.db, 1);

      expect(results[0].confidence).toBe(0.9);
      expect(results[1].confidence).toBe(0.6);
      expect(results[2].confidence).toBe(0.3);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles entities with null first_seen in burst detection", () => {
      // Insert entity with null first_seen via raw SQL
      t.db
        .prepare(
          "INSERT INTO entities (id, name, type, aliases, first_seen, last_seen, mention_count, created_at) VALUES (?, ?, ?, '[]', NULL, ?, 1, ?)",
        )
        .run("null-ent", "Null Entity", "concept", NOW, NOW);

      // Should not throw
      const patterns = detectEntityBursts(t.db, 7, 1);
      expect(Array.isArray(patterns)).toBe(true);
    });

    it("handles entities with null last_seen in decay detection", () => {
      t.db
        .prepare(
          "INSERT INTO entities (id, name, type, aliases, first_seen, last_seen, mention_count, created_at) VALUES (?, ?, ?, '[]', ?, NULL, 3, ?)",
        )
        .run("null-ent", "Null Entity", "concept", NOW, NOW);

      const patterns = detectTopicDecay(t.db, 30, 1, 1);
      expect(Array.isArray(patterns)).toBe(true);
    });

    it("persists empty pattern list without error", () => {
      persistTemporalPatterns(t.db, []);
      const results = getTemporalPatterns(t.db);
      expect(results.length).toBe(0);
    });

    it("handles metadata with nested objects", () => {
      const pattern: TemporalPattern = {
        id: crypto.randomUUID(),
        type: "entity_burst",
        description: "Test nested metadata",
        entityIds: ["e1"],
        timeStart: NOW,
        timeEnd: NOW,
        confidence: 0.5,
        metadata: {
          nested: { deep: "value" },
          array: [1, 2, 3],
          nullVal: null,
        },
        generation: 1,
      };

      persistTemporalPatterns(t.db, [pattern]);

      const retrieved = getTemporalPatterns(t.db, 1);
      expect(retrieved[0].metadata).toEqual(pattern.metadata);
    });
  });
});
