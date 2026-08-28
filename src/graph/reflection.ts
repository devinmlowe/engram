/**
 * Reflection orchestration — composes all Phase 6 analysis into a
 * unified pipeline that runs during dream-state processing.
 *
 * Coordinates: edge weight recomputation, community detection,
 * community naming, bridge scoring, temporal pattern analysis,
 * memory linking, observation generation, and graph pruning.
 */

import type Database from "better-sqlite3";
import type { EngramConfig } from "../_core/types/index.js";
import type {
  ReflectResult,
  ReflectionObservation,
  CommunityNaming,
  BridgeScore,
  TemporalPattern,
  GraphAnalysisResult,
  ObservationType,
} from "./types.js";
import type { IntelligenceConfig } from "../_core/llm/index.js";
import { analyzeGraph, persistAnalysis, persistBridgeScores, getBridgeScores } from "./analyzer.js";
import { nameCommunities } from "./naming.js";
import { analyzeTemporalPatterns, getTemporalPatterns } from "./temporal.js";
import { computeEdgeWeight, updateRelationshipWeight } from "./relationship.js";
import { mergeEntities } from "./entity.js";
import { buildIntelligenceConfig, generate } from "../_core/llm/index.js";
import { computeConversationCounts, computeInformativeness } from "./informativeness.js";

// ─── Memory Linking ─────────────────────────────────────────────

/**
 * Link memories to their communities by tracing entity memberships
 * through relationships back to source memories.
 *
 * For each topic_cluster in the given generation:
 * 1. Parse entity_ids JSON array
 * 2. Query relationships involving those entities
 * 3. Collect source_memories from matching relationships
 * 4. Filter to only active memories
 * 5. Update topic_clusters.memory_ids with deduplicated set
 */
export function linkMemoriesToCommunities(
  db: Database.Database,
  generation: number,
): { clustersUpdated: number; memoriesLinked: number } {
  const clusters = db
    .prepare(
      "SELECT id, entity_ids FROM topic_clusters WHERE generation = ?",
    )
    .all(generation) as Array<{ id: string; entity_ids: string }>;

  let clustersUpdated = 0;
  let totalMemoriesLinked = 0;

  const updateStmt = db.prepare(
    "UPDATE topic_clusters SET memory_ids = ?, updated_at = unixepoch() WHERE id = ?",
  );

  const doLink = db.transaction(() => {
    for (const cluster of clusters) {
      const entityIds: string[] = JSON.parse(cluster.entity_ids || "[]");
      if (entityIds.length === 0) continue;

      // Query relationships where source or target is in entity_ids
      const placeholders = entityIds.map(() => "?").join(", ");
      const relationships = db
        .prepare(
          `SELECT source_memories FROM relationships
           WHERE source_entity_id IN (${placeholders})
              OR target_entity_id IN (${placeholders})`,
        )
        .all(...entityIds, ...entityIds) as Array<{
        source_memories: string | null;
      }>;

      // Collect all memory IDs from relationships
      const allMemoryIds = new Set<string>();
      for (const rel of relationships) {
        if (rel.source_memories) {
          const memIds: string[] = JSON.parse(rel.source_memories);
          for (const mid of memIds) {
            allMemoryIds.add(mid);
          }
        }
      }

      if (allMemoryIds.size === 0) {
        updateStmt.run(JSON.stringify([]), cluster.id);
        continue;
      }

      // Filter to only active memories
      const memPlaceholders = Array.from(allMemoryIds)
        .map(() => "?")
        .join(", ");
      const activeMemories = db
        .prepare(
          `SELECT id FROM memories WHERE id IN (${memPlaceholders}) AND is_active = 1`,
        )
        .all(...allMemoryIds) as Array<{ id: string }>;

      const activeMemoryIds = activeMemories.map((m) => m.id);

      updateStmt.run(JSON.stringify(activeMemoryIds), cluster.id);
      clustersUpdated++;
      totalMemoriesLinked += activeMemoryIds.length;
    }
  });

  doLink();

  return { clustersUpdated, memoriesLinked: totalMemoriesLinked };
}

// ─── Edge Weight Recomputation ──────────────────────────────────

/**
 * Recompute edge weights for all relationships using the multi-factor
 * formula from relationship.ts.
 *
 * For each relationship:
 * - Look up source and target entities for last_seen, mention_count
 * - Compute EdgeWeightFactors from source_memories and entity metadata
 * - Apply computeEdgeWeight() and persist the new weight
 */
export function recomputeEdgeWeights(
  db: Database.Database,
): { updated: number } {
  const relationships = db
    .prepare(
      "SELECT id, source_entity_id, target_entity_id, source_memories FROM relationships",
    )
    .all() as Array<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    source_memories: string | null;
  }>;

  const getEntity = db.prepare(
    "SELECT last_seen, mention_count FROM entities WHERE id = ?",
  );

  let updated = 0;

  const doRecompute = db.transaction(() => {
    for (const rel of relationships) {
      const sourceEntity = getEntity.get(rel.source_entity_id) as {
        last_seen: number | null;
        mention_count: number;
      } | undefined;

      const targetEntity = getEntity.get(rel.target_entity_id) as {
        last_seen: number | null;
        mention_count: number;
      } | undefined;

      // Parse source_memories
      const sourceMemories: string[] = rel.source_memories
        ? JSON.parse(rel.source_memories)
        : [];

      const mentionCount = sourceMemories.length;
      const lastSeen = targetEntity?.last_seen ?? Math.floor(Date.now() / 1000);

      // Get average confidence and importance from referenced memories
      let confidence = 0.5;
      let sourceImportance = 0.5;
      let targetImportance = 0.5;

      if (sourceMemories.length > 0) {
        const placeholders = sourceMemories.map(() => "?").join(", ");
        const memStats = db
          .prepare(
            `SELECT AVG(confidence) as avg_confidence, AVG(importance) as avg_importance
             FROM memories WHERE id IN (${placeholders})`,
          )
          .get(...sourceMemories) as {
          avg_confidence: number | null;
          avg_importance: number | null;
        } | undefined;

        if (memStats) {
          confidence = memStats.avg_confidence ?? 0.5;
          // Use average importance for both source and target as an approximation
          // More precise: separate queries per entity. But for now this is sufficient.
          sourceImportance = memStats.avg_importance ?? 0.5;
          targetImportance = memStats.avg_importance ?? 0.5;
        }
      }

      const newWeight = computeEdgeWeight({
        mentionCount,
        lastSeen,
        confidence,
        sourceImportance,
        targetImportance,
      });

      updateRelationshipWeight(db, rel.id, newWeight);
      updated++;
    }
  });

  doRecompute();

  return { updated };
}

// ─── Observation Generation ─────────────────────────────────────

/**
 * Generate 3-5 ReflectionObservation objects using the intelligence layer.
 *
 * Produces observations about:
 * - Graph size/growth (growth_observation)
 * - Modularity and coherence (quality_assessment)
 * - Top 2 communities (community_summary)
 * - Top bridge entity (bridge_narrative)
 *
 * If LLM fails, returns empty array (non-fatal).
 */
export async function generateObservations(
  db: Database.Database,
  reflectResult: Partial<ReflectResult>,
  config: EngramConfig,
): Promise<ReflectionObservation[]> {
  const observations: ReflectionObservation[] = [];
  const generation = reflectResult.generation ?? 1;

  let intellConfig: IntelligenceConfig;
  try {
    intellConfig = buildIntelligenceConfig(config);
  } catch {
    return [];
  }

  const systemPrompt =
    "You are an analyst examining a knowledge graph. Provide a concise, insightful observation (2-3 sentences). Be specific about numbers and patterns. Do not use markdown formatting.";

  // 1. Growth observation
  try {
    const health = reflectResult.health;
    if (health) {
      const userPrompt = `The knowledge graph contains ${health.totalNodes} entities and ${health.totalEdges} relationships organized into ${health.communityCount} communities. There are ${health.orphanNodes} orphan nodes. Describe the growth and structure of this graph.`;

      const result = await generate(systemPrompt, userPrompt, intellConfig);
      observations.push({
        id: crypto.randomUUID(),
        type: "growth_observation",
        content: result.result,
        relatedEntityIds: [],
        confidence: 0.8,
        generation,
      });
    }
  } catch {
    // Non-fatal — continue
  }

  // 2. Quality assessment
  try {
    const health = reflectResult.health;
    if (health) {
      const userPrompt = `The knowledge graph has a modularity score of ${health.modularity.toFixed(3)} and an average community coherence of ${health.averageCoherence.toFixed(3)}. Assess the quality and organization of this knowledge graph.`;

      const result = await generate(systemPrompt, userPrompt, intellConfig);
      observations.push({
        id: crypto.randomUUID(),
        type: "quality_assessment",
        content: result.result,
        relatedEntityIds: [],
        confidence: 0.75,
        generation,
      });
    }
  } catch {
    // Non-fatal
  }

  // 3. Community summaries for top 2 communities
  const communities = reflectResult.communities ?? [];
  const topCommunities = communities
    .slice()
    .sort((a, b) => b.entityCount - a.entityCount)
    .slice(0, 2);

  for (const community of topCommunities) {
    try {
      const entityNames = community.topEntities
        .map((e) => `${e.name} (${e.type})`)
        .join(", ");
      const userPrompt = `Community "${community.name}" has ${community.entityCount} entities and ${community.memoryCount} linked memories with coherence ${community.coherenceScore.toFixed(3)}. Key entities: ${entityNames}. Summarize what this community represents.`;

      const result = await generate(systemPrompt, userPrompt, intellConfig);
      const entityIds = community.topEntities
        .map((e) => e.name); // Best we can do without IDs in the result
      observations.push({
        id: crypto.randomUUID(),
        type: "community_summary",
        content: result.result,
        relatedEntityIds: [],
        confidence: 0.85,
        generation,
      });
    } catch {
      // Non-fatal
    }
  }

  // 4. Bridge narrative for top bridge entity
  const bridges = reflectResult.bridges ?? [];
  if (bridges.length > 0) {
    try {
      const topBridge = bridges[0];
      const userPrompt = `Entity "${topBridge.entityName}" (${topBridge.entityType}) serves as a bridge connecting ${topBridge.communitySpan} communities with a bridge score of ${topBridge.bridgeScore.toFixed(3)}. Connected communities: ${topBridge.connectedCommunities.join(", ")}. Explain the significance of this bridge entity.`;

      const result = await generate(systemPrompt, userPrompt, intellConfig);
      observations.push({
        id: crypto.randomUUID(),
        type: "bridge_narrative",
        content: result.result,
        relatedEntityIds: [],
        confidence: 0.7,
        generation,
      });
    } catch {
      // Non-fatal
    }
  }

  return observations;
}

// ─── Observation Persistence ────────────────────────────────────

/**
 * Persist observations to the reflection_observations table.
 * Uses a transaction for atomicity.
 */
export function persistObservations(
  db: Database.Database,
  observations: ReflectionObservation[],
): void {
  if (observations.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO reflection_observations (id, type, content, related_entity_ids, confidence, generation)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (const obs of observations) {
      insert.run(
        obs.id,
        obs.type,
        obs.content,
        JSON.stringify(obs.relatedEntityIds),
        obs.confidence,
        obs.generation,
      );
    }
  });

  insertAll();
}

// ─── Main Pipeline ──────────────────────────────────────────────

/**
 * Run the full reflection pipeline:
 *
 * 1. Recompute edge weights
 * 2. Analyze graph (community detection, bridges)
 * 3. Name communities via LLM
 * 4. Persist analysis (topic_clusters)
 * 5. Persist bridge scores
 * 6. Analyze temporal patterns
 * 7. Link memories to communities
 * 8. Generate observations via LLM
 * 9. Persist observations
 *
 * Returns a complete ReflectResult.
 */
export async function runReflection(
  db: Database.Database,
  config: EngramConfig,
): Promise<ReflectResult> {
  // Step 1: Recompute edge weights
  recomputeEdgeWeights(db);

  // Step 2: Analyze graph
  const analysis = analyzeGraph(db);

  // Step 3: Name communities
  const intellConfig = buildIntelligenceConfig(config);
  const communityNames = await nameCommunities(
    db,
    analysis.communities,
    intellConfig,
  );

  // Step 4: Persist analysis
  persistAnalysis(db, analysis, communityNames);

  // Get the generation that was just persisted
  const genRow = db
    .prepare("SELECT MAX(generation) as maxGen FROM topic_clusters")
    .get() as { maxGen: number | null } | undefined;
  const generation = genRow?.maxGen ?? 1;

  // Step 5: Persist bridge scores
  persistBridgeScores(db, analysis.bridgeEntities, generation);

  // Step 5b: Compute informativeness scores (depends on bridge scores being persisted)
  computeConversationCounts(db);
  computeInformativeness(db);

  // Step 6: Temporal patterns
  let temporalPatterns: TemporalPattern[] = [];
  try {
    temporalPatterns = analyzeTemporalPatterns(db, generation);
  } catch {
    // Temporal module may not exist yet (concurrent build)
  }

  // Step 7: Link memories to communities
  linkMemoriesToCommunities(db, generation);

  // Build the partial result for observation generation
  const bridgeScores = getBridgeScores(db, generation);
  const nameMap = new Map<number, CommunityNaming>();
  for (const cn of communityNames) {
    nameMap.set(cn.communityId, cn);
  }

  // Build community result items
  const communityResults = analysis.communities.map((c) => {
    const naming = nameMap.get(c.communityId);
    // Look up entity names for topEntities
    const entityRows = db
      .prepare(
        `SELECT name, type FROM entities WHERE id IN (${c.entityIds.map(() => "?").join(", ")})`,
      )
      .all(...c.entityIds) as Array<{ name: string; type: string }>;

    // Get memory count for this cluster
    const clusterRow = db
      .prepare(
        "SELECT memory_ids FROM topic_clusters WHERE generation = ? AND entity_ids = ?",
      )
      .get(generation, JSON.stringify(c.entityIds)) as {
      memory_ids: string | null;
    } | undefined;

    const memoryIds: string[] = clusterRow?.memory_ids
      ? JSON.parse(clusterRow.memory_ids)
      : [];

    return {
      name: naming?.name ?? `Community ${c.communityId}`,
      description:
        naming?.description ??
        `Community with ${c.entityIds.length} entities`,
      entityCount: c.entityIds.length,
      coherenceScore: c.coherenceScore,
      topEntities: entityRows.slice(0, 5).map((e) => ({
        name: e.name,
        type: e.type as ReflectResult["communities"][0]["topEntities"][0]["type"],
      })),
      memoryCount: memoryIds.length,
    };
  });

  // Build bridge result items
  const bridgeResults = bridgeScores.map((bs) => {
    // Find which communities this entity bridges
    const entityCommunities: string[] = [];
    for (const c of analysis.communities) {
      if (c.entityIds.includes(bs.entityId)) {
        const naming = nameMap.get(c.communityId);
        entityCommunities.push(
          naming?.name ?? `Community ${c.communityId}`,
        );
      }
    }
    // Also check neighbor communities
    // For simplicity, just list the communities the entity touches

    return {
      entityName: bs.entityName,
      entityType: bs.entityType,
      bridgeScore: bs.bridgeScore,
      communitySpan: bs.communitySpan,
      narrative: bs.narrative,
      connectedCommunities: entityCommunities,
    };
  });

  // Compute orphan count
  const orphanCount =
    (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM entities e
           WHERE NOT EXISTS (
             SELECT 1 FROM relationships r
             WHERE r.source_entity_id = e.id OR r.target_entity_id = e.id
           )`,
        )
        .get() as { cnt: number }
    ).cnt;

  const avgCoherence =
    analysis.communities.length > 0
      ? analysis.communities.reduce((sum, c) => sum + c.coherenceScore, 0) /
        analysis.communities.length
      : 0;

  // Count total generations
  const genCountRow = db
    .prepare(
      "SELECT COUNT(DISTINCT generation) as cnt FROM topic_clusters",
    )
    .get() as { cnt: number };

  const partialResult: Partial<ReflectResult> = {
    communities: communityResults,
    bridges: bridgeResults,
    temporalPatterns,
    health: {
      totalNodes: analysis.totalNodes,
      totalEdges: analysis.totalEdges,
      modularity: analysis.modularity,
      communityCount: analysis.communities.length,
      orphanNodes: orphanCount,
      averageCoherence: avgCoherence,
      generationCount: genCountRow.cnt,
    },
    generation,
    generatedAt: Math.floor(Date.now() / 1000),
  };

  // Step 8: Generate observations
  const observations = await generateObservations(db, partialResult, config);

  // Step 9: Persist observations
  if (observations.length > 0) {
    persistObservations(db, observations);
  }

  return {
    ...partialResult,
    observations,
  } as ReflectResult;
}

// ─── Cache-based Result ─────────────────────────────────────────

/**
 * Build a ReflectResult from cached data in the database.
 *
 * Reads the latest generation from topic_clusters, bridge_scores,
 * temporal_patterns, and reflection_observations.
 *
 * Returns null if no data exists.
 */
export function buildReflectResultFromCache(
  db: Database.Database,
): ReflectResult | null {
  // Get latest generation
  const genRow = db
    .prepare("SELECT MAX(generation) as maxGen FROM topic_clusters")
    .get() as { maxGen: number | null } | undefined;

  const generation = genRow?.maxGen;
  if (!generation) return null;

  // Load topic clusters
  const clusters = db
    .prepare(
      "SELECT id, name, description, entity_ids, memory_ids, coherence_score FROM topic_clusters WHERE generation = ?",
    )
    .all(generation) as Array<{
    id: string;
    name: string;
    description: string | null;
    entity_ids: string;
    memory_ids: string | null;
    coherence_score: number;
  }>;

  if (clusters.length === 0) return null;

  // Build community results
  const communities = clusters.map((cluster) => {
    const entityIds: string[] = JSON.parse(cluster.entity_ids || "[]");
    const memoryIds: string[] = JSON.parse(cluster.memory_ids || "[]");

    // Look up top entities
    let topEntities: Array<{ name: string; type: string }> = [];
    if (entityIds.length > 0) {
      const placeholders = entityIds.map(() => "?").join(", ");
      topEntities = db
        .prepare(
          `SELECT name, type FROM entities WHERE id IN (${placeholders}) ORDER BY mention_count DESC LIMIT 5`,
        )
        .all(...entityIds) as Array<{ name: string; type: string }>;
    }

    return {
      name: cluster.name,
      description: cluster.description ?? `Community with ${entityIds.length} entities`,
      entityCount: entityIds.length,
      coherenceScore: cluster.coherence_score,
      topEntities: topEntities.map((e) => ({
        name: e.name,
        type: e.type as ReflectResult["communities"][0]["topEntities"][0]["type"],
      })),
      memoryCount: memoryIds.length,
    };
  });

  // Load bridge scores
  const bridgeScores = getBridgeScores(db, generation);
  const bridges = bridgeScores.map((bs) => ({
    entityName: bs.entityName,
    entityType: bs.entityType,
    bridgeScore: bs.bridgeScore,
    communitySpan: bs.communitySpan,
    narrative: bs.narrative,
    connectedCommunities: [] as string[],
  }));

  // Load temporal patterns
  let temporalPatterns: TemporalPattern[] = [];
  try {
    temporalPatterns = getTemporalPatterns(db, generation);
  } catch {
    // Temporal module might not have data
  }

  // Load observations
  const obsRows = db
    .prepare(
      `SELECT id, type, content, related_entity_ids, confidence, generation
       FROM reflection_observations
       WHERE generation = ?
       ORDER BY confidence DESC`,
    )
    .all(generation) as Array<{
    id: string;
    type: string;
    content: string;
    related_entity_ids: string | null;
    confidence: number;
    generation: number;
  }>;

  const observations: ReflectionObservation[] = obsRows.map((row) => ({
    id: row.id,
    type: row.type as ObservationType,
    content: row.content,
    relatedEntityIds: row.related_entity_ids
      ? JSON.parse(row.related_entity_ids)
      : [],
    confidence: row.confidence,
    generation: row.generation,
  }));

  // Health metrics
  const totalNodes =
    (db.prepare("SELECT COUNT(*) as cnt FROM entities").get() as { cnt: number }).cnt;
  const totalEdges =
    (db.prepare("SELECT COUNT(*) as cnt FROM relationships").get() as { cnt: number }).cnt;
  const orphanNodes =
    (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM entities e
           WHERE NOT EXISTS (
             SELECT 1 FROM relationships r
             WHERE r.source_entity_id = e.id OR r.target_entity_id = e.id
           )`,
        )
        .get() as { cnt: number }
    ).cnt;

  const avgCoherence =
    communities.length > 0
      ? communities.reduce((sum, c) => sum + c.coherenceScore, 0) /
        communities.length
      : 0;

  const genCountRow = db
    .prepare(
      "SELECT COUNT(DISTINCT generation) as cnt FROM topic_clusters",
    )
    .get() as { cnt: number };

  return {
    communities,
    bridges,
    temporalPatterns,
    health: {
      totalNodes,
      totalEdges,
      modularity: 0, // Not stored in cache; would need to re-analyze
      communityCount: communities.length,
      orphanNodes,
      averageCoherence: avgCoherence,
      generationCount: genCountRow.cnt,
    },
    observations,
    generation,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}

// ─── Prune Helpers ──────────────────────────────────────────────

/**
 * Merge redundant entities that share the same name (case-insensitive).
 *
 * For each group of duplicates, keeps the entity with the highest
 * mention_count and redirects all relationships from duplicates
 * to the survivor.
 */
export function mergeRedundantEntities(
  db: Database.Database,
): { merged: number } {
  // Find groups of entities with the same name (case-insensitive)
  const groups = db
    .prepare(
      `SELECT name COLLATE NOCASE as norm_name, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
       FROM entities
       GROUP BY name COLLATE NOCASE
       HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ norm_name: string; ids: string; cnt: number }>;

  let merged = 0;

  const doMerge = db.transaction(() => {
    for (const group of groups) {
      const entityIds = group.ids.split(",");

      // Find the entity with the highest mention_count
      const entities = db
        .prepare(
          `SELECT id, mention_count FROM entities WHERE id IN (${entityIds.map(() => "?").join(", ")}) ORDER BY mention_count DESC`,
        )
        .all(...entityIds) as Array<{ id: string; mention_count: number }>;

      if (entities.length < 2) continue;

      const survivorId = entities[0].id;
      const duplicateIds = entities.slice(1).map((e) => e.id);

      for (const dupId of duplicateIds) {
        // mergeEntities pre-dedups edges that would collide with the
        // survivor's (idx_rel_unique_edge), transfers aliases/mentions, and
        // removes the duplicate's vec/FTS rows — a bare repoint+DELETE did
        // none of that and aborted on the first shared edge
        mergeEntities(db, survivorId, dupId);
        merged++;
      }
    }
  });

  doMerge();

  return { merged };
}

/**
 * Prune orphan entities: entities with no relationships, low mention
 * counts, and old last_seen timestamps.
 *
 * Preserves entities that have any relationships.
 */
export function pruneOrphanEntities(
  db: Database.Database,
  options: { minMentions?: number; maxAgeDays?: number } = {},
): { pruned: number } {
  const minMentions = options.minMentions ?? 2;
  const maxAgeDays = options.maxAgeDays ?? 90;
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;

  const result = db
    .prepare(
      `DELETE FROM entities
       WHERE mention_count < ?
         AND last_seen < ?
         AND NOT EXISTS (
           SELECT 1 FROM relationships r
           WHERE r.source_entity_id = entities.id OR r.target_entity_id = entities.id
         )`,
    )
    .run(minMentions, cutoff);

  return { pruned: result.changes };
}

/**
 * Prune stale generations: delete topic_clusters, bridge_scores,
 * temporal_patterns, and reflection_observations for generations
 * older than (latest - keepGenerations).
 */
export function pruneStaleGenerations(
  db: Database.Database,
  options: { keepGenerations?: number } = {},
): { pruned: number } {
  const keepGenerations = options.keepGenerations ?? 5;

  // Get latest generation
  const genRow = db
    .prepare("SELECT MAX(generation) as maxGen FROM topic_clusters")
    .get() as { maxGen: number | null } | undefined;

  const maxGen = genRow?.maxGen;
  if (!maxGen) return { pruned: 0 };

  const cutoffGeneration = maxGen - keepGenerations;
  if (cutoffGeneration < 1) return { pruned: 0 };

  let totalPruned = 0;

  const doPrune = db.transaction(() => {
    const r1 = db
      .prepare("DELETE FROM topic_clusters WHERE generation < ?")
      .run(cutoffGeneration);
    totalPruned += r1.changes;

    const r2 = db
      .prepare("DELETE FROM bridge_scores WHERE generation < ?")
      .run(cutoffGeneration);
    totalPruned += r2.changes;

    const r3 = db
      .prepare("DELETE FROM temporal_patterns WHERE generation < ?")
      .run(cutoffGeneration);
    totalPruned += r3.changes;

    const r4 = db
      .prepare("DELETE FROM reflection_observations WHERE generation < ?")
      .run(cutoffGeneration);
    totalPruned += r4.changes;
  });

  doPrune();

  return { pruned: totalPruned };
}
