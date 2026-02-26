import type Database from "better-sqlite3";
import type {
  SearchOptions,
  SearchResult,
  RecallResponse,
} from "../core/types.js";
import { embedQuery } from "./embeddings.js";

// ─── RRF Fusion ────────────────────────────────────────────────

interface RankedItem {
  id: string;
  rank: number;
}

/**
 * Reciprocal Rank Fusion: merge results from multiple rankings.
 * score = sum(1 / (k + rank_i))
 */
export function rrfFuse(
  vectorResults: RankedItem[],
  ftsResults: RankedItem[],
  k: number = 60,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();

  for (const item of vectorResults) {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + item.rank));
  }
  for (const item of ftsResults) {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + item.rank));
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// ─── Token Budgeting ───────────────────────────────────────────

/**
 * Greedily fill results within a token budget.
 */
export function budgetResults(
  results: SearchResult[],
  budget: number,
): SearchResult[] {
  const selected: SearchResult[] = [];
  let used = 0;

  for (const result of results) {
    if (used + result.tokenEstimate > budget) continue;
    selected.push(result);
    used += result.tokenEstimate;
  }

  return selected;
}

// ─── XML Formatting ────────────────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Format recall results as XML.
 */
export function formatRecallXml(response: RecallResponse): string {
  const lines: string[] = [];
  lines.push(
    `<engram_memory query="${escapeXml(response.query)}" tokens_used="${response.tokensUsed}" total_results="${response.totalResults}">`,
  );

  for (const result of response.results) {
    const meta = result.metadata as Record<string, string>;
    const date = meta.date || "";
    const project = meta.project || "";
    const score = Math.round(result.score * 100);

    lines.push(
      `  <episodic date="${escapeXml(date)}" project="${escapeXml(project)}" relevance="${score}%">`,
    );
    lines.push(`    ${escapeXml(result.content)}`);
    lines.push("  </episodic>");
  }

  lines.push("</engram_memory>");
  return lines.join("\n");
}

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
    fusedIds = fused.slice(0, limit).map((r) => r.id);
    scoreMap = new Map(fused.map((r) => [r.id, r.score]));
  } else {
    const items = mode === "vector" ? vectorResults : ftsResults;
    fusedIds = items.slice(0, limit).map((r) => r.id);
    // Normalize ranks to 0-1 scores
    const maxRank = items.length || 1;
    scoreMap = new Map(
      items.map((r) => [r.id, 1 - (r.rank - 1) / maxRank]),
    );
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
