/**
 * Dream state types — offline processing pipeline.
 */

export type DreamPhase =
  | "ingest"
  | "extract"
  | "consolidate"
  | "reflect"
  | "prune";

export interface DreamProgress {
  phase: DreamPhase;
  total: number;
  processed: number;
  errors: number;
  startedAt: number;
  lastCheckpoint?: number;
}

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
}
