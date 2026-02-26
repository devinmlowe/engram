import type { EntityType, RelationshipType } from "../core/types.js";

// ─── Extraction ──────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  description?: string;
}

export interface ExtractedRelationship {
  sourceEntityIndex: number; // index into the extracted entities array
  targetEntityIndex: number;
  type: RelationshipType;
  context?: string; // natural language description of the relationship
}

export interface EntityExtractionResult {
  entities: ExtractedEntity[];
  model: string;
  tier: "haiku" | "sonnet";
  durationMs: number;
}

export interface RelationshipExtractionResult {
  relationships: ExtractedRelationship[];
  model: string;
  tier: "haiku" | "sonnet";
  durationMs: number;
}

// ─── Entity Resolution ──────────────────────────────────────────

export type ResolutionStage =
  | "exact_name"
  | "alias"
  | "embedding"
  | "llm"
  | "created";

export interface EntityResolution {
  action: "merge" | "create";
  entityId: string;
  stage: ResolutionStage;
  similarity?: number;
  mergedAliases?: string[];
}

// ─── Graph Analysis ─────────────────────────────────────────────

export interface CommunityResult {
  communityId: number;
  entityIds: string[];
  coherenceScore: number;
}

export interface GraphAnalysisResult {
  communities: CommunityResult[];
  modularity: number;
  bridgeEntities: Array<{
    entityId: string;
    betweenness: number;
    communitySpan: number;
    bridgeScore: number;
  }>;
  totalNodes: number;
  totalEdges: number;
  durationMs: number;
}

// ─── Edge Weight ────────────────────────────────────────────────

export interface EdgeWeightFactors {
  mentionCount: number;
  lastSeen: number;
  confidence: number;
  sourceImportance: number;
  targetImportance: number;
}

// ─── Explore Query ──────────────────────────────────────────────

export interface ExploreOptions {
  entity: string; // starting entity name or ID
  depth?: number; // hops (default 1, max 3)
  relationshipTypes?: RelationshipType[];
  includeMemories?: boolean;
}

export interface ExploreResult {
  centerEntity: {
    id: string;
    name: string;
    type: EntityType;
    description?: string;
    mentionCount: number;
  };
  neighbors: Array<{
    entity: {
      id: string;
      name: string;
      type: EntityType;
      description?: string;
    };
    relationship: {
      type: RelationshipType;
      weight: number;
      context?: string;
      direction: "outgoing" | "incoming";
    };
    depth: number;
  }>;
  community?: {
    name: string;
    description?: string;
    entityCount: number;
  };
}
