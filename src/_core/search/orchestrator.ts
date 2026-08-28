/**
 * Multi-source search orchestrator.
 *
 * Coordinates search across episodic, semantic, and graph memory sources
 * with cross-source RRF fusion and optional cross-encoder reranking.
 *
 * Extracted from episodic/search.ts during Phase 1 core extraction.
 */

import type Database from "better-sqlite3";
import type {
  SearchOptions,
  SearchResult,
  RecallResponse,
  SearchSource,
  EngramConfig,
} from "../types/index.js";
import { rrfFuse, normalizeMinMaxFloored, type RankedItem } from "./rrf.js";
import { allocateBudget } from "./budget.js";
import { rerankResults, isRerankerAvailable } from "./reranker.js";

// TODO: Phase 2+ — These cross-domain imports should be replaced with a
// callback/registry pattern so the orchestrator doesn't depend on domain modules.
import { searchEpisodic } from "../../episodic/search.js";
import { searchSemantic } from "../../semantic/search.js";
import { searchGraph } from "../../graph/search.js";

// ─── Constants ───────────────────────────────────────────────────

/** Semantic boost factor — semantic results have higher signal density */
const SEMANTIC_BOOST = 1.2;

// ─── Token Budgeting (deprecated wrapper) ────────────────────────

/**
 * Greedily fill results within a token budget.
 * @deprecated Use allocateBudget() from _core/search/budget.ts for priority-aware budgeting.
 */
export function budgetResults(
  results: SearchResult[],
  budget: number,
): SearchResult[] {
  return allocateBudget(results, budget);
}

// ─── Multi-Source Search ─────────────────────────────────────────

/**
 * Search across multiple memory sources (episodic + semantic + graph) with
 * cross-source RRF fusion and optional cross-encoder reranking.
 *
 * Pipeline:
 * 1. Determine which sources to query (default: episodic + semantic)
 * 2. Run episodic, semantic, and graph search in parallel
 * 3. Apply semantic boost (1.2x) before cross-source RRF
 * 4. Fuse episodic + semantic with RRF, append graph results
 * 5. Normalize combined results
 * 5b. If reranking enabled: rerank top 20 with cross-encoder → return top K
 * 6. Apply token budget: semantic first, then graph, then episodic
 * 7. Return RecallResponse
 */
export async function searchMultiSource(
  db: Database.Database,
  options: SearchOptions,
  config?: EngramConfig,
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

  // 5b. Cross-encoder reranking (if enabled)
  const rerankerConfig = config?.search?.reranker;
  if (rerankerConfig?.enabled) {
    try {
      // Take top 20 for reranking (optimal candidate window per research)
      const rerankerCandidates = allResults.slice(0, 20);
      const reranked = await rerankResults(query, rerankerCandidates, {
        topK: rerankerConfig.topK,
        blendWeight: rerankerConfig.blendWeight,
        model: rerankerConfig.model,
      });

      // Only trust the reranked window when the model actually ran: on a
      // load failure rerankResults degrades to candidates.slice(0, topK),
      // and treating that as a rerank would silently drop results 6-20
      if (reranked.length > 0 && isRerankerAvailable()) {
        const rerankedIds = new Set(reranked.map((r) => r.id));
        const remaining = allResults.slice(20).filter((r) => !rerankedIds.has(r.id));
        const budgeted = budgetResults([...reranked, ...remaining], budget);
        const tokensUsed = budgeted.reduce((sum, r) => sum + r.tokenEstimate, 0);
        return {
          results: budgeted,
          tokensUsed,
          totalResults,
          query,
        };
      }
    } catch {
      // Graceful degradation: continue with original ranking
    }
  }

  // 6. Apply token budget with priority-aware allocation
  //    allocateBudget() handles priority ordering: semantic 1.3x > graph 1.1x > episodic 1.0x
  const budgeted = allocateBudget(allResults, budget);
  const tokensUsed = budgeted.reduce((sum, r) => sum + r.tokenEstimate, 0);

  return {
    results: budgeted,
    tokensUsed,
    totalResults,
    query,
  };
}
