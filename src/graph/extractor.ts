/**
 * Two-step entity and relationship extraction pipeline.
 *
 * Extracts entities and relationships from Claude Code conversations
 * through the _core/llm factory, so the configured cascade (Ollama →
 * OpenRouter → Anthropic primary → Anthropic fallback) applies (SPEC.md
 * INV-3). Follows the same patterns as semantic/extractor.ts, including
 * prompt template loading from disk.
 *
 * Phase 4, Stream B implementation.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { EntityType, RelationshipType, GraphExtractionTier } from "./types.js";
import {
  buildIntelligenceConfig,
  generateStructured,
  isAnthropicAvailable,
  isOllamaAvailable,
  isOpenRouterAvailable,
  resetIntelligence,
  setClient as setIntelligenceClient,
  type IntelligenceConfig,
} from "../_core/llm/index.js";
import { loadConfig } from "../_core/config/index.js";
import type {
  ExtractedEntity,
  ExtractedRelationship,
  EntityExtractionResult,
  RelationshipExtractionResult,
} from "./types.js";
import {
  cascadeTierOf,
  type ConversationExchange,
  type ConversationMetadata,
} from "../semantic/extractor.js";
import { chunkConversation } from "../_core/search/text.js";

// ─── Module State ───────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// ─── Tool Schemas ──────────────────────────────────────────────

const EXTRACT_ENTITIES_TOOL_NAME = "extract_entities";
const EXTRACT_ENTITIES_TOOL_DESCRIPTION = "Extract entities from conversation";
const ENTITY_SYSTEM_PROMPT =
  "You are a knowledge graph extraction system. Extract entities from the conversation.";

/** JSON schema for entity extraction (factory adds `type: object`). */
const EXTRACT_ENTITIES_SCHEMA: Record<string, unknown> = {
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
};

const EXTRACT_RELATIONSHIPS_TOOL_NAME = "extract_relationships";
const EXTRACT_RELATIONSHIPS_TOOL_DESCRIPTION = "Extract relationships between entities";
const RELATIONSHIP_SYSTEM_PROMPT =
  "You are a knowledge graph extraction system. Extract relationships between the listed entities.";

/** JSON schema for relationship extraction (factory adds `type: object`). */
const EXTRACT_RELATIONSHIPS_SCHEMA: Record<string, unknown> = {
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
};

// ─── Initialization ─────────────────────────────────────────────

/**
 * Verify that at least one tier of the LLM cascade can serve extraction.
 *
 * Credentials and clients are owned by the _core/llm factory; this only
 * checks reachability so callers fail fast with a clear message. Per
 * SPEC.md INV-3 a reachable local Ollama model is sufficient on its own.
 */
export async function initGraphExtractor(): Promise<void> {
  if (isAnthropicAvailable() || isOpenRouterAvailable()) return;
  if (await isOllamaAvailable(intelligenceConfig())) return;
  throw new Error(
    "No graph extraction provider configured. " +
      "Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, or run Ollama with the configured local model.",
  );
}

/**
 * Reset the graph extractor state (for testing). Clears the factory's client.
 */
export function resetGraphExtractor(): void {
  resetIntelligence();
}

/**
 * Inject a custom Anthropic client into the factory (for testing with mocks).
 */
export function setGraphExtractorClient(customClient: Anthropic): void {
  setIntelligenceClient(customClient);
}

/** Cascade configuration derived from the application config. */
function intelligenceConfig(): IntelligenceConfig {
  return buildIntelligenceConfig(loadConfig());
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
 * Run entity extraction through the factory cascade.
 */
async function callEntityExtraction(
  prompt: string,
  config: IntelligenceConfig,
): Promise<{ entities: ExtractedEntity[]; model: string; tier: GraphExtractionTier }> {
  const result = await generateStructured<{ entities?: unknown[] }>(
    ENTITY_SYSTEM_PROMPT,
    prompt,
    EXTRACT_ENTITIES_SCHEMA,
    config,
    {
      toolName: EXTRACT_ENTITIES_TOOL_NAME,
      toolDescription: EXTRACT_ENTITIES_TOOL_DESCRIPTION,
    },
  );

  return {
    entities: parseEntityExtractionResponse({ entities: result.result.entities }),
    model: result.model,
    tier: cascadeTierOf(result, config),
  };
}

/**
 * Run relationship extraction through the factory cascade.
 */
async function callRelationshipExtraction(
  prompt: string,
  config: IntelligenceConfig,
  entityCount: number,
): Promise<{ relationships: ExtractedRelationship[]; model: string; tier: GraphExtractionTier }> {
  const result = await generateStructured<{ relationships?: unknown[] }>(
    RELATIONSHIP_SYSTEM_PROMPT,
    prompt,
    EXTRACT_RELATIONSHIPS_SCHEMA,
    config,
    {
      toolName: EXTRACT_RELATIONSHIPS_TOOL_NAME,
      toolDescription: EXTRACT_RELATIONSHIPS_TOOL_DESCRIPTION,
    },
  );

  return {
    relationships: parseRelationshipExtractionResponse(
      { relationships: result.result.relationships },
      entityCount,
    ),
    model: result.model,
    tier: cascadeTierOf(result, config),
  };
}

// ─── Main Extraction Entry Points ───────────────────────────────

/**
 * Extract entities from a conversation.
 *
 * Every chunk goes through the factory cascade (Ollama → OpenRouter →
 * Anthropic primary → fallback):
 * 1. Build prompt from template + metadata + exchanges
 * 2. Call LLM with structured output
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
  const config = intelligenceConfig();

  let allEntities: ExtractedEntity[] = [];
  let usedModel = config.apiModel;
  let usedTier: GraphExtractionTier = "haiku";

  for (const chunk of chunks) {
    const prompt = buildEntityExtractionPrompt(chunk, metadata);
    const result = await callEntityExtraction(prompt, config);
    allEntities.push(...result.entities);
    usedModel = result.model;
    usedTier = result.tier;
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
 * Goes through the factory cascade (Ollama → OpenRouter → Anthropic):
 * 1. Build prompt from template + entity list + exchanges
 * 2. Call LLM with structured output
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

  const result = await callRelationshipExtraction(
    prompt,
    intelligenceConfig(),
    resolvedEntities.length,
  );

  const durationMs = Date.now() - startTime;

  return {
    relationships: result.relationships,
    model: result.model,
    tier: result.tier,
    durationMs,
  };
}
