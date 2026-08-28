/**
 * Decay-aware semantic memory search.
 *
 * Combines vector similarity (vec_memories) and full-text search (memories_fts)
 * with RRF fusion, then applies FSRS-inspired decay rescoring to prioritize
 * memories that are both relevant and retrievable.
 *
 * Phase 3, Stream D implementation.
 */

import type Database from "better-sqlite3";
import type {
  SearchOptions,
  SearchResult,
} from "../_core/types/index.js";
import type { MemoryType, Memory } from "./types.js";
import { embedQuery } from "../_core/embeddings/index.js";
import { rrfFuse, normalizeMinMaxFloored } from "../_core/search/rrf.js";
import { computeRetrievalScore } from "./decay.js";

// ─── Row Type Helpers ───────────────────────────────────────────

interface MemoryRow {
  id: string;
  type: string;
  content: string;
  context: string | null;
  confidence: number;
  importance: number;
  access_count: number;
  last_accessed: number | null;
  created_at: number;
  updated_at: number | null;
  source_exchanges: string | null;
  superseded_by: string | null;
  is_active: number;
  scope: string | null;
  stability: number | null;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    type: row.type as MemoryType,
    content: row.content,
    context: row.context ?? undefined,
    confidence: row.confidence,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    sourceExchanges: row.source_exchanges
      ? JSON.parse(row.source_exchanges)
      : [],
    supersededBy: row.superseded_by ?? undefined,
    isActive: Boolean(row.is_active),
    scope: row.scope ?? "global",
    stability: row.stability ?? undefined,
  };
}

// ─── Ranked Item Interface ──────────────────────────────────────

interface RankedItem {
  id: string;
  rank: number;
}

// ─── Vector Search ──────────────────────────────────────────────

/**
 * Vector search on vec_memories. Returns ranked items by distance (ascending).
 */
function vectorSearchMemories(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number,
): RankedItem[] {
  const embeddingBuf = Buffer.from(new Float32Array(queryEmbedding).buffer);

  const rows = db
    .prepare(
      `SELECT id, distance
       FROM vec_memories
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance ASC`,
    )
    .all(embeddingBuf, limit) as Array<{ id: string; distance: number }>;

  return rows.map((row, idx) => ({
    id: row.id,
    rank: idx + 1,
  }));
}

// ─── FTS Search ─────────────────────────────────────────────────

/**
 * Full-text search on memories_fts. Returns ranked items by BM25 rank.
 */
function ftsSearchMemories(
  db: Database.Database,
  query: string,
  limit: number,
): RankedItem[] {
  // Sanitize FTS query: escape special chars, wrap terms in quotes
  const sanitized = query
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" OR ");

  if (!sanitized) return [];

  try {
    const rows = db
      .prepare(
        `SELECT m.id, fts.rank
         FROM memories_fts AS fts
         JOIN memories AS m ON m.rowid = fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(sanitized, limit) as Array<{ id: string; rank: number }>;

    return rows.map((row, idx) => ({
      id: row.id,
      rank: idx + 1,
    }));
  } catch {
    // FTS query syntax errors -> return empty
    return [];
  }
}

// ─── Main Search ────────────────────────────────────────────────

/**
 * Search the semantic memory store with hybrid vector + FTS search,
 * RRF fusion, and FSRS-inspired decay rescoring.
 *
 * Pipeline:
 * 1. Embed query with embedQuery()
 * 2. Vector search on vec_memories (top-20 nearest)
 * 3. FTS search on memories_fts (top-20 BM25 matches)
 * 4. RRF fusion
 * 5. Fetch full Memory objects from DB
 * 6. Apply decay-aware re-scoring via computeRetrievalScore()
 * 7. Re-sort by composite score
 * 8. Normalize with normalizeMinMaxFloored()
 * 9. Filter by is_active=true and optional type filter
 * 10. Format as SearchResult[]
 */
export async function searchSemantic(
  db: Database.Database,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const { query, types, scopes, limit = 10 } = options;

  if (!query || query.trim().length === 0) {
    return [];
  }

  const fetchK = Math.max(limit, 20);

  // 1. Embed query
  const queryEmbedding = await embedQuery(query);

  // 2. Vector search
  const vectorResults = vectorSearchMemories(db, queryEmbedding, fetchK);

  // 3. FTS search
  const ftsResults = ftsSearchMemories(db, query, fetchK);

  // 4. RRF fusion
  const fused = rrfFuse(vectorResults, ftsResults);

  if (fused.length === 0) {
    return [];
  }

  // 5. Fetch full Memory objects and filter
  const memoriesWithScores: Array<{
    memory: Memory;
    rrfScore: number;
  }> = [];

  for (const item of fused) {
    const row = db
      .prepare("SELECT * FROM memories WHERE id = ? AND is_active = 1")
      .get(item.id) as MemoryRow | undefined;

    if (!row) continue;

    const memory = rowToMemory(row);

    // Apply optional type filter
    if (types && types.length > 0 && !types.includes(memory.type)) {
      continue;
    }

    // Apply optional tenant-scope filter (ADR-010)
    if (scopes && scopes.length > 0 && !scopes.includes(memory.scope ?? "global")) {
      continue;
    }

    memoriesWithScores.push({ memory, rrfScore: item.score });
  }

  if (memoriesWithScores.length === 0) {
    return [];
  }

  // 6. Apply decay-aware re-scoring
  const scoredResults = memoriesWithScores.map(({ memory, rrfScore }) => {
    const compositeScore = computeRetrievalScore(rrfScore, memory);
    return { memory, score: compositeScore };
  });

  // 7. Re-sort by composite score (descending)
  scoredResults.sort((a, b) => b.score - a.score);

  // 8. Normalize
  const forNormalization = scoredResults.map((r) => ({
    id: r.memory.id,
    score: r.score,
  }));
  normalizeMinMaxFloored(forNormalization);

  // Re-apply normalized scores
  const normalizedScoreMap = new Map(
    forNormalization.map((r) => [r.id, r.score]),
  );

  // 9-10. Format as SearchResult[] (already filtered by is_active and types)
  const results: SearchResult[] = scoredResults
    .slice(0, limit)
    .map((r) => ({
      id: r.memory.id,
      source: "semantic" as const,
      score: normalizedScoreMap.get(r.memory.id) ?? r.score,
      content: r.memory.content,
      metadata: {
        type: r.memory.type,
        confidence: r.memory.confidence,
        importance: r.memory.importance,
        context: r.memory.context,
        accessCount: r.memory.accessCount,
      },
      tokenEstimate: Math.ceil(r.memory.content.length / 4) + 10,
    }));

  return results;
}
