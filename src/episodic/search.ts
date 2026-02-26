import type Database from "better-sqlite3";
import type {
  SearchOptions,
  SearchResult,
  RecallResponse,
  SearchSource,
} from "../core/types.js";
import { embedQuery } from "./embeddings.js";
import { searchSemantic } from "../semantic/search.js";
import { searchGraph } from "../graph/search.js";

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

// ─── Score Normalization ──────────────────────────────────────

/**
 * Normalize scores to [floor, 1.0] using min-max scaling.
 * Ensures all results show intuitive percentage-style scores.
 */
export function normalizeMinMaxFloored(
  results: { id: string; score: number }[],
  floor: number = 0.1,
): void {
  if (results.length === 0) return;
  if (results.length === 1) {
    results[0].score = 0.85;
    return;
  }

  const max = results[0].score; // assumes pre-sorted descending
  const min = results[results.length - 1].score;
  const range = max - min;

  if (range === 0) {
    for (const r of results) r.score = 0.5;
    return;
  }

  for (const r of results) {
    r.score = floor + (1 - floor) * ((r.score - min) / range);
  }
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

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Format a single semantic result as an XML element.
 */
function formatSemanticXml(result: SearchResult): string {
  const meta = result.metadata as Record<string, unknown>;
  const type = (meta.type as string) || "fact";
  const confidence = Math.round(((meta.confidence as number) || 0) * 100);
  const importance = (meta.importance as number) || 0;
  const importanceLabel =
    importance >= 0.8 ? "high" : importance >= 0.5 ? "medium" : "low";
  const score = Math.round(result.score * 100);

  const lines: string[] = [];
  lines.push(
    `  <semantic type="${escapeXml(type)}" confidence="${confidence}%" importance="${escapeXml(importanceLabel)}" relevance="${score}%">`,
  );
  lines.push(`    ${escapeXml(result.content)}`);
  lines.push("  </semantic>");
  return lines.join("\n");
}

/**
 * Format a single graph result as an XML element.
 */
function formatGraphXml(result: SearchResult): string {
  const meta = result.metadata as Record<string, unknown>;
  const entityName = (meta.entityName as string) || "";
  const entityType = (meta.entityType as string) || "";
  const score = Math.round(result.score * 100);

  const lines: string[] = [];
  lines.push(
    `  <graph entity="${escapeXml(entityName)}" type="${escapeXml(entityType)}" relevance="${score}%">`,
  );
  lines.push(`    ${escapeXml(result.content)}`);
  lines.push("  </graph>");
  return lines.join("\n");
}

/**
 * Format recall results as XML, supporting episodic, semantic, and graph sources.
 */
export function formatRecallXml(response: RecallResponse): string {
  const lines: string[] = [];
  lines.push(
    `<engram_memory query="${escapeXml(response.query)}" tokens_used="${response.tokensUsed}" total_results="${response.totalResults}">`,
  );

  for (const result of response.results) {
    if (result.source === "semantic") {
      lines.push(formatSemanticXml(result));
    } else if (result.source === "graph") {
      lines.push(formatGraphXml(result));
    } else {
      // Episodic format
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

// ─── Multi-Source Search ────────────────────────────────────────

/** Semantic boost factor — semantic results have higher signal density */
const SEMANTIC_BOOST = 1.2;

/**
 * Search across multiple memory sources (episodic + semantic + graph) with
 * cross-source RRF fusion.
 *
 * Pipeline:
 * 1. Determine which sources to query (default: episodic + semantic)
 * 2. Run episodic, semantic, and graph search in parallel
 * 3. Apply semantic boost (1.2x) before cross-source RRF
 * 4. Fuse episodic + semantic with RRF, append graph results
 * 5. Normalize combined results
 * 6. Apply token budget: semantic first, then graph, then episodic
 * 7. Return RecallResponse
 */
export async function searchMultiSource(
  db: Database.Database,
  options: SearchOptions,
): Promise<RecallResponse> {
  const {
    query,
    sources = ["episodic", "semantic"] as SearchSource[],
    budget = 1500,
    limit = 10,
  } = options;

  const includeEpisodic = sources.includes("episodic");
  const includeSemantic = sources.includes("semantic");
  const includeGraph = sources.includes("graph");

  // 1-2. Run searches in parallel
  const [episodicResponse, semanticResults, graphResults] = await Promise.all([
    includeEpisodic
      ? searchEpisodic(db, options)
      : Promise.resolve({ results: [], tokensUsed: 0, totalResults: 0, query }),
    includeSemantic
      ? searchSemantic(db, options)
      : Promise.resolve([] as SearchResult[]),
    includeGraph
      ? searchGraph(db, options)
      : Promise.resolve([] as SearchResult[]),
  ]);

  // Short-circuit: single source only
  const activeSources = [includeEpisodic, includeSemantic, includeGraph].filter(Boolean).length;

  if (activeSources === 1) {
    if (includeEpisodic) return episodicResponse;

    const singleResults = includeSemantic ? semanticResults : graphResults;
    const budgeted = budgetResults(singleResults, budget);
    const tokensUsed = budgeted.reduce((sum, r) => sum + r.tokenEstimate, 0);
    return {
      results: budgeted,
      tokensUsed,
      totalResults: singleResults.length,
      query,
    };
  }

  // 3. Build ranked lists for cross-source RRF
  //    Apply semantic boost before ranking
  const episodicRanked: RankedItem[] = episodicResponse.results.map(
    (r, idx) => ({ id: r.id, rank: idx + 1 }),
  );

  // Boost semantic scores by SEMANTIC_BOOST then rank
  const boostedSemantic = semanticResults.map((r) => ({
    ...r,
    score: r.score * SEMANTIC_BOOST,
  }));
  boostedSemantic.sort((a, b) => b.score - a.score);

  const semanticRanked: RankedItem[] = boostedSemantic.map((r, idx) => ({
    id: r.id,
    rank: idx + 1,
  }));

  // 4. Cross-source RRF fusion (episodic + semantic)
  const fused = rrfFuse(episodicRanked, semanticRanked);

  // 5. Normalize
  normalizeMinMaxFloored(fused);

  // Build lookup maps for result data
  const episodicMap = new Map(
    episodicResponse.results.map((r) => [r.id, r]),
  );
  const semanticMap = new Map(semanticResults.map((r) => [r.id, r]));

  // Assemble episodic+semantic results in RRF order
  const allResults: SearchResult[] = [];
  for (const item of fused.slice(0, limit * 2)) {
    const semanticResult = semanticMap.get(item.id);
    const episodicResult = episodicMap.get(item.id);

    if (semanticResult) {
      allResults.push({ ...semanticResult, score: item.score });
    } else if (episodicResult) {
      allResults.push({ ...episodicResult, score: item.score });
    }
  }

  // Append graph results (already scored by their own search)
  for (const gResult of graphResults) {
    allResults.push(gResult);
  }

  const totalResults = allResults.length;

  // 6. Apply token budget: semantic first, then graph (compact), then episodic
  const semanticFirst = allResults.filter((r) => r.source === "semantic");
  const graphSecond = allResults.filter((r) => r.source === "graph");
  const episodicThird = allResults.filter((r) => r.source === "episodic");
  const prioritized = [...semanticFirst, ...graphSecond, ...episodicThird];

  const budgeted = budgetResults(prioritized, budget);
  const tokensUsed = budgeted.reduce((sum, r) => sum + r.tokenEstimate, 0);

  return {
    results: budgeted,
    tokensUsed,
    totalResults,
    query,
  };
}
