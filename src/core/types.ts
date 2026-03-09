/**
 * Re-export stub — will be removed in Task 1.7.
 *
 * All types have been split into their domain modules.
 * This file re-exports everything for backward compatibility.
 */

// Cross-domain types
export type {
  MemoryType,
  SearchMode,
  SearchSource,
  SearchOptions,
  SearchResult,
  RecallResponse,
  RerankerConfig,
  EngramConfig,
} from "../_core/types/index.js";

// Episodic types
export type {
  Exchange,
  ToolCall,
  Conversation,
} from "../episodic/types.js";

// Semantic types
export type {
  Memory,
  Conflict,
} from "../semantic/types.js";

// Dream types
export type {
  DreamPhase,
  DreamProgress,
  DreamReport,
} from "../dream/types.js";

// Graph types
export type {
  EntityType,
  Entity,
  RelationshipType,
  Relationship,
  TopicCluster,
} from "../graph/types.js";
