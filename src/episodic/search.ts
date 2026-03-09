import type Database from "better-sqlite3";
import type {
  SearchOptions,
  SearchResult,
  RecallResponse,
} from "../_core/types/index.js";
import { embedQuery } from "../_core/embeddings/index.js";
import {
  rrfFuse,
  normalizeMinMaxFloored,
  type RankedItem,
} from "../_core/search/rrf.js";
import { budgetResults } from "../_core/search/orchestrator.js";
import { allocateBudget } from "../_core/search/budget.js";

// ─── Re-exports ─────────────────────────────────────────────────
// Preserve backward compatibility for existing imports from episodic/search.
export { rrfFuse, normalizeMinMaxFloored } from "../_core/search/rrf.js";
export { escapeXml, formatRecallXml } from "../_core/search/format.js";
export { budgetResults, searchMultiSource } from "../_core/search/orchestrator.js";

// ─── Hybrid Search ─────────────────────────────────────────────

/**
 * Build a date filter clause and params for use in SQL.
 */
function buildDateFilter(
  after?: string,
  before?: string,
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (after) {
    conditions.push("e.timestamp >= ?");
    params.push(after);
  }
  if (before) {
    conditions.push("e.timestamp <= ?");
    params.push(before);
  }

  return {
    clause: conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "",
    params,
  };
}

/**
 * Vector search using vec0.
 */
function vectorSearch(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number,
  after?: string,
  before?: string,
): RankedItem[] {
  const embeddingBuf = Buffer.from(new Float32Array(queryEmbedding).buffer);

  // vec0 MATCH returns results ordered by distance; post-filter by date
  // We fetch more than needed to allow for date filtering
  const fetchLimit = limit * 3;

  const rows = db
    .prepare(
      `SELECT vec.id, vec.distance
       FROM vec_exchanges AS vec
       WHERE vec.embedding MATCH ? AND k = ?
       ORDER BY vec.distance ASC`,
    )
    .all(embeddingBuf, fetchLimit) as { id: string; distance: number }[];

  // Post-filter by date if needed
  let filtered = rows;
  if (after || before) {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const { clause, params } = buildDateFilter(after, before);

    const dateFiltered = db
      .prepare(
        `SELECT id FROM exchanges AS e
         WHERE e.id IN (${placeholders}) ${clause}`,
      )
      .all(...ids, ...params) as { id: string }[];

    const validIds = new Set(dateFiltered.map((r) => r.id));
    filtered = rows.filter((r) => validIds.has(r.id));
  }

  return filtered.slice(0, limit).map((row, idx) => ({
    id: row.id,
    rank: idx + 1,
  }));
}

/**
 * FTS5 text search.
 */
function ftsSearch(
  db: Database.Database,
  query: string,
  limit: number,
  after?: string,
  before?: string,
): RankedItem[] {
  // Sanitize FTS query: escape special chars, wrap terms in quotes for safety
  const sanitized = query
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(" OR ");

  if (!sanitized) return [];

  const { clause, params } = buildDateFilter(after, before);

  try {
    const rows = db
      .prepare(
        `SELECT e.id, fts.rank
         FROM exchanges_fts AS fts
         JOIN exchanges AS e ON e.rowid = fts.rowid
         WHERE exchanges_fts MATCH ?
         ${clause}
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(sanitized, ...params, limit) as { id: string; rank: number }[];

    return rows.map((row, idx) => ({
      id: row.id,
      rank: idx + 1,
    }));
  } catch {
    // FTS query syntax errors → return empty
    return [];
  }
}

/**
 * Fetch full exchange data for a list of IDs, preserving order.
 */
function fetchExchanges(
  db: Database.Database,
  orderedIds: string[],
  scores: Map<string, number>,
): SearchResult[] {
  if (orderedIds.length === 0) return [];

  const placeholders = orderedIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM exchanges WHERE id IN (${placeholders})`,
    )
    .all(...orderedIds) as Record<string, unknown>[];

  const rowMap = new Map(rows.map((r) => [r.id as string, r]));

  return orderedIds
    .filter((id) => rowMap.has(id))
    .map((id) => {
      const row = rowMap.get(id)!;
      const userMsg = (row.user_message as string) || "";
      const assistantMsg = (row.assistant_message as string) || "";

      // Build content snippet
      const userSnippet = userMsg.substring(0, 200).replace(/\s+/g, " ").trim();
      const assistantSnippet = assistantMsg
        .substring(0, 300)
        .replace(/\s+/g, " ")
        .trim();
      const content = `User: ${userSnippet}\nAssistant: ${assistantSnippet}`;

      return {
        id,
        source: "episodic" as const,
        score: scores.get(id) ?? 0,
        content,
        metadata: {
          project: row.project as string,
          date: (row.timestamp as string).split("T")[0],
          conversationId: row.conversation_id as string,
          sessionId: row.session_id,
          gitBranch: row.git_branch,
        },
        tokenEstimate: (row.token_estimate as number) || 50,
      };
    });
}

/**
 * Search the episodic store with hybrid vector + FTS search and RRF fusion.
 */
export async function searchEpisodic(
  db: Database.Database,
  options: SearchOptions,
): Promise<RecallResponse> {
  const {
    query,
    mode = "hybrid",
    limit = 10,
    budget = 1500,
    after,
    before,
  } = options;

  const fetchK = Math.max(limit, 20);
  let vectorResults: RankedItem[] = [];
  let ftsResults: RankedItem[] = [];

  // 1. Vector search
  if (mode === "vector" || mode === "hybrid") {
    const queryEmbedding = await embedQuery(query);
    vectorResults = vectorSearch(db, queryEmbedding, fetchK, after, before);
  }

  // 2. FTS search
  if (mode === "text" || mode === "hybrid") {
    ftsResults = ftsSearch(db, query, fetchK, after, before);
  }

  // 3. Fuse results
  let fusedIds: string[];
  let scoreMap: Map<string, number>;

  if (mode === "hybrid") {
    const fused = rrfFuse(vectorResults, ftsResults);
    normalizeMinMaxFloored(fused);
    fusedIds = fused.slice(0, limit).map((r) => r.id);
    scoreMap = new Map(fused.map((r) => [r.id, r.score]));
  } else {
    const items = mode === "vector" ? vectorResults : ftsResults;
    const scored = items.map((r) => ({ id: r.id, score: 1 / (60 + r.rank) }));
    normalizeMinMaxFloored(scored);
    fusedIds = scored.slice(0, limit).map((r) => r.id);
    scoreMap = new Map(scored.map((r) => [r.id, r.score]));
  }

  // 4. Fetch full exchange data
  const results = fetchExchanges(db, fusedIds, scoreMap);
  const totalResults = results.length;

  // 5. Apply token budget
  const budgeted = budgetResults(results, budget);
  const tokensUsed = budgeted.reduce((sum, r) => sum + r.tokenEstimate, 0);

  return {
    results: budgeted,
    tokensUsed,
    totalResults,
    query,
  };
}
