/**
 * In-memory session store for iterative recall.
 *
 * Provides stateful search sessions with LRU eviction and TTL expiry,
 * enabling multi-step memory exploration (the core RLM pattern).
 *
 * Phase 6B implementation.
 */

import type { SearchResult } from "../types/index.js";
import { LRUCache } from "../cache/index.js";

// ─── Quality Metrics ─────────────────────────────────────────────

export interface QualityMetrics {
  averageScore: number;
  scoreSpread: number;
  topResultStrength: number;
  recommendAction: "drill" | "refine" | "done";
}

export function computeQualityMetrics(results: SearchResult[]): QualityMetrics {
  if (results.length === 0) {
    return { averageScore: 0, scoreSpread: 0, topResultStrength: 0, recommendAction: "done" };
  }

  const scores = results.map(r => r.score);
  const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const topResultStrength = Math.max(...scores);
  const scoreSpread = Math.max(...scores) - Math.min(...scores);

  let recommendAction: "drill" | "refine" | "done";
  if (topResultStrength >= 0.7 && scoreSpread < 0.3) {
    recommendAction = "drill";
  } else {
    recommendAction = "refine";
  }

  return { averageScore, scoreSpread, topResultStrength, recommendAction };
}

// ─── Types ──────────────────────────────────────────────────────

export interface RecallSession {
  id: string;
  createdAt: Date;
  query: string;
  refinements: string[];
  results: SearchResult[];
  expandedIds: Set<string>;
  totalBudgetUsed: number;
  maxBudget: number;
}

export interface DrillResult {
  content: string;
  before: string[];
  after: string[];
  relatedEntities: EntitySummary[];
  suggestions: string[];
}

export interface EntitySummary {
  name: string;
  type: string;
  description?: string;
}

// ─── Session Store ──────────────────────────────────────────────

/** At most 10 live sessions; each expires 30 minutes after its last access. */
export class SessionStore {
  private sessions = new LRUCache<string, RecallSession>({ maxSize: 10, ttlMs: 30 * 60 * 1000 });

  /**
   * Create a new recall session.
   */
  create(query: string, options?: { maxBudget?: number }): RecallSession {
    const session: RecallSession = {
      id: crypto.randomUUID(),
      createdAt: new Date(),
      query,
      refinements: [],
      results: [],
      expandedIds: new Set(),
      totalBudgetUsed: 0,
      maxBudget: options?.maxBudget ?? 3000,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Get a session by ID, returning null if not found or expired.
   * Every hit restarts the session's TTL.
   */
  get(sessionId: string): RecallSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this.sessions.set(sessionId, session); // re-set to refresh the TTL, not just the LRU position
    return session;
  }

  /**
   * Add results to a session and track budget usage.
   */
  addResults(sessionId: string, results: SearchResult[], refinement?: string): void {
    const session = this.get(sessionId);
    if (!session) return;

    if (refinement) {
      session.refinements.push(refinement);
    }

    session.results.push(...results);
    session.totalBudgetUsed += results.reduce((sum, r) => sum + r.tokenEstimate, 0);
  }

  /**
   * Mark a result as expanded (drilled into).
   */
  markExpanded(sessionId: string, resultId: string): void {
    this.get(sessionId)?.expandedIds.add(resultId);
  }

  /**
   * Get remaining budget for a session.
   */
  getRemainingBudget(sessionId: string): number {
    const session = this.get(sessionId);
    if (!session) return 0;
    return Math.max(0, session.maxBudget - session.totalBudgetUsed);
  }

  /**
   * Close and remove a session.
   */
  close(sessionId: string): void {
    this.sessions.invalidate(sessionId);
  }

  /**
   * Get current session count (for testing).
   */
  get size(): number {
    return this.sessions.size;
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let defaultStore: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!defaultStore) {
    defaultStore = new SessionStore();
  }
  return defaultStore;
}

/** Reset the singleton (for testing). */
export function resetSessionStore(): void {
  defaultStore = null;
}
