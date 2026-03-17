/**
 * Four-stage entity resolution pipeline.
 *
 * Resolves extracted entities against the existing knowledge graph using
 * a cascading strategy: exact name match -> alias lookup -> embedding
 * similarity -> create new. Each stage is progressively more expensive.
 *
 * Phase 4, Stream D implementation.
 */

import type Database from "better-sqlite3";
import type { ExtractedEntity, EntityResolution } from "./types.js";
import {
  getEntity,
  getEntityByName,
  getEntityByAlias,
  findNearestEntities,
  insertEntity,
  recordEntityMention,
  recordEntityConversation,
  updateEntity,
} from "./entity.js";
import { embedDocument } from "../_core/embeddings/index.js";

/**
 * Resolve a single extracted entity against the knowledge graph.
 *
 * Four-stage cascading pipeline:
 * 1. Exact name match (free -- SQL lookup)
 * 2. Alias lookup (free -- SQL lookup)
 * 3. Embedding similarity (cheap -- vector search)
 * 4. Create new entity (generates embedding + inserts)
 */
export async function resolveEntity(
  db: Database.Database,
  extracted: ExtractedEntity,
  conversationId?: string,
): Promise<EntityResolution> {
  // Stage 1: Exact Name Match (free)
  const byName = getEntityByName(db, extracted.name);
  if (byName) {
    recordEntityMention(db, byName.id);
    if (conversationId) recordEntityConversation(db, byName.id, conversationId);
    return { action: "merge", entityId: byName.id, stage: "exact_name" };
  }

  // Stage 2: Alias Lookup (free)
  const byAlias = getEntityByAlias(db, extracted.name);
  if (byAlias) {
    recordEntityMention(db, byAlias.id);
    if (conversationId) recordEntityConversation(db, byAlias.id, conversationId);
    return { action: "merge", entityId: byAlias.id, stage: "alias" };
  }

  // Stage 3: Embedding Similarity (cheap)
  const embedding = await embedDocument(extracted.name);
  const neighbors = findNearestEntities(db, embedding, 5);

  for (const neighbor of neighbors) {
    // Convert L2 distance to cosine similarity: sim = 1 - (distance^2) / 2
    const similarity = 1 - (neighbor.distance * neighbor.distance) / 2;

    if (similarity >= 0.95) {
      // High confidence: auto-merge regardless of type
      recordEntityMention(db, neighbor.id);
      if (conversationId) recordEntityConversation(db, neighbor.id, conversationId);
      addAliasIfNew(db, neighbor.id, extracted.name);
      return {
        action: "merge",
        entityId: neighbor.id,
        stage: "embedding",
        similarity,
      };
    }

    if (similarity >= 0.85) {
      // Medium confidence: merge only if types match
      const existing = getEntity(db, neighbor.id);
      if (existing && existing.type === extracted.type) {
        recordEntityMention(db, neighbor.id);
        if (conversationId) recordEntityConversation(db, neighbor.id, conversationId);
        addAliasIfNew(db, neighbor.id, extracted.name);
        return {
          action: "merge",
          entityId: neighbor.id,
          stage: "embedding",
          similarity,
        };
      }
    }
  }

  // Stage 4: Create new entity
  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  insertEntity(
    db,
    {
      id: newId,
      name: extracted.name,
      type: extracted.type,
      description: extracted.description,
      aliases: [],
      firstSeen: now,
      lastSeen: now,
      mentionCount: 1,
      createdAt: now,
    },
    embedding,
  );

  if (conversationId) recordEntityConversation(db, newId, conversationId);

  return { action: "create", entityId: newId, stage: "created" };
}

/**
 * Resolve multiple extracted entities sequentially.
 *
 * Order matters: earlier resolutions create new entities that later ones
 * can merge with, enabling within-batch deduplication.
 */
export async function resolveEntities(
  db: Database.Database,
  extractedEntities: ExtractedEntity[],
  conversationId?: string,
): Promise<
  Array<{ extracted: ExtractedEntity; resolution: EntityResolution }>
> {
  const results: Array<{
    extracted: ExtractedEntity;
    resolution: EntityResolution;
  }> = [];

  for (const extracted of extractedEntities) {
    const resolution = await resolveEntity(db, extracted, conversationId);
    results.push({ extracted, resolution });
  }

  return results;
}

/**
 * Add an alias to an entity if it's not already the entity's name or
 * in its aliases list.
 */
function addAliasIfNew(
  db: Database.Database,
  entityId: string,
  alias: string,
): void {
  const entity = getEntity(db, entityId);
  if (!entity) return;

  const lowerAlias = alias.toLowerCase();
  if (entity.name.toLowerCase() === lowerAlias) return;
  if (entity.aliases.some((a) => a.toLowerCase() === lowerAlias)) return;

  updateEntity(db, entityId, {
    aliases: [...entity.aliases, alias],
  });
}
