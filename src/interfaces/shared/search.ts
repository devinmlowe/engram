/**
 * Shared unified search operation — wraps searchMultiSource for interface layer.
 *
 * Both CLI and MCP use this function, fixing the CLI episodic-only search bug.
 *
 * Phase 3, Task 3.3 implementation.
 */

import type Database from "better-sqlite3";
import type {
  SearchSource,
  RecallResponse,
  EngramConfig,
} from "../../_core/types/index.js";
import {
  searchMultiSource,
  formatRecallXml,
} from "../../_core/search/index.js";

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
    },
    config,
  );
}

// Re-export formatRecallXml for convenience
export { formatRecallXml };
