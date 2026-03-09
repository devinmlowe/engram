/**
 * FSRS-inspired confidence decay model for semantic memories.
 *
 * Memories decay in retrievability over time, modulated by:
 * - Type-specific initial stability (pattern > preference > fact)
 * - Access history (corroboration factor)
 * - Successful retrievals (stability growth)
 * - Contradictions (stability penalty)
 *
 * Key formulas:
 *   retrievability(t) = 0.9 ^ (days_since_access / stability)
 *   corroboration     = min(1.0, 0.5 + 0.1 * access_count)
 *   confidence        = base_confidence * corroboration * retrievability
 *   retrieval_score   = 0.55 * relevance + 0.25 * retrievability + 0.20 * importance
 */

import type { Memory } from "./types.js";
import type { MemoryHealth } from "./types.js";
import {
  INITIAL_STABILITY,
  STABILITY_GROWTH_RATE,
  CONTRADICTION_PENALTY,
  PRUNE_THRESHOLD,
} from "./types.js";

// ─── Core Decay Functions ───────────────────────────────────────

/**
 * Compute the current retrievability of a memory.
 *
 * Uses the FSRS power-law decay formula:
 *   R(t) = 0.9 ^ (days_since_last_access / stability)
 *
 * If the memory has never been accessed, days since creation is used.
 * Returns a value in [0, 1] where 1 means perfectly retrievable.
 */
export function computeRetrievability(
  memory: Memory,
  now?: number,
): number {
  const currentTime = now ?? Math.floor(Date.now() / 1000);
  const lastAccess = memory.lastAccessed ?? memory.createdAt;
  const daysSinceAccess = (currentTime - lastAccess) / 86400;

  if (daysSinceAccess <= 0) return 1.0;

  const stability = getEffectiveStability(memory);
  return Math.pow(0.9, daysSinceAccess / stability);
}

/**
 * Compute the composite confidence score for a memory.
 *
 *   confidence = base_confidence * corroboration_factor * retrievability
 *
 * Where:
 *   corroboration_factor = min(1.0, 0.5 + 0.1 * access_count)
 *
 * This models the idea that memories accessed more often are more
 * corroborated (independently confirmed), while memories that haven't
 * been accessed recently are less reliable.
 */
export function computeConfidence(
  memory: Memory,
  now?: number,
): number {
  const retrievability = computeRetrievability(memory, now);
  const corroboration = computeCorroborationFactor(memory.accessCount);
  return memory.confidence * corroboration * retrievability;
}

/**
 * Compute a unified retrieval score combining semantic relevance,
 * temporal retrievability, and importance.
 *
 *   score = 0.55 * relevance + 0.25 * retrievability + 0.20 * importance
 *
 * @param relevance - semantic similarity score [0, 1]
 * @param memory - the memory being scored
 * @param now - optional unix timestamp override
 */
export function computeRetrievalScore(
  relevance: number,
  memory: Memory,
  now?: number,
): number {
  const retrievability = computeRetrievability(memory, now);
  return 0.55 * relevance + 0.25 * retrievability + 0.20 * memory.importance;
}

// ─── State Transitions ──────────────────────────────────────────

/**
 * Compute new stability and importance after a successful access.
 *
 * The FSRS insight: harder retrievals (low R) produce more stability growth.
 *   new_stability = stability * (1 + STABILITY_GROWTH_RATE * (1 - R))
 *   new_importance = min(1.0, importance + 0.02)
 *
 * Returns the new stability and importance values (caller persists them).
 */
export function onSuccessfulAccess(
  memory: Memory,
  now?: number,
): { stability: number; importance: number } {
  const R = computeRetrievability(memory, now);
  const currentStability = getEffectiveStability(memory);
  const newStability = currentStability * (1 + STABILITY_GROWTH_RATE * (1 - R));
  const newImportance = Math.min(1.0, memory.importance + 0.02);

  return {
    stability: newStability,
    importance: newImportance,
  };
}

/**
 * Compute new stability after a contradiction is detected.
 *
 *   new_stability = stability * CONTRADICTION_PENALTY (0.8)
 *
 * This reduces the memory's perceived reliability, making it decay faster.
 */
export function onContradiction(
  memory: Memory,
): { stability: number } {
  const currentStability = getEffectiveStability(memory);
  return {
    stability: currentStability * CONTRADICTION_PENALTY,
  };
}

// ─── Pruning & Health ───────────────────────────────────────────

/**
 * Determine if a memory is eligible for pruning.
 *
 * A memory is prune-eligible when its composite confidence
 * drops below PRUNE_THRESHOLD (0.1).
 */
export function isPruneEligible(
  memory: Memory,
  now?: number,
): boolean {
  return computeConfidence(memory, now) < PRUNE_THRESHOLD;
}

/**
 * Get a comprehensive health assessment for a memory.
 */
export function getMemoryHealth(
  memory: Memory,
  now?: number,
): MemoryHealth {
  const retrievability = computeRetrievability(memory, now);
  const stability = getEffectiveStability(memory);
  const confidence = computeConfidence(memory, now);

  return {
    memoryId: memory.id,
    retrievability,
    stability,
    confidence,
    pruneEligible: confidence < PRUNE_THRESHOLD,
  };
}

// ─── Internal Helpers ───────────────────────────────────────────

/**
 * Compute the corroboration factor from access count.
 *
 *   factor = min(1.0, 0.5 + 0.1 * access_count)
 *
 * Starts at 0.5 (unconfirmed), grows by 0.1 per access, caps at 1.0.
 */
function computeCorroborationFactor(accessCount: number): number {
  return Math.min(1.0, 0.5 + 0.1 * accessCount);
}

/**
 * Get the effective stability for a memory.
 *
 * Since we don't persist stability per-memory yet, we derive it from
 * the memory type's initial stability. The confidence field serves as
 * a proxy for accumulated stability adjustments — if confidence has been
 * modified from its default (0.5), we use it as a scaling factor.
 *
 * This allows onSuccessfulAccess and onContradiction to return
 * stability values that callers can use to update the confidence
 * field proportionally, until we add a dedicated stability column.
 */
function getEffectiveStability(memory: Memory): number {
  return INITIAL_STABILITY[memory.type];
}
