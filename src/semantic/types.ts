/**
 * Semantic layer types.
 *
 * Defines the data structures for memories, conflicts, fact extraction,
 * deduplication, conflict resolution, memory health tracking, and
 * FSRS-inspired decay model constants.
 */

import type { MemoryType, MemorySource } from "../_core/types/index.js";

// Re-export MemoryType and MemorySource so semantic consumers can import from here
export type { MemoryType, MemorySource } from "../_core/types/index.js";

// ─── Core Semantic Types ────────────────────────────────────────

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  context?: string;
  confidence: number;
  importance: number;
  accessCount: number;
  lastAccessed?: number;
  createdAt: number;
  updatedAt?: number;
  sourceExchanges: string[];
  supersededBy?: string;
  isActive: boolean;
  source?: MemorySource;
  /** Tenant scope: 'global' (default) or 'hermes:<profile>' (ADR-010). */
  scope?: string;
}

export interface Conflict {
  id: string;
  memoryId: string;
  conflictingMemoryId: string;
  description: string;
  resolution?: string;
  resolvedAt?: number;
  createdAt: number;
}

// ─── Extraction ─────────────────────────────────────────────────

export interface ExtractedFact {
  type: MemoryType;
  content: string;
  context?: string;
  importance: number; // 0-1, LLM-judged
  sourceExchangeIds: string[];
  extractionBasis?: "explicit" | "inferred" | "observed";
}

/** Chunk boundary metadata for diagnostics (Phase 7C.2). */
export interface ChunkBoundaryInfo {
  start: number;
  end: number;
  avgDensity?: number;
}

export interface ExtractionResult {
  conversationId: string;
  facts: ExtractedFact[];
  model: string;
  tier: "local" | "openrouter" | "haiku" | "sonnet";
  confidence: number; // model self-reported confidence 1-10
  durationMs: number;
  /** Chunk boundaries produced during extraction (Phase 7C.2). */
  chunkBoundaries?: ChunkBoundaryInfo[];
}

export interface ExtractionConfig {
  tier: "local" | "openrouter" | "haiku" | "sonnet" | "auto";
  reflexionEnabled: boolean;
  chunkSize: number;
  chunkOverlap: number;
  maxTurns: number;
  chunkingStrategy: "fixed" | "adaptive";
}

// ─── Deduplication & Conflict Resolution ────────────────────────

export interface DeduplicationResult {
  action: "insert" | "merge" | "conflict" | "skip";
  memoryId: string;
  mergedWithId?: string;
  conflictId?: string;
  similarity?: number;
}

export interface ConflictResolution {
  action: "update" | "keep_both" | "noop";
  reasoning: string;
  updatedContent?: string;
}

// ─── Memory Health & Decay ──────────────────────────────────────

export interface MemoryHealth {
  memoryId: string;
  retrievability: number;
  stability: number;
  confidence: number;
  pruneEligible: boolean;
}

// ─── FSRS-inspired Decay Constants ──────────────────────────────

/** Initial stability by memory type (days until retrievability drops to 0.9) */
export const INITIAL_STABILITY: Record<MemoryType, number> = {
  preference: 90,
  decision: 60,
  fact: 30,
  pattern: 120,
  solution: 45,
  convention: 75,
};

/** Growth rate for stability on successful access */
export const STABILITY_GROWTH_RATE = 0.2;

/** Stability penalty multiplier on contradiction */
export const CONTRADICTION_PENALTY = 0.8;

/** Confidence threshold below which a memory is eligible for pruning */
export const PRUNE_THRESHOLD = 0.1;
