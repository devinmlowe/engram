/**
 * Temporal pattern analysis for the knowledge graph.
 *
 * Detects patterns in how the graph evolves over time using
 * SQL-native queries against entity/relationship timestamps
 * and topic_clusters generations. No external dependencies
 * beyond better-sqlite3.
 *
 * Pattern types:
 * - entity_burst: sudden spikes in entity creation rate
 * - topic_emergence: clusters of new entities appearing together
 * - topic_decay: entity groups going stale (not recently seen)
 * - community_shift: community membership changes between generations
 */

import type Database from "better-sqlite3";
import type { TemporalPattern, TemporalPatternType } from "./types.js";

// ─── Configuration ──────────────────────────────────────────────

export interface TemporalConfig {
  windowDays: number;
  burstThreshold: number;
  decayDaysThreshold: number;
  jaccardThreshold: number;
}

export const DEFAULT_TEMPORAL_CONFIG: TemporalConfig = {
  windowDays: 7,
  burstThreshold: 3,
  decayDaysThreshold: 60,
  jaccardThreshold: 0.3,
};

// ─── Constants ────────────────────────────────────────────────────

const SECONDS_PER_DAY = 86400;

// ─── Entity Burst Detection ──────────────────────────────────────

/**
 * Detect entity bursts — entities with sudden high creation rates.
 * Looks for time windows where entity creation count exceeds 2x the average.
 */
export function detectEntityBursts(
  db: Database.Database,
  windowDays: number,
  generation: number,
): TemporalPattern[] {
  const windowSeconds = windowDays * SECONDS_PER_DAY;

  // Group entities by time window and count per window
  // CAST to INTEGER ensures proper bucketing (SQLite does real division by default)
  const rows = db
    .prepare(
      `SELECT
        CAST(first_seen / ? AS INTEGER) AS window_idx,
        COUNT(*) AS cnt,
        MIN(first_seen) AS window_start,
        MAX(first_seen) AS window_end,
        GROUP_CONCAT(id) AS entity_ids
      FROM entities
      WHERE first_seen IS NOT NULL
      GROUP BY window_idx
      ORDER BY window_idx`,
    )
    .all(windowSeconds) as Array<{
    window_idx: number;
    cnt: number;
    window_start: number;
    window_end: number;
    entity_ids: string;
  }>;

  if (rows.length === 0) return [];

  // Compute average count across all windows
  const totalEntities = rows.reduce((sum, r) => sum + r.cnt, 0);
  const avgCount = totalEntities / rows.length;
  const burstThreshold = avgCount * 2;

  // A burst requires at least 2 windows to make sense (need a baseline)
  // and the threshold must be meaningful (at least 2 entities)
  if (rows.length < 2 || burstThreshold < 2) return [];

  const patterns: TemporalPattern[] = [];

  for (const row of rows) {
    if (row.cnt >= burstThreshold) {
      const entityIds = row.entity_ids.split(",");
      const timeStart = row.window_idx * windowSeconds;
      const timeEnd = timeStart + windowSeconds;

      const startDate = formatDate(timeStart);
      const endDate = formatDate(timeEnd);

      patterns.push({
        id: crypto.randomUUID(),
        type: "entity_burst",
        description: `Burst of ${row.cnt} new entities in ${windowDays}-day window (${startDate} to ${endDate}), ${(row.cnt / avgCount).toFixed(1)}x the average rate of ${avgCount.toFixed(1)}`,
        entityIds,
        timeStart,
        timeEnd,
        confidence: Math.min(0.9, 0.5 + (row.cnt / burstThreshold - 1) * 0.2),
        metadata: {
          count: row.cnt,
          average: avgCount,
          ratio: row.cnt / avgCount,
          windowDays,
        },
        generation,
      });
    }
  }

  return patterns;
}

// ─── Topic Emergence Detection ───────────────────────────────────

/**
 * Detect topic emergence — groups of entities first seen together in
 * a narrow time window. Uses entity first_seen timestamps to find
 * clusters of new entities.
 */
export function detectTopicEmergence(
  db: Database.Database,
  windowDays: number,
  minEntities: number,
  generation: number,
): TemporalPattern[] {
  const windowSeconds = windowDays * SECONDS_PER_DAY;

  const rows = db
    .prepare(
      `SELECT
        CAST(first_seen / ? AS INTEGER) AS window_idx,
        COUNT(*) AS cnt,
        MIN(first_seen) AS window_start,
        MAX(first_seen) AS window_end,
        GROUP_CONCAT(id) AS entity_ids,
        GROUP_CONCAT(name) AS entity_names
      FROM entities
      WHERE first_seen IS NOT NULL
      GROUP BY window_idx
      HAVING COUNT(*) >= ?
      ORDER BY window_idx`,
    )
    .all(windowSeconds, minEntities) as Array<{
    window_idx: number;
    cnt: number;
    window_start: number;
    window_end: number;
    entity_ids: string;
    entity_names: string;
  }>;

  const patterns: TemporalPattern[] = [];

  for (const row of rows) {
    const entityIds = row.entity_ids.split(",");
    const entityNames = row.entity_names.split(",");
    const timeStart = row.window_idx * windowSeconds;
    const timeEnd = timeStart + windowSeconds;

    // Show up to 3 entity names in the description
    const namePreview =
      entityNames.length <= 3
        ? entityNames.join(", ")
        : `${entityNames.slice(0, 3).join(", ")} and ${entityNames.length - 3} more`;

    const startDate = formatDate(timeStart);

    patterns.push({
      id: crypto.randomUUID(),
      type: "topic_emergence",
      description: `${row.cnt} entities emerged together around ${startDate}: ${namePreview}`,
      entityIds,
      timeStart,
      timeEnd,
      confidence: Math.min(0.9, 0.4 + row.cnt * 0.05),
      metadata: {
        count: row.cnt,
        entityNames,
        windowDays,
      },
      generation,
    });
  }

  return patterns;
}

// ─── Topic Decay Detection ───────────────────────────────────────

/**
 * Detect topic decay — entity groups whose last_seen is significantly
 * older than current time. Entities not seen in the last N days that
 * were previously active (mention_count >= 2).
 */
export function detectTopicDecay(
  db: Database.Database,
  stalenessDays: number,
  minEntities: number,
  generation: number,
): TemporalPattern[] {
  const now = Math.floor(Date.now() / 1000);
  const staleCutoff = now - stalenessDays * SECONDS_PER_DAY;

  const rows = db
    .prepare(
      `SELECT id, name, last_seen, mention_count
      FROM entities
      WHERE last_seen IS NOT NULL
        AND last_seen < ?
        AND mention_count >= 2
      ORDER BY last_seen ASC`,
    )
    .all(staleCutoff) as Array<{
    id: string;
    name: string;
    last_seen: number;
    mention_count: number;
  }>;

  if (rows.length < minEntities) return [];

  // Group stale entities by their last_seen window to find cohorts
  // that decayed together
  const windowSeconds = stalenessDays * SECONDS_PER_DAY;
  const groups = new Map<
    number,
    Array<{ id: string; name: string; lastSeen: number; mentionCount: number }>
  >();

  for (const row of rows) {
    const windowIdx = Math.floor(row.last_seen / windowSeconds);
    const existing = groups.get(windowIdx);
    if (existing) {
      existing.push({
        id: row.id,
        name: row.name,
        lastSeen: row.last_seen,
        mentionCount: row.mention_count,
      });
    } else {
      groups.set(windowIdx, [
        {
          id: row.id,
          name: row.name,
          lastSeen: row.last_seen,
          mentionCount: row.mention_count,
        },
      ]);
    }
  }

  const patterns: TemporalPattern[] = [];

  for (const [windowIdx, entities] of groups) {
    if (entities.length < minEntities) continue;

    const entityIds = entities.map((e) => e.id);
    const entityNames = entities.map((e) => e.name);
    const minLastSeen = Math.min(...entities.map((e) => e.lastSeen));
    const maxLastSeen = Math.max(...entities.map((e) => e.lastSeen));
    const avgDaysStale = Math.round(
      (now - (minLastSeen + maxLastSeen) / 2) / SECONDS_PER_DAY,
    );

    const namePreview =
      entityNames.length <= 3
        ? entityNames.join(", ")
        : `${entityNames.slice(0, 3).join(", ")} and ${entityNames.length - 3} more`;

    patterns.push({
      id: crypto.randomUUID(),
      type: "topic_decay",
      description: `${entities.length} previously active entities inactive for ~${avgDaysStale} days: ${namePreview}`,
      entityIds,
      timeStart: windowIdx * windowSeconds,
      timeEnd: (windowIdx + 1) * windowSeconds,
      confidence: Math.min(
        0.9,
        0.5 + (avgDaysStale / (stalenessDays * 2)) * 0.3,
      ),
      metadata: {
        count: entities.length,
        entityNames,
        avgDaysStale,
        stalenessDays,
      },
      generation,
    });
  }

  return patterns;
}

// ─── Community Evolution ─────────────────────────────────────────

/**
 * Track community evolution between generations.
 * Compare current topic_clusters to previous generation using Jaccard
 * similarity. Detect: birth (new community), death (disappeared),
 * growth, contraction.
 */
export function trackCommunityEvolution(
  db: Database.Database,
  currentGeneration: number,
): TemporalPattern[] {
  const previousGeneration = currentGeneration - 1;

  if (previousGeneration < 1) return [];

  // Load current generation clusters
  const currentClusters = loadClusters(db, currentGeneration);
  const previousClusters = loadClusters(db, previousGeneration);

  if (currentClusters.length === 0 && previousClusters.length === 0) return [];

  const patterns: TemporalPattern[] = [];
  const now = Math.floor(Date.now() / 1000);

  // Track which previous clusters were matched
  const matchedPrevious = new Set<string>();

  for (const current of currentClusters) {
    let bestMatch: { cluster: ClusterData; jaccard: number } | null = null;

    for (const prev of previousClusters) {
      const jaccard = jaccardSimilarity(current.entityIds, prev.entityIds);
      if (jaccard > 0 && (!bestMatch || jaccard > bestMatch.jaccard)) {
        bestMatch = { cluster: prev, jaccard };
      }
    }

    if (bestMatch && bestMatch.jaccard > 0.1) {
      // Matched — check for growth or contraction
      matchedPrevious.add(bestMatch.cluster.id);

      const sizeDiff = current.entityIds.length - bestMatch.cluster.entityIds.length;
      const previousSize = bestMatch.cluster.entityIds.length;

      if (sizeDiff > 0) {
        // Growth
        const newEntities = current.entityIds.filter(
          (id) => !bestMatch!.cluster.entityIds.includes(id),
        );
        patterns.push({
          id: crypto.randomUUID(),
          type: "community_shift",
          description: `Community "${current.name}" grew by ${sizeDiff} entities (${previousSize} -> ${current.entityIds.length}), Jaccard similarity ${bestMatch.jaccard.toFixed(2)} with previous generation`,
          entityIds: newEntities,
          timeStart: now - SECONDS_PER_DAY, // approximate
          timeEnd: now,
          confidence: Math.min(0.9, bestMatch.jaccard + 0.1),
          metadata: {
            changeType: "growth",
            communityName: current.name,
            previousSize,
            currentSize: current.entityIds.length,
            jaccardSimilarity: bestMatch.jaccard,
            currentGeneration,
            previousGeneration,
          },
          generation: currentGeneration,
        });
      } else if (sizeDiff < 0) {
        // Contraction
        const lostEntities = bestMatch.cluster.entityIds.filter(
          (id) => !current.entityIds.includes(id),
        );
        patterns.push({
          id: crypto.randomUUID(),
          type: "community_shift",
          description: `Community "${current.name}" contracted by ${Math.abs(sizeDiff)} entities (${previousSize} -> ${current.entityIds.length}), Jaccard similarity ${bestMatch.jaccard.toFixed(2)} with previous generation`,
          entityIds: lostEntities,
          timeStart: now - SECONDS_PER_DAY,
          timeEnd: now,
          confidence: Math.min(0.9, bestMatch.jaccard + 0.1),
          metadata: {
            changeType: "contraction",
            communityName: current.name,
            previousSize,
            currentSize: current.entityIds.length,
            jaccardSimilarity: bestMatch.jaccard,
            currentGeneration,
            previousGeneration,
          },
          generation: currentGeneration,
        });
      }
    } else {
      // No match — this is a birth
      patterns.push({
        id: crypto.randomUUID(),
        type: "community_shift",
        description: `New community "${current.name}" emerged with ${current.entityIds.length} entities in generation ${currentGeneration}`,
        entityIds: current.entityIds,
        timeStart: now - SECONDS_PER_DAY,
        timeEnd: now,
        confidence: 0.7,
        metadata: {
          changeType: "birth",
          communityName: current.name,
          currentSize: current.entityIds.length,
          currentGeneration,
        },
        generation: currentGeneration,
      });
    }
  }

  // Detect deaths — previous clusters with no current match
  for (const prev of previousClusters) {
    if (!matchedPrevious.has(prev.id)) {
      patterns.push({
        id: crypto.randomUUID(),
        type: "community_shift",
        description: `Community "${prev.name}" from generation ${previousGeneration} disappeared (had ${prev.entityIds.length} entities)`,
        entityIds: prev.entityIds,
        timeStart: now - SECONDS_PER_DAY,
        timeEnd: now,
        confidence: 0.6,
        metadata: {
          changeType: "death",
          communityName: prev.name,
          previousSize: prev.entityIds.length,
          currentGeneration,
          previousGeneration,
        },
        generation: currentGeneration,
      });
    }
  }

  return patterns;
}

// ─── Phase Transition Detection ─────────────────────────────────

/**
 * Detect phase transitions by computing entity frequency vectors
 * per time window using relationships.created_at. Measures cosine
 * distance between consecutive windows. If distance > 0.5, flags
 * as phase_transition.
 */
export function detectPhaseTransitions(
  db: Database.Database,
  config?: Partial<TemporalConfig>,
): TemporalPattern[] {
  const windowDays =
    config?.windowDays ?? DEFAULT_TEMPORAL_CONFIG.windowDays;
  const windowSeconds = windowDays * SECONDS_PER_DAY;

  const rows = db
    .prepare(
      `SELECT source_entity_id, target_entity_id, created_at
      FROM relationships
      WHERE created_at IS NOT NULL
      ORDER BY created_at`,
    )
    .all() as Array<{
    source_entity_id: string;
    target_entity_id: string;
    created_at: number;
  }>;

  if (rows.length === 0) return [];

  const windows = new Map<number, Map<string, number>>();

  for (const row of rows) {
    const windowIdx = Math.floor(row.created_at / windowSeconds);
    let freq = windows.get(windowIdx);
    if (!freq) {
      freq = new Map();
      windows.set(windowIdx, freq);
    }
    freq.set(
      row.source_entity_id,
      (freq.get(row.source_entity_id) ?? 0) + 1,
    );
    freq.set(
      row.target_entity_id,
      (freq.get(row.target_entity_id) ?? 0) + 1,
    );
  }

  const sortedWindows = [...windows.entries()].sort(([a], [b]) => a - b);

  if (sortedWindows.length < 2) return [];

  const patterns: TemporalPattern[] = [];

  for (let i = 1; i < sortedWindows.length; i++) {
    const [prevIdx, prevFreq] = sortedWindows[i - 1];
    const [currIdx, currFreq] = sortedWindows[i];

    const distance = cosineDistance(prevFreq, currFreq);

    if (distance > 0.5) {
      const allEntityIds = new Set([...prevFreq.keys(), ...currFreq.keys()]);
      const timeStart = prevIdx * windowSeconds;
      const timeEnd = (currIdx + 1) * windowSeconds;

      patterns.push({
        id: crypto.randomUUID(),
        type: "phase_transition",
        description: `Phase transition detected between windows ${formatDate(timeStart)} and ${formatDate(timeEnd)} (cosine distance: ${distance.toFixed(3)})`,
        entityIds: [...allEntityIds],
        timeStart,
        timeEnd,
        confidence: Math.min(0.95, 0.5 + distance * 0.4),
        metadata: {
          cosineDistance: distance,
          previousWindowEntities: prevFreq.size,
          currentWindowEntities: currFreq.size,
          windowDays,
        },
        generation: 0,
      });
    }
  }

  return patterns;
}

// ─── Bridge Formation Detection ─────────────────────────────────

/**
 * Detect bridge formation -- entities in bridge_scores for the
 * latest generation that were not bridges in the previous generation.
 */
export function detectBridgeFormation(
  db: Database.Database,
): TemporalPattern[] {
  const genRows = db
    .prepare(
      `SELECT DISTINCT generation
      FROM bridge_scores
      ORDER BY generation DESC
      LIMIT 2`,
    )
    .all() as Array<{ generation: number }>;

  if (genRows.length === 0) return [];

  const latestGen = genRows[0].generation;
  const previousGen = genRows.length > 1 ? genRows[1].generation : null;

  const latestBridges = db
    .prepare(
      `SELECT bs.entity_id, e.name, bs.bridge_score
      FROM bridge_scores bs
      JOIN entities e ON e.id = bs.entity_id
      WHERE bs.generation = ?`,
    )
    .all(latestGen) as Array<{
    entity_id: string;
    name: string;
    bridge_score: number;
  }>;

  if (latestBridges.length === 0) return [];

  const previousBridgeIds = new Set<string>();
  if (previousGen !== null) {
    const prevRows = db
      .prepare(
        `SELECT entity_id FROM bridge_scores WHERE generation = ?`,
      )
      .all(previousGen) as Array<{ entity_id: string }>;
    for (const row of prevRows) {
      previousBridgeIds.add(row.entity_id);
    }
  }

  const newBridges = latestBridges.filter(
    (b) => !previousBridgeIds.has(b.entity_id),
  );

  if (newBridges.length === 0) return [];

  const now = nowUnix();
  const entityIds = newBridges.map((b) => b.entity_id);
  const entityNames = newBridges.map((b) => b.name);

  const namePreview =
    entityNames.length <= 3
      ? entityNames.join(", ")
      : `${entityNames.slice(0, 3).join(", ")} and ${entityNames.length - 3} more`;

  return [
    {
      id: crypto.randomUUID(),
      type: "bridge_formation",
      description: `${newBridges.length} new bridge entities formed in generation ${latestGen}: ${namePreview}`,
      entityIds,
      timeStart: now - SECONDS_PER_DAY,
      timeEnd: now,
      confidence: Math.min(0.9, 0.5 + newBridges.length * 0.1),
      metadata: {
        latestGeneration: latestGen,
        previousGeneration: previousGen,
        newBridgeCount: newBridges.length,
        entityNames,
        bridgeScores: Object.fromEntries(
          newBridges.map((b) => [b.entity_id, b.bridge_score]),
        ),
      },
      generation: latestGen,
    },
  ];
}

// ─── Full Analysis Pipeline ──────────────────────────────────────

/**
 * Run all temporal analyses and persist results.
 * Returns all detected patterns.
 */
export function analyzeTemporalPatterns(
  db: Database.Database,
  generation: number,
  options?: {
    windowDays?: number;
    stalenessDays?: number;
    minEntities?: number;
  },
): TemporalPattern[] {
  const windowDays = options?.windowDays ?? 7;
  const stalenessDays = options?.stalenessDays ?? 30;
  const minEntities = options?.minEntities ?? 3;

  const partialConfig: Partial<TemporalConfig> = { windowDays };

  const patterns: TemporalPattern[] = [
    ...detectEntityBursts(db, windowDays, generation),
    ...detectTopicEmergence(db, windowDays, minEntities, generation),
    ...detectTopicDecay(db, stalenessDays, minEntities, generation),
    ...trackCommunityEvolution(db, generation),
    ...detectPhaseTransitions(db, partialConfig).map((p) => ({
      ...p,
      generation,
    })),
    ...detectBridgeFormation(db).map((p) => ({
      ...p,
      generation,
    })),
  ];

  if (patterns.length > 0) {
    persistTemporalPatterns(db, patterns);
  }

  return patterns;
}

// ─── Persistence ─────────────────────────────────────────────────

/**
 * Persist temporal patterns to the database using a transaction.
 */
export function persistTemporalPatterns(
  db: Database.Database,
  patterns: TemporalPattern[],
): void {
  if (patterns.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO temporal_patterns
      (id, type, description, entity_ids, time_start, time_end, confidence, metadata, generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const pattern of patterns) {
      insert.run(
        pattern.id,
        pattern.type,
        pattern.description,
        JSON.stringify(pattern.entityIds),
        pattern.timeStart,
        pattern.timeEnd,
        pattern.confidence,
        JSON.stringify(pattern.metadata),
        pattern.generation,
      );
    }
  });

  insertMany();
}

/**
 * Retrieve temporal patterns for a given generation (or latest).
 * Optionally filtered by pattern type.
 */
export function getTemporalPatterns(
  db: Database.Database,
  generation?: number,
  type?: TemporalPatternType,
): TemporalPattern[] {
  let targetGeneration = generation;

  if (targetGeneration === undefined) {
    const maxRow = db
      .prepare("SELECT MAX(generation) AS max_gen FROM temporal_patterns")
      .get() as { max_gen: number | null } | undefined;

    const maxGen = maxRow?.max_gen;
    if (maxGen == null) return [];
    targetGeneration = maxGen;
  }

  let query = `SELECT id, type, description, entity_ids, time_start, time_end, confidence, metadata, generation
    FROM temporal_patterns
    WHERE generation = ?`;
  const params: Array<string | number> = [targetGeneration];

  if (type) {
    query += ` AND type = ?`;
    params.push(type);
  }

  query += ` ORDER BY confidence DESC`;

  const rows = db.prepare(query).all(...params) as Array<{
    id: string;
    type: string;
    description: string;
    entity_ids: string;
    time_start: number;
    time_end: number;
    confidence: number;
    metadata: string;
    generation: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    type: row.type as TemporalPatternType,
    description: row.description,
    entityIds: JSON.parse(row.entity_ids) as string[],
    timeStart: row.time_start,
    timeEnd: row.time_end,
    confidence: row.confidence,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    generation: row.generation,
  }));
}

// ─── Internal Helpers ────────────────────────────────────────────

interface ClusterData {
  id: string;
  name: string;
  entityIds: string[];
}

function loadClusters(
  db: Database.Database,
  generation: number,
): ClusterData[] {
  const rows = db
    .prepare(
      `SELECT id, name, entity_ids
      FROM topic_clusters
      WHERE generation = ?`,
    )
    .all(generation) as Array<{
    id: string;
    name: string;
    entity_ids: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    entityIds: JSON.parse(row.entity_ids) as string[],
  }));
}

/**
 * Compute Jaccard similarity between two sets of strings.
 * J(A, B) = |A ∩ B| / |A ∪ B|
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;

  return intersection / union;
}

/**
 * Return current time as unix epoch seconds.
 */
function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Compute cosine distance between two frequency vectors.
 * distance = 1 - cosine_similarity
 *
 * Returns 1.0 when vectors are orthogonal or either is zero.
 */
function cosineDistance(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  const allKeys = new Set([...a.keys(), ...b.keys()]);

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const key of allKeys) {
    const va = a.get(key) ?? 0;
    const vb = b.get(key) ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  if (normA === 0 || normB === 0) return 1.0;

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1.0 - similarity;
}

/**
 * Format a unix timestamp to a short date string.
 */
function formatDate(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return date.toISOString().split("T")[0];
}

// ─── Exported Helpers (for testing) ─────────────────────────────

export const _test = {
  jaccardSimilarity,
  cosineDistance,
  nowUnix,
};
