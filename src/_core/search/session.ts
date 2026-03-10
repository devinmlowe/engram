/**
 * In-memory session store for iterative recall.
 *
 * Provides stateful search sessions with LRU eviction and TTL expiry,
 * enabling multi-step memory exploration (the core RLM pattern).
 *
 * Phase 6B implementation.
 */

import type { SearchResult } from "../types/index.js";

// ─── Types ──────────────────────────────────────────────────────

export interface RecallSession {
  id: string;
  createdAt: Date;
  lastAccessedAt: Date;
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

// ─── Constants ──────────────────────────────────────────────────

const MAX_SESSIONS = 10;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Session Store ──────────────────────────────────────────────

export class SessionStore {
  private sessions = new Map<string, RecallSession>();

  /**
   * Create a new recall session.
   */
  create(query: string, options?: { maxBudget?: number }): RecallSession {
    this.evictExpired();

    // Evict oldest (LRU) if at capacity
    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictLRU();
    }

    const id = crypto.randomUUID();
    const now = new Date();
    const session: RecallSession = {
      id,
      createdAt: now,
      lastAccessedAt: now,
      query,
      refinements: [],
      results: [],
      expandedIds: new Set(),
      totalBudgetUsed: 0,
      maxBudget: options?.maxBudget ?? 3000,
    };

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Get a session by ID, returning null if not found or expired.
   */
  get(sessionId: string): RecallSession | null {
    this.evictExpired();
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.lastAccessedAt = new Date();
    return session;
  }

  /**
   * Add results to a session and track budget usage.
   */
  addResults(sessionId: string, results: SearchResult[], refinement?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (refinement) {
      session.refinements.push(refinement);
    }

    session.results.push(...results);
    const tokensUsed = results.reduce((sum, r) => sum + r.tokenEstimate, 0);
    session.totalBudgetUsed += tokensUsed;
    session.lastAccessedAt = new Date();
  }

  /**
   * Mark a result as expanded (drilled into).
   */
  markExpanded(sessionId: string, resultId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.expandedIds.add(resultId);
    session.lastAccessedAt = new Date();
  }

  /**
   * Get remaining budget for a session.
   */
  getRemainingBudget(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    return Math.max(0, session.maxBudget - session.totalBudgetUsed);
  }

  /**
   * Close and remove a session.
   */
  close(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Get current session count (for testing).
   */
  get size(): number {
    return this.sessions.size;
  }

  // ─── Internal ───────────────────────────────────────────────

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastAccessedAt.getTime() > TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }

  private evictLRU(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, session] of this.sessions) {
      const accessTime = session.lastAccessedAt.getTime();
      if (accessTime < oldestTime) {
        oldestTime = accessTime;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.sessions.delete(oldestId);
    }
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
