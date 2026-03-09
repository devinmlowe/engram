/**
 * Shared reflect operation — wraps graph reflection for interface layer.
 *
 * Thin wrapper providing a consistent interface for both CLI and MCP.
 *
 * Phase 3, Task 3.4 implementation.
 */

import type Database from "better-sqlite3";
import type { EngramConfig } from "../../_core/types/index.js";
import type { ReflectResult } from "../../graph/types.js";

// ─── Types ──────────────────────────────────────────────────────

export interface ReflectParams {
  mode?: "communities" | "bridges" | "temporal" | "health" | "all";
  refresh?: boolean;
}

// ─── Core Operation ─────────────────────────────────────────────

/**
 * Get knowledge graph reflection data.
 *
 * If refresh is true, runs a fresh analysis (requires config).
 * Otherwise returns cached reflection data.
 *
 * Returns null if no reflection data is available.
 */
export async function reflect(
  db: Database.Database,
  params: ReflectParams,
  config?: EngramConfig,
): Promise<ReflectResult | null> {
  if (params.refresh) {
    const { runReflection } = await import("../../graph/reflection.js");
    if (!config) {
      throw new Error("Config required for fresh reflection analysis");
    }
    return runReflection(db, config);
  }

  const { buildReflectResultFromCache } = await import("../../graph/reflection.js");
  return buildReflectResultFromCache(db);
}

export type { ReflectResult };
