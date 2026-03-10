// ─── Core Graph Types ────────────────────────────────────────────

export type EntityType =
  | "project"
  | "tool"
  | "technology"
  | "person"
  | "concept"
  | "file"
  | "repo"
  | "function"
  | "class"
  | "module";

export type RelationshipType =
  | "uses"
  | "depends_on"
  | "related_to"
  | "part_of"
  | "configured_by"
  | "solved_by"
  | "contains";

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  description?: string;
  aliases: string[];
  firstSeen: number;
  lastSeen: number;
  mentionCount: number;
  createdAt: number;
}

export interface Relationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: RelationshipType;
  weight: number;
  context?: string;
  sourceMemories: string[];
  createdAt: number;
  updatedAt?: number;
}

export interface TopicCluster {
  id: string;
  name: string;
  description?: string;
  entityIds: string[];
  memoryIds: string[];
  coherenceScore: number;
  createdAt: number;
  updatedAt?: number;
  generation: number;
}

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

// ─── Community Naming ──────────────────────────────────────────

export interface CommunityNaming {
  communityId: number;
  name: string;
  description: string;
  topicKeywords: string[];
}

// ─── Bridge Scores ─────────────────────────────────────────────

export interface BridgeScore {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  betweenness: number;
  communitySpan: number;
  bridgeScore: number;
  narrative?: string;
  generation: number;
}

// ─── Temporal Patterns ─────────────────────────────────────────

export type TemporalPatternType =
  | "entity_burst"
  | "community_shift"
  | "phase_transition"
  | "topic_emergence"
  | "topic_decay"
  | "bridge_formation";

export interface TemporalPattern {
  id: string;
  type: TemporalPatternType;
  description: string;
  entityIds: string[];
  timeStart: number;
  timeEnd: number;
  confidence: number;
  metadata: Record<string, unknown>;
  generation: number;
}

// ─── Reflection Observations ───────────────────────────────────

export type ObservationType =
  | "community_summary"
  | "bridge_narrative"
  | "temporal_insight"
  | "growth_observation"
  | "quality_assessment";

export interface ReflectionObservation {
  id: string;
  type: ObservationType;
  content: string;
  relatedEntityIds: string[];
  confidence: number;
  generation: number;
}

// ─── Reflect Result (MCP tool output) ──────────────────────────

export interface ReflectResult {
  communities: Array<{
    name: string;
    description: string;
    entityCount: number;
    coherenceScore: number;
    topEntities: Array<{ name: string; type: EntityType }>;
    memoryCount: number;
  }>;
  bridges: Array<{
    entityName: string;
    entityType: EntityType;
    bridgeScore: number;
    communitySpan: number;
    narrative?: string;
    connectedCommunities: string[];
  }>;
  temporalPatterns: TemporalPattern[];
  health: {
    totalNodes: number;
    totalEdges: number;
    modularity: number;
    communityCount: number;
    orphanNodes: number;
    averageCoherence: number;
    generationCount: number;
  };
  observations: ReflectionObservation[];
  generation: number;
  generatedAt: number;
}

// ─── Explore Query ──────────────────────────────────────────────

export interface ExploreOptions {
  entity: string; // starting entity name or ID
  depth?: number; // hops (default 1, max 3)
  relationshipTypes?: RelationshipType[];
  includeMemories?: boolean;
  limit?: number; // max neighbors to return (default 25, max 50)
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
