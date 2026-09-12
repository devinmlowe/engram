/**
 * Shared unified search operation — wraps searchMultiSource for interface layer.
 *
 * Both CLI and MCP use this function, fixing the CLI episodic-only search bug.
 *
 * Phase 3, Task 3.3 implementation.
 * Phase 6B: Added session-based iterative recall functions.
 */

import type Database from "better-sqlite3";
import type {
  SearchSource,
  RecallResponse,
  EngramConfig,
  SearchResult,
} from "../../_core/types/index.js";
import {
  searchMultiSource,
  formatRecallXml,
  getSessionStore,
  drillIntoResult,
} from "../../_core/search/index.js";
import type { RecallSession, DrillResult, QualityMetrics } from "../../_core/search/session.js";
import { computeQualityMetrics } from "../../_core/search/session.js";

// ─── Types ──────────────────────────────────────────────────────

export interface UnifiedSearchParams {
  query: string;
  sources?: SearchSource[];
  limit?: number;
  budget?: number;
  after?: string;
  before?: string;
  mode?: "hybrid" | "vector" | "text";
  depth?: "shallow" | "deep";
  /** Restrict semantic results to these tenant scopes (ADR-010). */
  scopes?: string[];
}

export interface RecallSessionResult {
  sessionId: string;
  results: SearchResult[];
  budgetRemaining: number;
  resultCount: number;
  qualityMetrics: QualityMetrics;
}

export interface RecallDrillResult {
  drill: DrillResult;
  resultId: string;
}

// ─── Core Operation ─────────────────────────────────────────────

/**
 * Unified search across all memory sources.
 *
 * Wraps searchMultiSource() with interface-layer defaults.
 * Default sources: episodic + semantic (matching MCP behavior).
 * Default budget: 1500 tokens.
 */
export async function unifiedSearch(
  db: Database.Database,
  params: UnifiedSearchParams,
  config?: EngramConfig,
): Promise<RecallResponse> {
  return searchMultiSource(
    db,
    {
      query: params.query,
      sources: params.sources ?? ["episodic", "semantic"],
      mode: params.mode ?? "hybrid",
      limit: params.limit,
      budget: params.budget ?? 1500,
      after: params.after,
      before: params.before,
      depth: params.depth,
      scopes: params.scopes,
    },
    config,
  );
}

// ─── Session-Based Recall ───────────────────────────────────────

/**
 * Create a new recall session or refine an existing one.
 *
 * When sessionId is omitted, creates a new session and runs the initial search.
 * When sessionId is provided, refines the existing session with a new query.
 */
export async function createOrRefineRecallSession(
  db: Database.Database,
  params: {
    query: string;
    sessionId?: string;
    budget?: number;
    sources?: SearchSource[];
  },
  config?: EngramConfig,
): Promise<RecallSessionResult> {
  const store = getSessionStore();
  const sources = params.sources ?? ["episodic", "semantic"];

  if (params.sessionId) {
    // Refine existing session
    const session = store.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    const remainingBudget = store.getRemainingBudget(params.sessionId);
    if (remainingBudget <= 0) {
      return {
        sessionId: params.sessionId,
        results: [],
        budgetRemaining: 0,
        resultCount: session.results.length,
        qualityMetrics: computeQualityMetrics([]),
      };
    }

    const response = await searchMultiSource(
      db,
      {
        query: params.query,
        sources,
        mode: "hybrid",
        budget: remainingBudget,
      },
      config,
    );

    store.addResults(params.sessionId, response.results, params.query);

    return {
      sessionId: params.sessionId,
      results: response.results,
      budgetRemaining: store.getRemainingBudget(params.sessionId),
      resultCount: session.results.length,
      qualityMetrics: computeQualityMetrics(response.results),
    };
  }

  // Create new session
  const maxBudget = params.budget ?? 3000;
  const session = store.create(params.query, { maxBudget });

  const response = await searchMultiSource(
    db,
    {
      query: params.query,
      sources,
      mode: "hybrid",
      budget: Math.min(maxBudget, 1500), // First search gets half the budget
    },
    config,
  );

  store.addResults(session.id, response.results);

  return {
    sessionId: session.id,
    results: response.results,
    budgetRemaining: store.getRemainingBudget(session.id),
    resultCount: response.results.length,
    qualityMetrics: computeQualityMetrics(response.results),
  };
}

/**
 * Drill into a specific result within a recall session.
 */
export async function drillRecallResult(
  db: Database.Database,
  sessionId: string,
  resultIndex: number,
): Promise<RecallDrillResult> {
  const store = getSessionStore();
  const session = store.get(sessionId);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (resultIndex < 0 || resultIndex >= session.results.length) {
    throw new Error(
      `Result index ${resultIndex} out of range (0-${session.results.length - 1})`,
    );
  }

  const result = session.results[resultIndex];
  store.markExpanded(sessionId, result.id);

  const drill = await drillIntoResult(result, db);

  return {
    drill,
    resultId: result.id,
  };
}

// Re-export formatRecallXml for convenience
export { formatRecallXml };
