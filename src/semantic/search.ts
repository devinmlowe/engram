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
import { computeRetrievalScore, computeConfidence } from "./decay.js";
import { buildFtsMatchQuery } from "../_core/search/fts-query.js";
import {
  buildEpochDateFilter,
  hasDateFilter,
  memoryBasisExpr,
  toIsoDay,
  type DateFilterInput,
} from "../_core/search/dates.js";

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
  event_ts?: number | null;
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
    eventTs: row.event_ts ?? undefined,
  };
}

// ─── Ranked Item Interface ──────────────────────────────────────

interface RankedItem {
  id: string;
  rank: number;
}

// ─── Vector Search ──────────────────────────────────────────────

/**
 * sqlite-vec rejects KNN queries with k > 4096 ("k value in knn query too
 * large"). The filter-escalation loop below can ask for far more than that
 * on a thin window (a date range or anniversary over a 16k-row store), so
 * the vector path is capped here; the FTS path has no such limit and keeps
 * growing with fetchK.
 */
export const VEC_MAX_K = 4096;

/** Temporal predicate shared by both candidate paths. */
interface DateScope {
  /** SQL expression for the basis timestamp, aliased on `m`. */
  basisExpr: string;
  filter: DateFilterInput;
}

/**
 * Vector search on vec_memories. Returns ranked items by distance (ascending).
 *
 * vec0 cannot filter, so with a date scope the nearest-neighbour window is
 * post-filtered against `memories` before fusion — the same shape the
 * episodic store uses, so both stores agree on edge semantics.
 */
function vectorSearchMemories(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number,
  dateScope?: DateScope,
): RankedItem[] {
  const embeddingBuf = Buffer.from(new Float32Array(queryEmbedding).buffer);

  const rows = db
    .prepare(
      `SELECT id, distance
       FROM vec_memories
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance ASC`,
    )
    .all(embeddingBuf, Math.min(limit, VEC_MAX_K)) as Array<{ id: string; distance: number }>;

  let filtered = rows;
  if (dateScope && rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const { clause, params } = buildEpochDateFilter(dateScope.basisExpr, dateScope.filter);
    const kept = db
      .prepare(`SELECT m.id FROM memories AS m WHERE m.id IN (${placeholders}) ${clause}`)
      .all(...ids, ...params) as Array<{ id: string }>;
    const keep = new Set(kept.map((r) => r.id));
    filtered = rows.filter((r) => keep.has(r.id));
  }

  return filtered.map((row, idx) => ({
    id: row.id,
    rank: idx + 1,
  }));
}

// ─── FTS Search ─────────────────────────────────────────────────

/**
 * SQL for the memories full-text lookup. `clauses` must start with the
 * `memories_fts MATCH ?` predicate; extra clauses filter the joined row.
 *
 * CROSS JOIN is deliberate: it pins memories_fts as the outer loop. With a
 * plain JOIN, SQLite prefers idx_memories_active, drives from `memories`
 * and evaluates the MATCH once per active row — 0.5s for a 3-term query
 * and 9.5s (134s unbounded) for an 80-word one on a 17k-memory store.
 * Driving from the FTS index costs single-digit milliseconds. Exported so
 * a test can assert the query plan.
 */
/**
 * BM25 column weights for memories_fts (content, context). `context` is a
 * provenance note — since #19 the Hermes mirror writes the same constant
 * string on every mirrored memory — so a hit there must not outrank a hit in
 * the content itself (#42). Exported so the plan test can pin it.
 */
export const MEMORIES_FTS_WEIGHTS = { content: 1.0, context: 0.25 } as const;

export function buildMemoriesFtsSql(clauses: readonly string[]): string {
  const { content, context } = MEMORIES_FTS_WEIGHTS;
  return `SELECT m.id, bm25(memories_fts, ${content}, ${context}) AS rank
         FROM memories_fts AS fts
         CROSS JOIN memories AS m ON m.rowid = fts.rowid
         WHERE ${clauses.join(" AND ")}
         ORDER BY rank
         LIMIT ?`;
}

/**
 * Full-text search on memories_fts. Returns ranked items by BM25 rank.
 */
function ftsSearchMemories(
  db: Database.Database,
  query: string,
  limit: number,
  filters: { types?: string[]; scopes?: string[]; dateScope?: DateScope } = {},
): RankedItem[] {
  // Bounded, de-noised OR query (stop words dropped, term count capped) —
  // see _core/search/fts-query.ts for why an unbounded OR is catastrophic.
  const sanitized = buildFtsMatchQuery(query);

  if (!sanitized) return [];

  // Filters live in SQL so the LIMIT counts matching rows, not raw hits
  const clauses = ["memories_fts MATCH ?", "m.is_active = 1"];
  const params: unknown[] = [sanitized];
  if (filters.types && filters.types.length > 0) {
    clauses.push(`m.type IN (${filters.types.map(() => "?").join(", ")})`);
    params.push(...filters.types);
  }
  if (filters.scopes && filters.scopes.length > 0) {
    clauses.push(`m.scope IN (${filters.scopes.map(() => "?").join(", ")})`);
    params.push(...filters.scopes);
  }
  if (filters.dateScope) {
    const { clause, params: dateParams } = buildEpochDateFilter(
      filters.dateScope.basisExpr,
      filters.dateScope.filter,
    );
    if (clause) {
      // clause is "AND a AND b" — strip the leading AND for the clause list
      clauses.push(clause.replace(/^AND /, ""));
      params.push(...dateParams);
    }
  }
  params.push(limit);

  try {
    const rows = db
      .prepare(buildMemoriesFtsSql(clauses))
      .all(...params) as Array<{ id: string; rank: number }>;

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
  const {
    query,
    types,
    scopes,
    limit = 10,
    after,
    before,
    anniversary,
    dateBasis = "filed",
  } = options;

  if (!query || query.trim().length === 0) {
    return [];
  }

  // Temporal scope: applied identically to both candidate paths so RRF
  // fusion stays balanced. "filed" = created_at; "event" = earliest source
  // exchange (event_ts) with created_at as the fallback.
  const dateFilter: DateFilterInput = { after, before, anniversary };
  const dateScope: DateScope | undefined = hasDateFilter(dateFilter)
    ? { basisExpr: memoryBasisExpr(dateBasis, "m"), filter: dateFilter }
    : undefined;

  const hasFilter =
    (types !== undefined && types.length > 0) ||
    (scopes !== undefined && scopes.length > 0) ||
    dateScope !== undefined;

  // 1. Embed query
  const queryEmbedding = await embedQuery(query);

  // Steps 2-5 run over a candidate window. The vector index can't filter by
  // type/scope, so with a filter active the window escalates (×4) until it
  // yields `limit` matches or covers every active memory — otherwise a tenant
  // whose memories are a thin slice of the store gets < limit (often 0) hits
  const activeCount = hasFilter
    ? (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_active = 1").get() as { n: number }).n
    : 0;
  const fetchRow = db.prepare("SELECT * FROM memories WHERE id = ? AND is_active = 1");

  let fetchK = Math.max(limit, 20);
  let memoriesWithScores: Array<{ memory: Memory; rrfScore: number }> = [];

  for (;;) {
    // 2. Vector search (date scope post-filtered against memories)
    const vectorResults = vectorSearchMemories(db, queryEmbedding, fetchK, dateScope);

    // 3. FTS search (filters applied in SQL)
    const ftsResults = ftsSearchMemories(db, query, fetchK, { types, scopes, dateScope });

    // 4. RRF fusion
    const fused = rrfFuse(vectorResults, ftsResults);

    // 5. Fetch full Memory objects and filter
    memoriesWithScores = [];
    for (const item of fused) {
      const row = fetchRow.get(item.id) as MemoryRow | undefined;
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

    if (!hasFilter || memoriesWithScores.length >= limit || fetchK >= activeCount) {
      break;
    }
    fetchK = Math.min(fetchK * 4, activeCount);
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
        // Composite confidence (base × corroboration × retrievability), not
        // the stored base — dream memories all share base 0.5, so reporting
        // the raw value renders every result as a flat 50%
        confidence: computeConfidence(r.memory),
        importance: r.memory.importance,
        context: r.memory.context,
        accessCount: r.memory.accessCount,
        // Temporal transparency: the day this result was filtered on under
        // the active basis, plus the raw timestamps for callers that need them
        date: toIsoDay(
          new Date(
            (dateBasis === "event"
              ? (r.memory.eventTs ?? r.memory.createdAt)
              : r.memory.createdAt) * 1000,
          ),
        ),
        createdAt: r.memory.createdAt,
        eventTs: r.memory.eventTs,
      },
      tokenEstimate: Math.ceil(r.memory.content.length / 4) + 10,
    }));

  return results;
}
