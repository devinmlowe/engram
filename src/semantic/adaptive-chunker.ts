/**
 * Adaptive conversation chunking based on information density.
 *
 * Creates variable-sized chunks: smaller for dense regions (tool calls,
 * code blocks, decisions), larger for sparse regions (short exchanges).
 * This improves fact extraction from dense conversation segments.
 *
 * Phase 6A implementation.
 */

import type { ConversationExchange } from "./extractor.js";

// ─── Types ──────────────────────────────────────────────────────

export interface DensityScore {
  index: number;
  score: number;         // 0-1 normalized density
  charCount: number;
  toolCallCount: number;
  codeBlockCount: number;
}

export interface ChunkBoundary {
  start: number;
  end: number;
  avgDensity: number;
}

export interface AdaptiveChunkOptions {
  minChunkSize?: number;     // default: 10
  maxChunkSize?: number;     // default: 40
  densityThreshold?: number; // default: 0.6 — above = dense
  overlap?: number;          // default: 3
}

// ─── Density Scoring ────────────────────────────────────────────

// Weight constants for density scoring
const WEIGHT_CHAR_COUNT = 0.3;
const WEIGHT_TOOL_CALLS = 0.4;
const WEIGHT_CODE_BLOCKS = 0.2;
const WEIGHT_DECISION = 0.1;

/** Decision-language markers */
const DECISION_PATTERNS = [
  /\bdecid/i,
  /\bdecision\b/i,
  /\bchose\b/i,
  /\bchoose\b/i,
  /\bgo with\b/i,
  /\bopt for\b/i,
  /\bprefer\b/i,
  /\brecommend\b/i,
  /\bshould use\b/i,
  /\blet's use\b/i,
  /\bwe'll use\b/i,
  /\bswitch to\b/i,
];

/** Count tool call references in text. */
function countToolCalls(text: string): number {
  // Match patterns like "Tool call:", "tool_use", function-call style patterns
  const patterns = [
    /tool.?call/gi,
    /tool_use/gi,
    /execute_command/gi,
    /read_file/gi,
    /write_file/gi,
    /search_files/gi,
  ];
  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

/** Count fenced code blocks in text. */
function countCodeBlocks(text: string): number {
  const matches = text.match(/```/g);
  if (!matches) return 0;
  // Each code block has opening and closing ```, so divide by 2
  return Math.floor(matches.length / 2);
}

/** Check if text contains decision-language markers. */
function hasDecisionLanguage(text: string): boolean {
  return DECISION_PATTERNS.some((p) => p.test(text));
}

/**
 * Score each exchange by information density.
 *
 * Computes raw scores based on character count, tool calls, code blocks,
 * and decision language, then normalizes to [0, 1] within the conversation.
 */
export function scoreExchangeDensity(
  exchanges: ConversationExchange[],
): DensityScore[] {
  if (exchanges.length === 0) return [];

  // Compute raw feature values
  const rawScores = exchanges.map((ex) => {
    const fullText = (ex.userMessage ?? "") + (ex.assistantMessage ?? "");
    const charCount = fullText.length;
    const toolCallCount = countToolCalls(fullText);
    const codeBlockCount = countCodeBlocks(fullText);
    const hasDecision = hasDecisionLanguage(fullText);

    return {
      index: ex.index,
      charCount,
      toolCallCount,
      codeBlockCount,
      hasDecision,
    };
  });

  // Find max values for normalization
  const maxChars = Math.max(...rawScores.map((s) => s.charCount), 1);
  const maxTools = Math.max(...rawScores.map((s) => s.toolCallCount), 1);
  const maxCode = Math.max(...rawScores.map((s) => s.codeBlockCount), 1);

  // Compute weighted raw scores
  const weightedScores = rawScores.map((s) => {
    const normChars = s.charCount / maxChars;
    const normTools = s.toolCallCount / maxTools;
    const normCode = s.codeBlockCount / maxCode;
    const normDecision = s.hasDecision ? 1 : 0;

    const rawScore =
      WEIGHT_CHAR_COUNT * normChars +
      WEIGHT_TOOL_CALLS * normTools +
      WEIGHT_CODE_BLOCKS * normCode +
      WEIGHT_DECISION * normDecision;

    return { ...s, rawScore };
  });

  // Normalize to [0, 1] across the conversation.
  // When all scores are equal (range=0), use the raw score directly as an
  // absolute density indicator — uniformly dense conversations should score
  // high, uniformly sparse ones should score low.
  const minRaw = Math.min(...weightedScores.map((s) => s.rawScore));
  const maxRaw = Math.max(...weightedScores.map((s) => s.rawScore));
  const range = maxRaw - minRaw;

  return weightedScores.map((s) => ({
    index: s.index,
    score: range > 0 ? (s.rawScore - minRaw) / range : s.rawScore,
    charCount: s.charCount,
    toolCallCount: s.toolCallCount,
    codeBlockCount: s.codeBlockCount,
  }));
}

// ─── Adaptive Chunking ─────────────────────────────────────────

const DEFAULT_MIN_CHUNK = 10;
const DEFAULT_MAX_CHUNK = 40;
const DEFAULT_DENSITY_THRESHOLD = 0.6;
const DEFAULT_OVERLAP = 3;

/**
 * Determine target chunk size based on average density of a region.
 *
 * Dense regions (above threshold) get minChunkSize.
 * Sparse regions (below threshold) get maxChunkSize.
 * Transition zones interpolate linearly.
 */
function targetChunkSize(
  avgDensity: number,
  minSize: number,
  maxSize: number,
  threshold: number,
): number {
  if (avgDensity >= threshold) return minSize;
  if (avgDensity <= threshold * 0.5) return maxSize;
  // Interpolate in the transition zone
  const t = (threshold - avgDensity) / (threshold * 0.5);
  return Math.round(minSize + t * (maxSize - minSize));
}

/**
 * Create variable-sized chunks based on information density.
 *
 * Smaller chunks for dense regions, larger for sparse regions.
 * Always maintains overlap between adjacent chunks to preserve context.
 */
export function adaptiveChunk(
  exchanges: ConversationExchange[],
  options?: AdaptiveChunkOptions,
): ConversationExchange[][] {
  const minSize = options?.minChunkSize ?? DEFAULT_MIN_CHUNK;
  const maxSize = options?.maxChunkSize ?? DEFAULT_MAX_CHUNK;
  const threshold = options?.densityThreshold ?? DEFAULT_DENSITY_THRESHOLD;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP;

  // Short conversations: single chunk
  if (exchanges.length <= minSize) {
    return [exchanges];
  }

  const densityScores = scoreExchangeDensity(exchanges);

  const chunks: ConversationExchange[][] = [];
  let start = 0;

  while (start < exchanges.length) {
    // Look ahead to determine density of the next region
    const lookAheadEnd = Math.min(start + minSize, exchanges.length);
    const regionScores = densityScores.slice(start, lookAheadEnd);
    const avgDensity =
      regionScores.reduce((sum, s) => sum + s.score, 0) / regionScores.length;

    const chunkSize = targetChunkSize(avgDensity, minSize, maxSize, threshold);
    const end = Math.min(start + chunkSize, exchanges.length);

    chunks.push(exchanges.slice(start, end));

    // Advance by chunkSize minus overlap, at least 1 to avoid infinite loop
    const step = Math.max(chunkSize - overlap, 1);
    start += step;

    // If remaining exchanges would be smaller than overlap, include in last chunk and stop
    if (start < exchanges.length && exchanges.length - start <= overlap) {
      chunks.push(exchanges.slice(start));
      break;
    }
  }

  return chunks;
}
