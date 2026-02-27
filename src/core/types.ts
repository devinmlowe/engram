/**
 * Core types for the Engram cognitive memory system.
 *
 * Three memory layers:
 * - Episodic: raw conversation exchanges (what happened)
 * - Semantic: extracted knowledge (what it means)
 * - Graph: entity relationships (how things connect)
 */

// ─── Episodic Layer ─────────────────────────────────────────────

export interface Exchange {
  id: string;
  conversationId: string;
  project: string;
  timestamp: string;
  userMessage: string;
  assistantMessage: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  modelVersion?: string;
  exchangeIndex: number;
  tokenEstimate: number;
  createdAt: number;
  lastAccessed?: number;
}

export interface ToolCall {
  id: string;
  exchangeId: string;
  toolName: string;
  toolInput?: string;
  toolResultSummary?: string;
  isError: boolean;
  timestamp?: string;
}

export interface Conversation {
  id: string;
  project: string;
  startedAt?: string;
  endedAt?: string;
  exchangeCount: number;
  summary?: string;
  primaryTopics?: string[];
  archivePath?: string;
  lastIndexed?: number;
}

// ─── Semantic Layer ─────────────────────────────────────────────

export type MemoryType =
  | "preference"
  | "decision"
  | "pattern"
  | "fact"
  | "solution"
  | "convention";

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

// ─── Knowledge Graph Layer ──────────────────────────────────────

export type EntityType =
  | "project"
  | "tool"
  | "technology"
  | "person"
  | "concept"
  | "file"
  | "repo";

export type RelationshipType =
  | "uses"
  | "depends_on"
  | "related_to"
  | "part_of"
  | "configured_by"
  | "solved_by";

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

// ─── Search & Retrieval ─────────────────────────────────────────

export type SearchMode = "vector" | "text" | "hybrid";
export type SearchSource = "episodic" | "semantic" | "graph";

export interface SearchOptions {
  query: string;
  sources?: SearchSource[];
  mode?: SearchMode;
  limit?: number;
  budget?: number; // max tokens in response
  after?: string; // ISO date
  before?: string; // ISO date
  types?: MemoryType[];
  depth?: "shallow" | "deep";
}

export interface SearchResult {
  id: string;
  source: SearchSource;
  score: number; // 0.0-1.0 unified relevance score
  content: string; // formatted content
  metadata: Record<string, unknown>;
  tokenEstimate: number;
}

export interface RecallResponse {
  results: SearchResult[];
  tokensUsed: number;
  totalResults: number;
  query: string;
}

// ─── Dream State ────────────────────────────────────────────────

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

// ─── Reranking ──────────────────────────────────────────────────

export interface RerankerConfig {
  enabled: boolean;
  model: string; // e.g. 'Xenova/bge-reranker-base'
  topK: number; // final number of results after reranking
  blendWeight: number; // weight for reranker score: final = blend*reranker + (1-blend)*rrf
}

// ─── Configuration ──────────────────────────────────────────────

export interface EngramConfig {
  dataDir: string; // ~/.local/share/engram
  dbPath: string; // {dataDir}/engram.db
  archiveDir: string; // {dataDir}/archive
  logsDir: string; // {dataDir}/logs
  claudeProjectsDir: string; // ~/.claude/projects

  embedding: {
    model: string; // nomic-embed-text-v1.5
    dimensions: number; // 256 (MRL truncation)
    maxTokens: number; // 8192
  };

  search: {
    defaultLimit: number; // 10
    defaultBudget: number; // 1500 tokens
    rrfK: number; // 60 (RRF fusion constant)
    rerankEnabled: boolean;
    reranker: RerankerConfig;
  };

  dream: {
    localModel?: string; // MLX model path
    openrouterModel?: string; // OpenRouter model ID (e.g. google/gemini-2.5-flash-lite)
    apiModel: string; // claude haiku
    apiFallbackModel: string; // claude sonnet
    concurrency: number; // parallel work items
    scheduleHour: number; // 2 (2 AM)
  };

  decay: {
    preference: number; // 0.01
    decision: number; // 0.02
    fact: number; // 0.05
    pattern: number; // 0.005
    solution: number; // 0.03
    convention: number; // 0.015
  };
}
