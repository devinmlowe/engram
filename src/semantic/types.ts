/**
 * Phase 3 semantic layer types.
 *
 * Defines the data structures for fact extraction, deduplication,
 * conflict resolution, memory health tracking, and FSRS-inspired
 * decay model constants.
 */

import type { MemoryType } from "../core/types.js";

// ─── Extraction ─────────────────────────────────────────────────

export interface ExtractedFact {
  type: MemoryType;
  content: string;
  context?: string;
  importance: number; // 0-1, LLM-judged
  sourceExchangeIds: string[];
}

export interface ExtractionResult {
  conversationId: string;
  facts: ExtractedFact[];
  model: string;
  tier: "local" | "openrouter" | "haiku" | "sonnet";
  confidence: number; // model self-reported confidence 1-10
  durationMs: number;
}

export interface ExtractionConfig {
  tier: "local" | "openrouter" | "haiku" | "sonnet" | "auto";
  reflexionEnabled: boolean;
  chunkSize: number;
  chunkOverlap: number;
  maxTurns: number;
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
