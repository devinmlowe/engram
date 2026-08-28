/**
 * Cross-domain types for the Engram cognitive memory system.
 *
 * These types are shared across multiple domains and live in _core.
 * Domain-specific types live in their respective domain directories.
 */

// ─── Semantic Layer (shared) ────────────────────────────────────
// MemoryType lives here because SearchOptions references it.

export type MemoryType =
  | "preference"
  | "decision"
  | "pattern"
  | "fact"
  | "solution"
  | "convention";

export type MemorySource = "user" | "dream" | "rlm" | "import";

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
  /** Restrict semantic results to these tenant scopes; omit for all (ADR-010). */
  scopes?: string[];
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
    chunkingStrategy: "fixed" | "adaptive"; // default: 'fixed'
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
