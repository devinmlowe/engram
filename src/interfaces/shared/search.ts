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
  DateBasis,
  Anniversary,
} from "../../_core/types/index.js";
import { resolveDateFilter } from "../../_core/search/dates.js";
import {
  searchMultiSource,
  formatRecallXml,
  getSessionStore,
  drillIntoResult,
} from "../../_core/search/index.js";
import type { RecallSession, DrillResult, QualityMetrics } from "../../_core/search/session.js";
import { computeQualityMetrics } from "../../_core/search/session.js";
import { recordAccess } from "../../semantic/memory.js";

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
  /**
   * Natural-language date window ("last week", "in March", "this day last
   * year", "on this day"). Explicit after/before win over the hint; the
   * applied filter is echoed back in RecallResponse.dateFilter.
   */
  dateHint?: string;
  /** "filed" (default) = when recorded; "event" = when the events happened. */
  dateBasis?: DateBasis;
  /** Explicit anniversary (month/day across all years); usually set via dateHint. */
  anniversary?: Anniversary;
  /** Reference "now" for hint parsing — injectable for deterministic tests. */
  now?: Date;
  /**
   * Reinforce the semantic memories this call RETURNS (FSRS growth via
   * recordAccess). Default true; pass false for read-only/diagnostic callers
   * (visualizer, tests) that must not mutate access stats.
   */
  reinforce?: boolean;
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

// ─── Retrieval Reinforcement (W8) ───────────────────────────────

/**
 * Reinforce the semantic memories a recall actually returned.
 *
 * FSRS: a successful retrieval grows stability (decay.ts onSuccessfulAccess)
 * and bumps access_count / last_accessed. Only `semantic` results map to the
 * memories table; episodic exchanges and graph entities are skipped. Each id
 * is reinforced at most once per call, all in ONE immediate transaction so
 * a multi-process WAL writer (dream daemon) cannot interleave.
 *
 * Failure-tolerant by contract: a reinforcement error is logged and swallowed
 * — it must never fail the recall that produced the results.
 */
export function reinforceRecalledMemories(
  db: Database.Database,
  results: readonly SearchResult[],
): void {
  const ids = new Set<string>();
  for (const r of results) {
    if (r.source === "semantic") ids.add(r.id);
  }
  if (ids.size === 0) return;

  try {
    db.transaction(() => {
      for (const id of ids) recordAccess(db, id);
    }).immediate();
  } catch (error) {
    console.error(
      `[engram] recall reinforcement failed for ${ids.size} memories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
  // Resolve the temporal scope once here so MCP, CLI and HTTP agree:
  // explicit after/before override the hint, and whatever was applied is
  // reported back on the response (transparency beats magic).
  const dateFilter = resolveDateFilter(
    {
      after: params.after,
      before: params.before,
      dateHint: params.dateHint,
      dateBasis: params.dateBasis,
      anniversary: params.anniversary,
    },
    params.now ?? new Date(),
  );

  const response = await searchMultiSource(
    db,
    {
      query: params.query,
      sources: params.sources ?? ["episodic", "semantic"],
      mode: params.mode ?? "hybrid",
      limit: params.limit,
      budget: params.budget ?? 1500,
      after: dateFilter?.after,
      before: dateFilter?.before,
      anniversary: dateFilter?.anniversary,
      dateBasis: dateFilter?.basis,
      depth: params.depth,
      scopes: params.scopes,
    },
    config,
  );

  if (dateFilter) response.dateFilter = dateFilter;
  if (params.reinforce !== false) reinforceRecalledMemories(db, response.results);
  return response;
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
    /** Restrict semantic results to these tenant scopes (ADR-010). */
    scopes?: string[];
    /** Reinforce returned semantic memories (default true). */
    reinforce?: boolean;
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
        scopes: params.scopes,
      },
      config,
    );

    store.addResults(params.sessionId, response.results, params.query);
    if (params.reinforce !== false) reinforceRecalledMemories(db, response.results);

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
      scopes: params.scopes,
    },
    config,
  );

  store.addResults(session.id, response.results);
  if (params.reinforce !== false) reinforceRecalledMemories(db, response.results);

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
  options: { reinforce?: boolean } = {},
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
  // Drilling is a deliberate, successful retrieval of this one result.
  if (options.reinforce !== false) reinforceRecalledMemories(db, [result]);

  return {
    drill,
    resultId: result.id,
  };
}

// Re-export formatRecallXml for convenience
export { formatRecallXml };
