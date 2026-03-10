/**
 * Three-tier semantic extraction pipeline.
 *
 * Extracts structured facts from Claude Code conversations using LLM
 * tool_use. Supports chunking for long conversations, tiered model
 * fallback (Haiku -> Sonnet), and optional reflexion for completeness.
 *
 * Phase 3, Stream C implementation.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { MemoryType } from "./types.js";
import { isOpenRouterAvailable, callOpenRouterTool } from "../_core/llm/providers/openrouter.js";
import type {
  ExtractedFact,
  ExtractionResult,
  ExtractionConfig,
  ChunkBoundaryInfo,
} from "./types.js";

// ─── Module State ───────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let client: Anthropic | null = null;

const VALID_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set([
  "preference",
  "decision",
  "pattern",
  "fact",
  "solution",
  "convention",
]);

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const FALLBACK_MODEL = "claude-sonnet-4-6";
const DEFAULT_CONFIG: ExtractionConfig = {
  tier: "auto",
  reflexionEnabled: false,
  chunkSize: 25,
  chunkOverlap: 5,
  maxTurns: 100,
  chunkingStrategy: "fixed",
};

// ─── Tool Schema ────────────────────────────────────────────────

const EXTRACT_MEMORIES_TOOL: Anthropic.Tool = {
  name: "extract_memories",
  description: "Extract structured facts from conversation",
  input_schema: {
    type: "object" as const,
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
  },
};

// ─── Exchange Type ──────────────────────────────────────────────

export interface ConversationExchange {
  index: number;
  userMessage: string;
  assistantMessage: string;
}

export interface ConversationMetadata {
  project: string;
  branch?: string;
  dateRange: string;
}

// ─── Initialization ─────────────────────────────────────────────

/**
 * Initialize the extraction clients.
 *
 * Creates the Anthropic client if an API key is available.
 * OpenRouter uses fetch directly and only needs OPENROUTER_API_KEY at call time.
 * At least one provider (Anthropic or OpenRouter) must be configured.
 */
export async function initExtractor(anthropicApiKey?: string): Promise<void> {
  if (client) return;

  const apiKey = anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    client = new Anthropic({ apiKey });
  }

  // Verify at least one extraction provider is available
  if (!client && !isOpenRouterAvailable()) {
    throw new Error(
      "No extraction provider configured. " +
        "Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY environment variable.",
    );
  }
}

/**
 * Reset the extractor state (for testing).
 */
export function resetExtractor(): void {
  client = null;
}

/**
 * Set a custom Anthropic client (for testing with mocks).
 */
export function setClient(customClient: Anthropic): void {
  client = customClient;
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
      sourceExchangeIds,
      extractionBasis,
    });
  }

  return facts;
}

// ─── LLM Extraction Call ────────────────────────────────────────

/**
 * Call OpenRouter for fact extraction via the shared client.
 */
async function callOpenRouterExtraction(
  prompt: string,
): Promise<{ facts: ExtractedFact[]; model: string }> {
  const { result, model } = await callOpenRouterTool<{ facts: unknown[] }>(
    [{ role: "user", content: prompt }],
    {
      name: EXTRACT_MEMORIES_TOOL.name,
      description: EXTRACT_MEMORIES_TOOL.description ?? "",
      parameters: EXTRACT_MEMORIES_TOOL.input_schema as Record<string, unknown>,
    },
  );

  const facts = parseExtractionResponse({ facts: result.facts });
  return { facts, model };
}

/**
 * Call an LLM for fact extraction, routing by model identifier.
 */
async function callExtraction(
  prompt: string,
  model: string,
): Promise<{ facts: ExtractedFact[]; model: string }> {
  // Local model route: use intelligence layer instead of Anthropic SDK
  if (model === "local") {
    const { generateStructured, buildIntelligenceConfig } = await import(
      "../_core/llm/index.js"
    );
    const { loadConfig } = await import("../_core/config/index.js");
    const config = loadConfig();
    const intelligenceConfig = buildIntelligenceConfig(config);

    // Build a JSON schema matching the EXTRACT_MEMORIES_TOOL input schema
    const schema = EXTRACT_MEMORIES_TOOL.input_schema;

    const result = await generateStructured<{ facts: unknown[] }>(
      "You are a memory extraction system. Extract facts from the conversation.",
      prompt,
      schema as Record<string, unknown>,
      intelligenceConfig,
    );

    const facts = parseExtractionResponse({ facts: result.result.facts });
    return { facts, model: result.model };
  }

  // OpenRouter route: use fetch with OpenAI-compatible function calling
  if (model === "openrouter") {
    return callOpenRouterExtraction(prompt);
  }

  // Anthropic API route: use Anthropic SDK
  if (!client) {
    throw new Error(
      "Anthropic client not initialized. Set ANTHROPIC_API_KEY or use OpenRouter/local tier.",
    );
  }

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [EXTRACT_MEMORIES_TOOL],
    tool_choice: { type: "tool", name: "extract_memories" },
    messages: [{ role: "user", content: prompt }],
  });

  // Find the tool_use block in response
  const toolUseBlock = response.content.find(
    (block) => block.type === "tool_use",
  );

  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    return { facts: [], model };
  }

  const facts = parseExtractionResponse({ facts: (toolUseBlock.input as Record<string, unknown>).facts });
  return { facts, model };
}

// ─── Reflexion Pass ─────────────────────────────────────────────

/**
 * Perform a reflexion pass: ask the LLM to review extracted facts
 * and identify anything missed.
 */
async function reflexionPass(
  prompt: string,
  existingFacts: ExtractedFact[],
  model: string,
): Promise<ExtractedFact[]> {
  if (!client) return [];

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
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      tools: [EXTRACT_MEMORIES_TOOL],
      tool_choice: { type: "tool", name: "extract_memories" },
      messages: [{ role: "user", content: reflexionPrompt }],
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === "tool_use",
    );

    if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
      return [];
    }

    return parseExtractionResponse({ facts: (toolUseBlock.input as Record<string, unknown>).facts });
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
 * Multi-tier routing (when tier="auto"):
 * 1. OpenRouter — cost-effective first attempt (Gemini 2.5 Flash Lite ~$11/batch)
 * 2. Haiku — Anthropic fallback
 * 3. Sonnet — final fallback if Haiku fails
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

  let allFacts: ExtractedFact[] = [];
  let usedModel = DEFAULT_MODEL;
  let usedTier: "local" | "openrouter" | "haiku" | "sonnet" = "haiku";

  // Determine which model(s) to try
  const modelsToTry = resolveModels(cfg.tier);

  for (const chunk of chunks) {
    const prompt = buildExtractionPrompt(chunk, metadata);
    let extracted = false;

    for (const { model, tier } of modelsToTry) {
      try {
        const result = await callExtraction(prompt, model);
        allFacts.push(...result.facts);
        usedModel = result.model;
        usedTier = tier;
        extracted = true;
        break;
      } catch (err) {
        // If this is the last model option, throw
        if (model === modelsToTry[modelsToTry.length - 1].model) {
          throw new Error(
            `All extraction tiers failed for conversation ${conversationId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // Otherwise, fall through to next tier
      }
    }

    if (!extracted) {
      throw new Error(
        `Extraction failed for conversation ${conversationId}: no tier succeeded.`,
      );
    }
  }

  // Optional reflexion pass
  if (cfg.reflexionEnabled && allFacts.length > 0) {
    const fullPrompt = buildExtractionPrompt(exchanges, metadata);
    const additional = await reflexionPass(fullPrompt, allFacts, usedModel);
    const unique = deduplicateFacts(allFacts, additional);
    allFacts = [...allFacts, ...unique];
  }

  const durationMs = Date.now() - startTime;

  return {
    conversationId,
    facts: allFacts,
    model: usedModel,
    tier: usedTier,
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

/**
 * Resolve which models to try based on tier configuration.
 *
 * In "auto" mode, OpenRouter is preferred when OPENROUTER_API_KEY is set,
 * with Anthropic Haiku → Sonnet as fallbacks. This gives the cheapest
 * extraction path (~$11 vs ~$90-120 for a full dream cycle).
 */
function resolveModels(
  tier: ExtractionConfig["tier"],
): Array<{ model: string; tier: "local" | "openrouter" | "haiku" | "sonnet" }> {
  switch (tier) {
    case "haiku":
      return [{ model: DEFAULT_MODEL, tier: "haiku" }];
    case "sonnet":
      return [{ model: FALLBACK_MODEL, tier: "sonnet" }];
    case "openrouter":
      return [
        { model: "openrouter", tier: "openrouter" },
        { model: DEFAULT_MODEL, tier: "haiku" },
        { model: FALLBACK_MODEL, tier: "sonnet" },
      ];
    case "local":
      return [
        { model: "local", tier: "local" },
        { model: "openrouter", tier: "openrouter" },
        { model: DEFAULT_MODEL, tier: "haiku" },
        { model: FALLBACK_MODEL, tier: "sonnet" },
      ];
    case "auto":
    default: {
      const models: Array<{ model: string; tier: "local" | "openrouter" | "haiku" | "sonnet" }> = [];
      // Prefer OpenRouter when available (10x cheaper than Haiku)
      if (isOpenRouterAvailable()) {
        models.push({ model: "openrouter", tier: "openrouter" });
      }
      // Anthropic tiers as fallback
      if (client) {
        models.push({ model: DEFAULT_MODEL, tier: "haiku" });
        models.push({ model: FALLBACK_MODEL, tier: "sonnet" });
      }
      // If nothing is configured, return Haiku as default (will error with helpful message)
      if (models.length === 0) {
        models.push({ model: DEFAULT_MODEL, tier: "haiku" });
      }
      return models;
    }
  }
}
