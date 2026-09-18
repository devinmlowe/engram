/**
 * Three-tier semantic extraction pipeline.
 *
 * Extracts structured facts from Claude Code conversations through the
 * _core/llm factory, so the configured cascade (Ollama → OpenRouter →
 * Anthropic primary → Anthropic fallback) applies to every chunk (SPEC.md
 * INV-3). Supports chunking for long conversations and optional reflexion
 * for completeness.
 *
 * Phase 3, Stream C implementation.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { MemoryType } from "./types.js";
import {
  buildIntelligenceConfig,
  generateStructured,
  isAnthropicAvailable,
  isOllamaAvailable,
  isOpenRouterAvailable,
  resetIntelligence,
  resolveOpenAIRouteConfig,
  setClient as setIntelligenceClient,
  type GenerationResult,
  type IntelligenceConfig,
  type LlmProvider,
} from "../_core/llm/index.js";
import { loadConfig } from "../_core/config/index.js";
import type {
  ExtractedFact,
  ExtractionResult,
  ExtractionConfig,
  ChunkBoundaryInfo,
} from "./types.js";

// ─── Module State ───────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VALID_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set([
  "preference",
  "decision",
  "pattern",
  "fact",
  "solution",
  "convention",
]);

const DEFAULT_CONFIG: ExtractionConfig = {
  tier: "auto",
  reflexionEnabled: false,
  chunkSize: 25,
  chunkOverlap: 5,
  maxTurns: 100,
  chunkingStrategy: "fixed",
};

// ─── Tool Schema ────────────────────────────────────────────────

const EXTRACT_MEMORIES_TOOL_NAME = "extract_memories";
const EXTRACT_MEMORIES_TOOL_DESCRIPTION = "Extract structured facts from conversation";
const EXTRACTION_SYSTEM_PROMPT =
  "You are a memory extraction system. Extract facts from the conversation.";

/** JSON schema for the structured extraction result (factory adds `type: object`). */
const EXTRACT_MEMORIES_SCHEMA: Record<string, unknown> = {
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "preference",
              "decision",
              "pattern",
              "fact",
              "solution",
              "convention",
            ],
          },
          content: { type: "string" },
          context: { type: "string" },
          importance: { type: "number", minimum: 0, maximum: 1 },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "How certain you are that this fact is accurate and correctly categorised (distinct from importance)",
          },
          source_exchange_indexes: {
            type: "array",
            items: { type: "integer" },
          },
          extraction_basis: {
            type: "string",
            enum: ["explicit", "inferred", "observed"],
            description: "How this fact was derived: explicit (user stated), inferred (from behavior), observed (factual from conversation)",
          },
        },
        required: [
          "type",
          "content",
          "importance",
          "source_exchange_indexes",
        ],
      },
    },
  },
  required: ["facts"],
};

// ─── Exchange Type ──────────────────────────────────────────────

export interface ConversationExchange {
  index: number;
  userMessage: string;
  assistantMessage: string;
  /**
   * Stored exchange id. When present, extracted facts' source references
   * (which the model emits as `[Exchange N]` indexes) are resolved to real
   * ids so memories.source_exchanges can be joined back to exchanges.
   */
  id?: string;
}

/**
 * Map model-emitted exchange indexes to stored exchange ids. References that
 * are already ids pass through; references that resolve to nothing are
 * dropped (a hallucinated index must not masquerade as an id).
 */
export function resolveSourceExchangeIds(
  refs: readonly string[],
  idByIndex: ReadonlyMap<number, string>,
): string[] {
  const known = new Set(idByIndex.values());
  const out: string[] = [];
  for (const ref of refs) {
    if (known.has(ref)) {
      if (!out.includes(ref)) out.push(ref);
      continue;
    }
    const idx = /^\d+$/.test(ref) ? Number(ref) : NaN;
    const id = idByIndex.get(idx);
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}

export interface ConversationMetadata {
  project: string;
  branch?: string;
  dateRange: string;
}

// ─── Initialization ─────────────────────────────────────────────

/**
 * Verify that at least one tier of the LLM cascade can serve extraction.
 *
 * Credentials and clients are owned by the _core/llm factory; this only
 * checks reachability so callers fail fast with a clear message. Per
 * SPEC.md INV-3 a reachable local Ollama model is sufficient on its own.
 */
export async function initExtractor(): Promise<void> {
  // A configured OpenAI-compatible route (#45: ENGRAM_OPENAI_MODEL + key) is a
  // tier of its own; the cascade decides reachability per call.
  if (isAnthropicAvailable() || isOpenRouterAvailable() || resolveOpenAIRouteConfig() !== undefined) return;
  if (await isOllamaAvailable(intelligenceConfig())) return;
  throw new Error(
    "No extraction provider configured. " +
      "Set ANTHROPIC_API_KEY, OPENROUTER_API_KEY or ENGRAM_OPENAI_MODEL (+ ENGRAM_OPENAI_BASE_URL), " +
      "or run Ollama with the configured local model.",
  );
}

/**
 * Reset the extractor state (for testing). Clears the factory's client.
 */
export function resetExtractor(): void {
  resetIntelligence();
}

/**
 * Inject a custom Anthropic client into the factory (for testing with mocks).
 */
export function setClient(customClient: Anthropic): void {
  setIntelligenceClient(customClient);
}

/** Cascade configuration derived from the application config. */
function intelligenceConfig(): IntelligenceConfig {
  return buildIntelligenceConfig(loadConfig());
}

// ─── Prompt Building ────────────────────────────────────────────

/**
 * Read the extraction prompt template from disk.
 * Resolves relative to this module's location.
 */
function loadPromptTemplate(): string {
  const promptPath = join(__dirname, "..", "..", "prompts", "extract-facts.md");
  return readFileSync(promptPath, "utf-8");
}

/**
 * Build the full extraction prompt from template, metadata, and exchanges.
 */
export function buildExtractionPrompt(
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
): string {
  const template = loadPromptTemplate();

  // Build metadata header
  const metaParts: string[] = [`Project: ${metadata.project}`];
  if (metadata.branch) metaParts.push(`Branch: ${metadata.branch}`);
  metaParts.push(`Date Range: ${metadata.dateRange}`);
  const metaHeader = metaParts.join(", ");

  // Format exchanges
  const formattedExchanges = exchanges
    .map(
      (ex) =>
        `[Exchange ${ex.index}]\nUser: ${ex.userMessage}\nAssistant: ${ex.assistantMessage}`,
    )
    .join("\n\n");

  return `${template}\n${metaHeader}\n\n${formattedExchanges}`;
}

// ─── Chunking ───────────────────────────────────────────────────

// Import from shared location; re-export for backward compatibility
import { chunkConversation } from "../_core/search/text.js";
export { chunkConversation };

// Adaptive chunking (Phase 6A)
import { adaptiveChunk, scoreExchangeDensity } from "./adaptive-chunker.js";

// Database type for chunk metadata persistence (Phase 7C.2)
import type Database from "better-sqlite3";

// ─── Response Parsing ───────────────────────────────────────────

/**
 * Raw fact shape as returned by the LLM tool_use.
 */
interface RawFact {
  type?: string;
  content?: string;
  context?: string;
  importance?: number;
  confidence?: number;
  source_exchange_indexes?: number[];
  extraction_basis?: string;
}

/**
 * Parse and validate the extraction response from tool_use.
 *
 * Extracts facts from the tool_use content block, validates each fact,
 * and filters out invalid entries.
 */
export function parseExtractionResponse(
  toolUseResult: unknown,
): ExtractedFact[] {
  if (!toolUseResult || typeof toolUseResult !== "object") {
    return [];
  }

  // Handle Anthropic API response shape: array of content blocks
  const result = toolUseResult as Record<string, unknown>;

  let rawFacts: RawFact[] = [];

  // Direct facts array (from tool input)
  if (Array.isArray(result.facts)) {
    rawFacts = result.facts as RawFact[];
  }
  // Content blocks array (from full API response)
  else if (Array.isArray(result.content)) {
    const contentBlocks = result.content as Array<Record<string, unknown>>;
    for (const block of contentBlocks) {
      if (block.type === "tool_use" && block.input) {
        const input = block.input as Record<string, unknown>;
        if (Array.isArray(input.facts)) {
          rawFacts = input.facts as RawFact[];
          break;
        }
      }
    }
  }

  const facts: ExtractedFact[] = [];

  for (const raw of rawFacts) {
    // Validate type
    if (!raw.type || !VALID_MEMORY_TYPES.has(raw.type as MemoryType)) {
      continue;
    }

    // Validate content
    if (!raw.content || typeof raw.content !== "string" || raw.content.trim() === "") {
      continue;
    }

    // Clamp importance to [0, 1]
    let importance = typeof raw.importance === "number" ? raw.importance : 0.5;
    importance = Math.max(0, Math.min(1, importance));

    // Filter out facts with importance below threshold
    if (importance < 0.1) {
      continue;
    }

    // Model-supplied confidence (W9c): keep when numeric, clamped to [0, 1];
    // leave absent otherwise so the consolidator applies its 0.5 fallback.
    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1, raw.confidence))
        : undefined;

    // Convert source_exchange_indexes to string array for sourceExchangeIds
    const sourceExchangeIds: string[] = Array.isArray(raw.source_exchange_indexes)
      ? raw.source_exchange_indexes.map((idx) => String(idx))
      : [];

    // Validate extraction_basis
    const validBases = new Set(["explicit", "inferred", "observed"]);
    const extractionBasis = (raw.extraction_basis && validBases.has(raw.extraction_basis))
      ? raw.extraction_basis as "explicit" | "inferred" | "observed"
      : "observed";

    facts.push({
      type: raw.type as MemoryType,
      content: raw.content.trim(),
      context: raw.context && typeof raw.context === "string" ? raw.context.trim() : undefined,
      importance,
      ...(confidence !== undefined ? { confidence } : {}),
      sourceExchangeIds,
      extractionBasis,
    });
  }

  return facts;
}

// ─── Tier Planning ──────────────────────────────────────────────

/** Cascade tier label reported on extraction results. */
export type ExtractionTier = ExtractionResult["tier"];

/** How a configured ExtractionConfig tier maps onto the factory cascade. */
interface TierPlan {
  config: IntelligenceConfig;
  /** Skip the local Ollama probe (explicit cloud pins). */
  skipLocal: boolean;
  /** Fixed tier label for single-model pins; otherwise derived from the result. */
  pinnedTier?: ExtractionTier;
}

/**
 * Translate an ExtractionConfig tier into factory inputs.
 *
 * - "auto" / "local": full cascade — Ollama → OpenRouter → Anthropic.
 * - "openrouter": cloud only — OpenRouter → Anthropic.
 * - "haiku" / "sonnet": explicit Anthropic model pin — single model, no
 *   local probe, no OpenRouter.
 */
function planForTier(
  tier: ExtractionConfig["tier"],
  base: IntelligenceConfig,
): TierPlan {
  switch (tier) {
    case "haiku":
      return {
        config: { ...base, openrouterModel: undefined, apiFallbackModel: base.apiModel },
        skipLocal: true,
        pinnedTier: "haiku",
      };
    case "sonnet":
      return {
        config: { ...base, openrouterModel: undefined, apiModel: base.apiFallbackModel },
        skipLocal: true,
        pinnedTier: "sonnet",
      };
    case "openrouter":
      return { config: base, skipLocal: true };
    case "local":
    case "auto":
    default:
      return { config: base, skipLocal: false };
  }
}

/**
 * Label the cascade tier that produced a factory result.
 *
 * "haiku"/"sonnet" are the historical names for the Anthropic primary and
 * fallback models; the actual model ids come from config.
 */
export function cascadeTierOf(
  result: GenerationResult<unknown>,
  config: IntelligenceConfig,
): ExtractionTier {
  if (result.provider === "ollama" || (!result.provider && result.source === "local")) {
    return "local";
  }
  if (result.provider === "openrouter") return "openrouter";
  return result.model === config.apiFallbackModel && result.model !== config.apiModel
    ? "sonnet"
    : "haiku";
}

// ─── LLM Extraction Call ────────────────────────────────────────

/**
 * Run one extraction call through the factory cascade.
 */
async function callExtraction(
  prompt: string,
  plan: TierPlan,
): Promise<{ facts: ExtractedFact[]; model: string; tier: ExtractionTier; provider?: LlmProvider }> {
  const result = await generateStructured<{ facts?: unknown[] }>(
    EXTRACTION_SYSTEM_PROMPT,
    prompt,
    EXTRACT_MEMORIES_SCHEMA,
    plan.config,
    {
      toolName: EXTRACT_MEMORIES_TOOL_NAME,
      toolDescription: EXTRACT_MEMORIES_TOOL_DESCRIPTION,
      skipLocal: plan.skipLocal,
    },
  );

  return {
    facts: parseExtractionResponse({ facts: result.result.facts }),
    model: result.model,
    tier: plan.pinnedTier ?? cascadeTierOf(result, plan.config),
    provider: result.provider,
  };
}

// ─── Reflexion Pass ─────────────────────────────────────────────

/**
 * Perform a reflexion pass: ask the LLM to review extracted facts
 * and identify anything missed.
 */
async function reflexionPass(
  prompt: string,
  existingFacts: ExtractedFact[],
  plan: TierPlan,
): Promise<ExtractedFact[]> {
  const factsJson = JSON.stringify(
    existingFacts.map((f) => ({
      type: f.type,
      content: f.content,
      importance: f.importance,
    })),
    null,
    2,
  );

  const reflexionPrompt =
    `${prompt}\n\n---\n\nThe following facts were already extracted from this conversation:\n\n${factsJson}\n\n` +
    `Review these extracted facts against the source conversation. ` +
    `What facts, preferences, or decisions were missed? ` +
    `Extract only the MISSING facts that were not already captured above.`;

  try {
    const { facts } = await callExtraction(reflexionPrompt, plan);
    return facts;
  } catch {
    // Reflexion is optional; don't fail the extraction if it errors
    return [];
  }
}

/**
 * Simple deduplication: filter out facts from the reflexion pass
 * whose content closely matches an existing fact.
 */
function deduplicateFacts(
  existing: ExtractedFact[],
  additional: ExtractedFact[],
): ExtractedFact[] {
  const deduplicated: ExtractedFact[] = [];

  for (const newFact of additional) {
    const normalizedNew = newFact.content.toLowerCase().trim();
    const isDuplicate = existing.some((existingFact) => {
      const normalizedExisting = existingFact.content.toLowerCase().trim();
      // Exact match or one contains the other
      return (
        normalizedNew === normalizedExisting ||
        normalizedNew.includes(normalizedExisting) ||
        normalizedExisting.includes(normalizedNew)
      );
    });

    if (!isDuplicate) {
      deduplicated.push(newFact);
    }
  }

  return deduplicated;
}

// ─── Main Extraction Entry Point ────────────────────────────────

/**
 * Extract structured facts from a conversation.
 *
 * Every chunk goes through the _core/llm factory cascade (tier="auto"):
 * 1. Ollama — local, free (SPEC.md INV-3)
 * 2. OpenRouter — cost-effective cloud (Gemini 2.5 Flash Lite ~$11/batch)
 * 3. Anthropic — primary model, then fallback model
 *
 * Chunks long conversations and optionally runs a reflexion pass
 * to catch missed facts.
 */
export async function extractFromConversation(
  conversationId: string,
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
  config?: Partial<ExtractionConfig>,
): Promise<ExtractionResult> {
  const cfg: ExtractionConfig = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  // Chunk if needed — use adaptive or fixed strategy
  const chunks = cfg.chunkingStrategy === "adaptive"
    ? adaptiveChunk(exchanges, { overlap: cfg.chunkOverlap })
    : chunkConversation(exchanges, cfg.chunkSize, cfg.chunkOverlap);

  // Phase 7C.2: Compute chunk boundary metadata for diagnostics
  const densityScores = cfg.chunkingStrategy === "adaptive"
    ? scoreExchangeDensity(exchanges)
    : [];
  const chunkBoundaries: ChunkBoundaryInfo[] = chunks.map((chunk) => {
    const startIdx = chunk[0]?.index ?? 0;
    const endIdx = (chunk[chunk.length - 1]?.index ?? 0) + 1;
    // Compute average density for this chunk's range (adaptive only)
    let avgDensity: number | undefined;
    if (densityScores.length > 0) {
      const relevant = densityScores.filter(
        (s) => s.index >= startIdx && s.index < endIdx,
      );
      if (relevant.length > 0) {
        avgDensity = relevant.reduce((sum, s) => sum + s.score, 0) / relevant.length;
      }
    }
    return { start: startIdx, end: endIdx, avgDensity };
  });

  const plan = planForTier(cfg.tier, intelligenceConfig());

  let allFacts: ExtractedFact[] = [];
  let usedModel = plan.config.apiModel;
  let usedTier: ExtractionTier = "haiku";
  let usedProvider: LlmProvider | undefined;

  for (const chunk of chunks) {
    const prompt = buildExtractionPrompt(chunk, metadata);

    try {
      // The factory walks the whole cascade; an error here means every
      // configured tier failed for this chunk.
      const result = await callExtraction(prompt, plan);
      allFacts.push(...result.facts);
      usedModel = result.model;
      usedTier = result.tier;
      usedProvider = result.provider;
    } catch (err) {
      throw new Error(
        `All extraction tiers failed for conversation ${conversationId}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Optional reflexion pass
  // Resolve `[Exchange N]` references to stored exchange ids when the caller
  // supplied them, so source_exchanges is joinable (event-time recall).
  const idByIndex = new Map<number, string>();
  for (const ex of exchanges) {
    if (ex.id) idByIndex.set(ex.index, ex.id);
  }
  if (idByIndex.size > 0) {
    allFacts = allFacts.map((f) => ({
      ...f,
      sourceExchangeIds: resolveSourceExchangeIds(f.sourceExchangeIds, idByIndex),
    }));
  }

  if (cfg.reflexionEnabled && allFacts.length > 0) {
    const fullPrompt = buildExtractionPrompt(exchanges, metadata);
    const additional = await reflexionPass(fullPrompt, allFacts, plan);
    const unique = deduplicateFacts(allFacts, additional);
    allFacts = [...allFacts, ...unique];
  }

  const durationMs = Date.now() - startTime;

  return {
    conversationId,
    facts: allFacts,
    model: usedModel,
    tier: usedTier,
    provider: usedProvider,
    confidence: allFacts.length > 0 ? 7 : 1,
    durationMs,
    chunkBoundaries,
  };
}

// ─── Chunk Metadata Persistence (Phase 7C.2) ───────────────────

/**
 * Persist chunk boundary metadata to the chunk_metadata table.
 *
 * This is a diagnostic feature — if db is null or the write fails,
 * extraction continues unaffected.
 */
export function persistChunkMetadata(
  db: Database.Database | null,
  conversationId: string,
  chunks: Array<{ start: number; end: number; avgDensity?: number }>,
): void {
  if (!db || chunks.length === 0) return;

  try {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO chunk_metadata (id, conversation_id, chunk_index, start_exchange, end_exchange, exchange_count, avg_density)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertAll = db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const id = `${conversationId}:${i}`;
        stmt.run(
          id,
          conversationId,
          i,
          chunk.start,
          chunk.end,
          chunk.end - chunk.start,
          chunk.avgDensity ?? null,
        );
      }
    });

    insertAll();
  } catch {
    // Chunk metadata is diagnostic — never fail the extraction pipeline
  }
}
