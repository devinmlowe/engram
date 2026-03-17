/**
 * Two-step entity and relationship extraction pipeline.
 *
 * Extracts entities and relationships from Claude Code conversations using
 * LLM tool_use. Follows the same patterns as semantic/extractor.ts:
 * lazy singleton client, tiered model fallback (Haiku -> Sonnet), and
 * prompt template loading from disk.
 *
 * Phase 4, Stream B implementation.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { EntityType, RelationshipType } from "./types.js";
import { isOpenRouterAvailable, callOpenRouterTool } from "../_core/llm/providers/openrouter.js";
import type {
  ExtractedEntity,
  ExtractedRelationship,
  EntityExtractionResult,
  RelationshipExtractionResult,
} from "./types.js";
import type { ConversationExchange, ConversationMetadata } from "../semantic/extractor.js";
import { chunkConversation } from "../_core/search/text.js";

// ─── Module State ───────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let client: Anthropic | null = null;

const VALID_ENTITY_TYPES: ReadonlySet<EntityType> = new Set([
  "project",
  "tool",
  "technology",
  "person",
  "concept",
  "file",
  "repo",
]);

const VALID_RELATIONSHIP_TYPES: ReadonlySet<RelationshipType> = new Set([
  "uses",
  "depends_on",
  "related_to",
  "part_of",
  "configured_by",
  "solved_by",
]);

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const FALLBACK_MODEL = "claude-sonnet-4-6";

// ─── Tool Schemas ──────────────────────────────────────────────

const EXTRACT_ENTITIES_TOOL: Anthropic.Tool = {
  name: "extract_entities",
  description: "Extract entities from conversation",
  input_schema: {
    type: "object" as const,
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: {
              type: "string",
              enum: [
                "project",
                "tool",
                "technology",
                "person",
                "concept",
                "file",
                "repo",
              ],
            },
            description: { type: "string" },
          },
          required: ["name", "type"],
        },
      },
    },
    required: ["entities"],
  },
};

const EXTRACT_RELATIONSHIPS_TOOL: Anthropic.Tool = {
  name: "extract_relationships",
  description: "Extract relationships between entities",
  input_schema: {
    type: "object" as const,
    properties: {
      relationships: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source_entity_index: { type: "integer" },
            target_entity_index: { type: "integer" },
            type: {
              type: "string",
              enum: [
                "uses",
                "depends_on",
                "related_to",
                "part_of",
                "configured_by",
                "solved_by",
              ],
            },
            context: { type: "string" },
          },
          required: ["source_entity_index", "target_entity_index", "type"],
        },
      },
    },
    required: ["relationships"],
  },
};

// ─── Initialization ─────────────────────────────────────────────

/**
 * Initialize the graph extraction clients.
 *
 * Creates the Anthropic client if an API key is available.
 * OpenRouter is used via the shared client when OPENROUTER_API_KEY is set.
 * At least one provider must be configured.
 */
export async function initGraphExtractor(anthropicApiKey?: string): Promise<void> {
  if (client) return;

  const apiKey = anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    client = new Anthropic({ apiKey });
  }

  if (!client && !isOpenRouterAvailable()) {
    throw new Error(
      "No graph extraction provider configured. " +
        "Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY environment variable.",
    );
  }
}

/**
 * Reset the graph extractor state (for testing).
 */
export function resetGraphExtractor(): void {
  client = null;
}

/**
 * Set a custom Anthropic client (for testing with mocks).
 */
export function setGraphExtractorClient(customClient: Anthropic): void {
  client = customClient;
}

// ─── Prompt Building ────────────────────────────────────────────

/**
 * Read a prompt template from disk.
 * Resolves relative to this module's location.
 */
function loadPromptTemplate(filename: string): string {
  const promptPath = join(__dirname, "..", "..", "prompts", filename);
  return readFileSync(promptPath, "utf-8");
}

/**
 * Build the entity extraction prompt from template, metadata, and exchanges.
 */
export function buildEntityExtractionPrompt(
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
): string {
  const template = loadPromptTemplate("extract-entities.md");

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

  return `${template}\n---\n${metaHeader}\n\n${formattedExchanges}`;
}

/**
 * Build the relationship extraction prompt from template, metadata, entities,
 * and exchanges.
 */
export function buildRelationshipExtractionPrompt(
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
  entities: Array<{ index: number; name: string; type: EntityType }>,
): string {
  let template = loadPromptTemplate("extract-relationships.md");

  // Build entity list
  const entityList = entities
    .map((e) => `[${e.index}] ${e.name} (${e.type})`)
    .join("\n");

  // Format exchanges
  const metaParts: string[] = [`Project: ${metadata.project}`];
  if (metadata.branch) metaParts.push(`Branch: ${metadata.branch}`);
  metaParts.push(`Date Range: ${metadata.dateRange}`);
  const metaHeader = metaParts.join(", ");

  const formattedExchanges = exchanges
    .map(
      (ex) =>
        `[Exchange ${ex.index}]\nUser: ${ex.userMessage}\nAssistant: ${ex.assistantMessage}`,
    )
    .join("\n\n");

  const conversationText = `${metaHeader}\n\n${formattedExchanges}`;

  // Replace placeholders
  template = template.replace("{entity_list}", entityList);
  template = template.replace("{conversation_text}", conversationText);

  return template;
}

// ─── Response Parsing ───────────────────────────────────────────

/**
 * Raw entity shape as returned by the LLM tool_use.
 */
interface RawEntity {
  name?: string;
  type?: string;
  description?: string;
}

/**
 * Raw relationship shape as returned by the LLM tool_use.
 */
interface RawRelationship {
  source_entity_index?: number;
  target_entity_index?: number;
  type?: string;
  context?: string;
}

/**
 * Regex matching strings that are pure punctuation/markdown structure.
 * These should never become entities.
 */
const BLOCKED_NAME_PATTERN = /^[\s\-#*`|=>~_!@$%^&()[\]{}<>\\/.,:;'"+=]+$/;

/**
 * Explicit blocklist for names that pass the regex but are still noise.
 */
const BLOCKED_NAMES: ReadonlySet<string> = new Set([
  "- [ ]", "- [x]", "todo", "n/a", "none", "null", "undefined",
  "true", "false", "yes", "no", "ok", "error", "warning",
]);

/**
 * Returns true if the entity name is a known artifact or noise pattern.
 */
export function isBlockedEntityName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length <= 1) return true;
  if (BLOCKED_NAME_PATTERN.test(trimmed)) return true;
  if (BLOCKED_NAMES.has(trimmed.toLowerCase())) return true;
  return false;
}

/**
 * Parse and validate entity extraction response from tool_use.
 *
 * Validates entity types against EntityType, filters empty names,
 * and deduplicates by lowercase name.
 */
export function parseEntityExtractionResponse(
  toolUseResult: unknown,
): ExtractedEntity[] {
  if (!toolUseResult || typeof toolUseResult !== "object") {
    return [];
  }

  const result = toolUseResult as Record<string, unknown>;

  let rawEntities: RawEntity[] = [];

  // Direct entities array (from tool input)
  if (Array.isArray(result.entities)) {
    rawEntities = result.entities as RawEntity[];
  }
  // Content blocks array (from full API response)
  else if (Array.isArray(result.content)) {
    const contentBlocks = result.content as Array<Record<string, unknown>>;
    for (const block of contentBlocks) {
      if (block.type === "tool_use" && block.input) {
        const input = block.input as Record<string, unknown>;
        if (Array.isArray(input.entities)) {
          rawEntities = input.entities as RawEntity[];
          break;
        }
      }
    }
  }

  const entities: ExtractedEntity[] = [];
  const seenNames = new Set<string>();

  for (const raw of rawEntities) {
    // Validate name
    if (!raw.name || typeof raw.name !== "string" || raw.name.trim() === "") {
      continue;
    }

    // Filter blocked entity names (markdown artifacts, noise patterns)
    if (isBlockedEntityName(raw.name)) {
      continue;
    }

    // Validate type
    if (!raw.type || !VALID_ENTITY_TYPES.has(raw.type as EntityType)) {
      continue;
    }

    // Deduplicate by lowercase name
    const normalizedName = raw.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      continue;
    }
    seenNames.add(normalizedName);

    entities.push({
      name: raw.name.trim(),
      type: raw.type as EntityType,
      description:
        raw.description && typeof raw.description === "string"
          ? raw.description.trim()
          : undefined,
    });
  }

  return entities;
}

/**
 * Parse and validate relationship extraction response from tool_use.
 *
 * Validates entity indexes within bounds, validates relationship types,
 * and filters self-referential edges (source == target).
 */
export function parseRelationshipExtractionResponse(
  toolUseResult: unknown,
  entityCount: number,
): ExtractedRelationship[] {
  if (!toolUseResult || typeof toolUseResult !== "object") {
    return [];
  }

  const result = toolUseResult as Record<string, unknown>;

  let rawRelationships: RawRelationship[] = [];

  // Direct relationships array (from tool input)
  if (Array.isArray(result.relationships)) {
    rawRelationships = result.relationships as RawRelationship[];
  }
  // Content blocks array (from full API response)
  else if (Array.isArray(result.content)) {
    const contentBlocks = result.content as Array<Record<string, unknown>>;
    for (const block of contentBlocks) {
      if (block.type === "tool_use" && block.input) {
        const input = block.input as Record<string, unknown>;
        if (Array.isArray(input.relationships)) {
          rawRelationships = input.relationships as RawRelationship[];
          break;
        }
      }
    }
  }

  const relationships: ExtractedRelationship[] = [];

  for (const raw of rawRelationships) {
    // Validate indexes are present and numeric
    if (
      typeof raw.source_entity_index !== "number" ||
      typeof raw.target_entity_index !== "number"
    ) {
      continue;
    }

    // Validate indexes are within bounds
    if (
      raw.source_entity_index < 0 ||
      raw.source_entity_index >= entityCount ||
      raw.target_entity_index < 0 ||
      raw.target_entity_index >= entityCount
    ) {
      continue;
    }

    // Reject self-referential edges
    if (raw.source_entity_index === raw.target_entity_index) {
      continue;
    }

    // Validate relationship type
    if (
      !raw.type ||
      !VALID_RELATIONSHIP_TYPES.has(raw.type as RelationshipType)
    ) {
      continue;
    }

    relationships.push({
      sourceEntityIndex: raw.source_entity_index,
      targetEntityIndex: raw.target_entity_index,
      type: raw.type as RelationshipType,
      context:
        raw.context && typeof raw.context === "string"
          ? raw.context.trim()
          : undefined,
    });
  }

  return relationships;
}

// ─── LLM Extraction Calls ───────────────────────────────────────

/**
 * Call an LLM for entity extraction, preferring OpenRouter when available.
 */
async function callEntityExtraction(
  prompt: string,
  model: string,
): Promise<{ entities: ExtractedEntity[]; model: string }> {
  // OpenRouter path: use shared client with function calling
  if (model === "openrouter" || (!client && isOpenRouterAvailable())) {
    const { result, model: usedModel } = await callOpenRouterTool<{ entities: unknown[] }>(
      [{ role: "user", content: prompt }],
      {
        name: EXTRACT_ENTITIES_TOOL.name,
        description: EXTRACT_ENTITIES_TOOL.description ?? "",
        parameters: EXTRACT_ENTITIES_TOOL.input_schema as Record<string, unknown>,
      },
    );
    const entities = parseEntityExtractionResponse({ entities: result.entities });
    return { entities, model: usedModel };
  }

  // Anthropic path
  if (!client) {
    throw new Error(
      "Graph extractor not initialized. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.",
    );
  }

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [EXTRACT_ENTITIES_TOOL],
    tool_choice: { type: "tool", name: "extract_entities" },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUseBlock = response.content.find(
    (block) => block.type === "tool_use",
  );

  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    return { entities: [], model };
  }

  const entities = parseEntityExtractionResponse({
    entities: (toolUseBlock.input as Record<string, unknown>).entities,
  });
  return { entities, model };
}

/**
 * Call an LLM for relationship extraction, preferring OpenRouter when available.
 */
async function callRelationshipExtraction(
  prompt: string,
  model: string,
  entityCount: number,
): Promise<{ relationships: ExtractedRelationship[]; model: string }> {
  // OpenRouter path
  if (model === "openrouter" || (!client && isOpenRouterAvailable())) {
    const { result, model: usedModel } = await callOpenRouterTool<{ relationships: unknown[] }>(
      [{ role: "user", content: prompt }],
      {
        name: EXTRACT_RELATIONSHIPS_TOOL.name,
        description: EXTRACT_RELATIONSHIPS_TOOL.description ?? "",
        parameters: EXTRACT_RELATIONSHIPS_TOOL.input_schema as Record<string, unknown>,
      },
    );
    const relationships = parseRelationshipExtractionResponse(
      { relationships: result.relationships },
      entityCount,
    );
    return { relationships, model: usedModel };
  }

  // Anthropic path
  if (!client) {
    throw new Error(
      "Graph extractor not initialized. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.",
    );
  }

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [EXTRACT_RELATIONSHIPS_TOOL],
    tool_choice: { type: "tool", name: "extract_relationships" },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUseBlock = response.content.find(
    (block) => block.type === "tool_use",
  );

  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    return { relationships: [], model };
  }

  const relationships = parseRelationshipExtractionResponse(
    {
      relationships: (toolUseBlock.input as Record<string, unknown>)
        .relationships,
    },
    entityCount,
  );
  return { relationships, model };
}

// ─── Main Extraction Entry Points ───────────────────────────────

/**
 * Extract entities from a conversation.
 *
 * Three-tier routing (Haiku first, Sonnet fallback):
 * 1. Build prompt from template + metadata + exchanges
 * 2. Call LLM with tool_use
 * 3. Parse, validate, and deduplicate entities
 *
 * Long conversations are chunked and entities are merged across chunks.
 */
export async function extractEntities(
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
): Promise<EntityExtractionResult> {
  const startTime = Date.now();
  const chunks = chunkConversation(exchanges);

  let allEntities: ExtractedEntity[] = [];
  let usedModel = DEFAULT_MODEL;
  let usedTier: "haiku" | "sonnet" = "haiku";

  for (const chunk of chunks) {
    const prompt = buildEntityExtractionPrompt(chunk, metadata);

    // Try OpenRouter first, then Haiku, then Sonnet
    try {
      const result = await callEntityExtraction(prompt, isOpenRouterAvailable() ? "openrouter" : DEFAULT_MODEL);
      allEntities.push(...result.entities);
      usedModel = result.model;
    } catch {
      // Fallback to Anthropic tiers
      try {
        const result = await callEntityExtraction(prompt, DEFAULT_MODEL);
        allEntities.push(...result.entities);
        usedModel = result.model;
        usedTier = "haiku";
      } catch {
        const result = await callEntityExtraction(prompt, FALLBACK_MODEL);
        allEntities.push(...result.entities);
        usedModel = result.model;
        usedTier = "sonnet";
      }
    }
  }

  // Deduplicate entities across chunks by lowercase name
  const seenNames = new Set<string>();
  const deduplicated: ExtractedEntity[] = [];
  for (const entity of allEntities) {
    const normalized = entity.name.toLowerCase();
    if (!seenNames.has(normalized)) {
      seenNames.add(normalized);
      deduplicated.push(entity);
    }
  }
  allEntities = deduplicated;

  const durationMs = Date.now() - startTime;

  return {
    entities: allEntities,
    model: usedModel,
    tier: usedTier,
    durationMs,
  };
}

/**
 * Extract relationships from a conversation given resolved entities.
 *
 * Three-tier routing (Haiku first, Sonnet fallback):
 * 1. Build prompt from template + entity list + exchanges
 * 2. Call LLM with tool_use
 * 3. Parse, validate indexes, filter self-refs
 */
export async function extractRelationships(
  exchanges: ConversationExchange[],
  metadata: ConversationMetadata,
  resolvedEntities: Array<{ index: number; id: string; name: string; type: EntityType }>,
): Promise<RelationshipExtractionResult> {
  const startTime = Date.now();

  const entityList = resolvedEntities.map((e) => ({
    index: e.index,
    name: e.name,
    type: e.type,
  }));

  const prompt = buildRelationshipExtractionPrompt(
    exchanges,
    metadata,
    entityList,
  );

  let relationships: ExtractedRelationship[] = [];
  let usedModel = DEFAULT_MODEL;
  let usedTier: "haiku" | "sonnet" = "haiku";

  // Try OpenRouter first, then Haiku, then Sonnet
  try {
    const result = await callRelationshipExtraction(
      prompt,
      isOpenRouterAvailable() ? "openrouter" : DEFAULT_MODEL,
      resolvedEntities.length,
    );
    relationships = result.relationships;
    usedModel = result.model;
  } catch {
    try {
      const result = await callRelationshipExtraction(
        prompt,
        DEFAULT_MODEL,
        resolvedEntities.length,
      );
      relationships = result.relationships;
      usedModel = result.model;
      usedTier = "haiku";
    } catch {
      const result = await callRelationshipExtraction(
        prompt,
        FALLBACK_MODEL,
        resolvedEntities.length,
      );
      relationships = result.relationships;
      usedModel = result.model;
      usedTier = "sonnet";
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    relationships,
    model: usedModel,
    tier: usedTier,
    durationMs,
  };
}
