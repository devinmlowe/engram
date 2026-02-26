/**
 * LLM-based community naming for topic clusters.
 *
 * Uses the intelligence layer (Ollama -> Claude API fallback) to generate
 * meaningful names from entity and relationship context.
 */

import type Database from "better-sqlite3";
import type { IntelligenceConfig } from "../dream/intelligence.js";
import type { CommunityNaming, CommunityResult } from "./types.js";
import { generateStructured } from "../dream/intelligence.js";

// ─── Schema ──────────────────────────────────────────────────────

/**
 * JSON schema used for structured LLM output.
 */
const NAMING_SCHEMA: Record<string, unknown> = {
  properties: {
    name: {
      type: "string",
      description: "A concise topic name (3-6 words) for this community",
    },
    description: {
      type: "string",
      description: "A 1-2 sentence description of what this community represents",
    },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "3-5 topic keywords that characterize this community",
    },
  },
  required: ["name", "description", "keywords"],
};

const SYSTEM_PROMPT = `You are a knowledge graph analyst. Given a set of entities and their relationships from a topic community, generate a meaningful topic name and description.

Rules:
- The name should be 3-6 words that capture the core theme
- The description should be 1-2 sentences explaining what this community represents
- Keywords should be 3-5 terms that characterize the community
- Be specific and descriptive, not generic`;

// ─── Helpers ─────────────────────────────────────────────────────

interface EntityRow {
  id: string;
  name: string;
  type: string;
}

interface RelationshipRow {
  type: string;
  source_name: string;
  target_name: string;
}

/**
 * Collect entity names and types for the given entity IDs.
 */
function getEntitiesForCommunity(
  db: Database.Database,
  entityIds: string[],
): EntityRow[] {
  if (entityIds.length === 0) return [];

  const placeholders = entityIds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT id, name, type FROM entities WHERE id IN (${placeholders})`,
    )
    .all(...entityIds) as EntityRow[];
}

/**
 * Collect relationship types between community members.
 */
function getRelationshipsForCommunity(
  db: Database.Database,
  entityIds: string[],
): RelationshipRow[] {
  if (entityIds.length === 0) return [];

  const placeholders = entityIds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT r.type, e1.name as source_name, e2.name as target_name
       FROM relationships r
       JOIN entities e1 ON r.source_entity_id = e1.id
       JOIN entities e2 ON r.target_entity_id = e2.id
       WHERE r.source_entity_id IN (${placeholders})
         AND r.target_entity_id IN (${placeholders})`,
    )
    .all(...entityIds, ...entityIds) as RelationshipRow[];
}

/**
 * Build the user prompt from entity and relationship context.
 */
function buildPrompt(
  entities: EntityRow[],
  relationships: RelationshipRow[],
): string {
  const entityLines = entities
    .map((e) => `- ${e.name} (${e.type})`)
    .join("\n");

  const relLines =
    relationships.length > 0
      ? relationships
          .map((r) => `- ${r.source_name} --[${r.type}]--> ${r.target_name}`)
          .join("\n")
      : "- (no internal relationships)";

  return `Community contains ${entities.length} entities:

Entities:
${entityLines}

Relationships between members:
${relLines}

Generate a topic name, description, and keywords for this community.`;
}

/**
 * Build a fallback CommunityNaming when the LLM is unavailable.
 */
function buildFallbackNaming(
  community: CommunityResult,
  entities: EntityRow[],
): CommunityNaming {
  const entityNames = entities.map((e) => e.name);
  const nameList =
    entityNames.length <= 3
      ? entityNames.join(", ")
      : `${entityNames.slice(0, 3).join(", ")} and ${entityNames.length - 3} more`;

  return {
    communityId: community.communityId,
    name: `Community ${community.communityId}`,
    description: `Auto-detected community with ${community.entityIds.length} entities: ${nameList}`,
    topicKeywords: entities.map((e) => e.name).slice(0, 5),
  };
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Generate a meaningful name and description for a single community.
 *
 * Collects entity names/types and relationship types within the community,
 * then asks the LLM to produce a 3-6 word topic name and 1-2 sentence description.
 */
export async function generateCommunityName(
  db: Database.Database,
  community: CommunityResult,
  intelligenceConfig: IntelligenceConfig,
): Promise<CommunityNaming> {
  const entities = getEntitiesForCommunity(db, community.entityIds);
  const relationships = getRelationshipsForCommunity(db, community.entityIds);

  // If no entities found in DB, return fallback immediately
  if (entities.length === 0) {
    return buildFallbackNaming(community, []);
  }

  const userPrompt = buildPrompt(entities, relationships);

  try {
    const result = await generateStructured<{
      name: string;
      description: string;
      keywords: string[];
    }>(SYSTEM_PROMPT, userPrompt, NAMING_SCHEMA, intelligenceConfig);

    return {
      communityId: community.communityId,
      name: result.result.name,
      description: result.result.description,
      topicKeywords: result.result.keywords,
    };
  } catch {
    // LLM failed — return fallback naming
    return buildFallbackNaming(community, entities);
  }
}

/**
 * Name all communities in an analysis result.
 * Processes communities sequentially to avoid overwhelming the LLM.
 */
export async function nameCommunities(
  db: Database.Database,
  communities: CommunityResult[],
  intelligenceConfig: IntelligenceConfig,
): Promise<CommunityNaming[]> {
  const results: CommunityNaming[] = [];

  for (const community of communities) {
    const naming = await generateCommunityName(
      db,
      community,
      intelligenceConfig,
    );
    results.push(naming);
  }

  return results;
}
