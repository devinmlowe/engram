/**
 * Dream state types — offline processing pipeline.
 */

export type DreamPhase =
  | "ingest"
  | "extract"
  | "consolidate"
  | "reflect"
  | "prune";

export interface DreamReport {
  startedAt: number;
  completedAt: number;
  phases: {
    phase: DreamPhase;
    itemsProcessed: number;
    errors: number;
    durationMs: number;
  }[];
  newMemories: number;
  updatedMemories: number;
  newEntities: number;
  newRelationships: number;
  conflictsDetected: number;
  memoriesPruned: number;
  // Phase 6: Reflection & Emergence metrics
  communitiesNamed?: number;
  bridgesIdentified?: number;
  temporalPatternsDetected?: number;
  observationsGenerated?: number;
  entitiesMerged?: number;
  orphansPruned?: number;
  clustersPruned?: number;
  /** Extract phase: conversations skipped because their fingerprint was unchanged (W12). */
  skippedUnchanged?: number;
  /**
   * Consolidate phase: candidate facts folded into a near-duplicate sibling
   * before insertion — across the run's batches and within each batch (W9a).
   */
  collapsedCandidates?: number;
  /** Extract phase: facts dropped because their content hash is in memory_suppressions (#55). */
  suppressedFacts?: number;
  /** Prune phase: forgotten memories hard-deleted after ENGRAM_FORGET_RETENTION_DAYS (#56). */
  forgottenPurged?: number;
  /** Prune phase: stale_since relationships / entities removed by the #57 fast path. */
  staleRelationshipsPruned?: number;
  staleEntitiesPruned?: number;
  // Commitments pass (extract phase): candidates seen, deduped, inserted
  commitmentsExtracted?: number;
  commitmentCandidates?: number;
  commitmentDuplicates?: number;
  commitmentRejected?: number;
}
