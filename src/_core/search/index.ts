/**
 * _core/search barrel — re-exports all shared search utilities.
 */

// RRF fusion and score normalization
export { rrfFuse, normalizeMinMaxFloored, type RankedItem } from "./rrf.js";

// XML formatting
export {
  escapeXml,
  formatRecallXml,
  formatSemanticXml,
  formatGraphXml,
} from "./format.js";

// Token budget allocation
export {
  allocateBudget,
  estimateTokens,
  type BudgetOptions,
} from "./budget.js";

// Cross-encoder reranking
export {
  rerankResults,
  initReranker,
  isRerankerAvailable,
  normalizeScores,
  blendScores,
  resetReranker,
} from "./reranker.js";

// Multi-source orchestration
export { searchMultiSource, budgetResults } from "./orchestrator.js";

// Text chunking
export { chunkConversation } from "./text.js";

// Session store for iterative recall
export {
  SessionStore,
  getSessionStore,
  resetSessionStore,
  type RecallSession,
  type DrillResult,
  type EntitySummary,
} from "./session.js";

// Drill into results
export { drillIntoResult } from "./drill.js";
