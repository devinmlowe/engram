/**
 * Shared remember operation — dedup + insert logic used by both CLI and MCP.
 *
 * Callers must initialize embeddings before calling rememberFact().
 * The function assumes embeddings are ready (caller handles init).
 *
 * Phase 3, Task 3.2 implementation.
 */

import type Database from "better-sqlite3";
import type { MemoryType, MemorySource } from "../../_core/types/index.js";
import { embedDocument, embedDocumentBatch } from "../../_core/embeddings/index.js";
import {
  insertMemory,
  findNearestMemories,
  recordAccess,
} from "../../semantic/memory.js";

// ─── Constants ──────────────────────────────────────────────────

/** Number of nearest neighbors to check for dedup */
const DEDUP_NEIGHBORS = 3;

/** Cosine similarity threshold for near-duplicate detection */
const DEDUP_THRESHOLD = 0.95;

/** Default confidence for user-stated facts */
const DEFAULT_CONFIDENCE = 0.9;

// ─── Types ──────────────────────────────────────────────────────

export interface RememberParams {
  content: string;
  type: MemoryType;
  importance: number;
  source?: MemorySource;
}

export interface RememberResult {
  action: "created" | "updated";
  memoryId: string;
  content: string;
}

// ─── Core Operation ─────────────────────────────────────────────

/**
 * Remember a fact with automatic near-duplicate detection.
 *
 * Pipeline:
 * 1. Embed content
 * 2. Find nearest memories (top 3)
 * 3. Convert L2 distance to cosine similarity: 1 - (distance² / 2)
 * 4. If similarity >= 0.95: recordAccess on existing, return "updated"
 * 5. Otherwise: insert new memory, return "created"
 *
 * Assumes embeddings are already initialized by the caller.
 */
export async function rememberFact(
  db: Database.Database,
  params: RememberParams,
): Promise<RememberResult> {
  // 1. Embed the content
  const embedding = await embedDocument(params.content);

  // 2. Check for near-duplicates
  const neighbors = findNearestMemories(db, embedding, DEDUP_NEIGHBORS);

  for (const neighbor of neighbors) {
    // Convert L2 distance to cosine similarity for unit vectors
    const similarity = 1 - (neighbor.distance * neighbor.distance) / 2;

    if (similarity >= DEDUP_THRESHOLD) {
      // Near-duplicate found — update existing memory
      recordAccess(db, neighbor.id);
      return {
        action: "updated",
        memoryId: neighbor.id,
        content: params.content,
      };
    }
  }

  // 3. No duplicate — insert new memory
  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  insertMemory(
    db,
    {
      id: newId,
      type: params.type,
      content: params.content,
      confidence: DEFAULT_CONFIDENCE,
      importance: params.importance,
      accessCount: 0,
      createdAt: now,
      sourceExchanges: [],
      isActive: true,
      source: params.source ?? "user",
    },
    embedding,
  );

  return {
    action: "created",
    memoryId: newId,
    content: params.content,
  };
}

// ─── Batch Types ─────────────────────────────────────────────────

export interface BatchMemoryInput {
  content: string;
  type: MemoryType;
  importance?: number;
  source?: MemorySource;
}

export interface BatchRememberResult {
  total: number;
  created: number;
  deduplicated: number;
  errors: number;
  details: Array<{
    index: number;
    status: "created" | "deduplicated" | "error";
    id?: string;
    error?: string;
  }>;
}

// ─── Batch Operation ─────────────────────────────────────────────

/** Maximum number of memories in a single batch */
const MAX_BATCH_SIZE = 50;

/** Default importance for batch items */
const DEFAULT_IMPORTANCE = 0.7;

/**
 * Store multiple memories in a single batch call with deduplication.
 *
 * Pipeline:
 * 1. Validate batch size (max 50)
 * 2. Embed all contents in a single batch call
 * 3. Process each memory through dedup pipeline
 * 4. Use transaction for atomicity
 * 5. Return aggregate results
 *
 * Assumes embeddings are already initialized by the caller.
 */
export async function storeMemoryBatch(
  db: Database.Database,
  memories: BatchMemoryInput[],
): Promise<BatchRememberResult> {
  // Handle empty batch
  if (memories.length === 0) {
    return { total: 0, created: 0, deduplicated: 0, errors: 0, details: [] };
  }

  // Validate batch size
  if (memories.length > MAX_BATCH_SIZE) {
    throw new Error(
      `Batch size ${memories.length} exceeds maximum of ${MAX_BATCH_SIZE}. ` +
        `Split into smaller batches.`,
    );
  }

  // 1. Embed all contents in one batch call
  const contents = memories.map((m) => m.content);
  const embeddings = await embedDocumentBatch(contents);

  // 2. Process each memory with dedup, wrapped in a transaction
  const result: BatchRememberResult = {
    total: memories.length,
    created: 0,
    deduplicated: 0,
    errors: 0,
    details: [],
  };

  const runBatch = db.transaction(() => {
    for (let i = 0; i < memories.length; i++) {
      const input = memories[i];
      const embedding = embeddings[i];

      try {
        // Check for near-duplicates
        const neighbors = findNearestMemories(db, embedding, DEDUP_NEIGHBORS);
        let isDuplicate = false;

        for (const neighbor of neighbors) {
          const similarity = 1 - (neighbor.distance * neighbor.distance) / 2;
          if (similarity >= DEDUP_THRESHOLD) {
            recordAccess(db, neighbor.id);
            result.deduplicated++;
            result.details.push({
              index: i,
              status: "deduplicated",
              id: neighbor.id,
            });
            isDuplicate = true;
            break;
          }
        }

        if (!isDuplicate) {
          const newId = crypto.randomUUID();
          const now = Math.floor(Date.now() / 1000);

          insertMemory(
            db,
            {
              id: newId,
              type: input.type,
              content: input.content,
              confidence: DEFAULT_CONFIDENCE,
              importance: input.importance ?? DEFAULT_IMPORTANCE,
              accessCount: 0,
              createdAt: now,
              sourceExchanges: [],
              isActive: true,
              source: input.source ?? "user",
            },
            embedding,
          );

          result.created++;
          result.details.push({
            index: i,
            status: "created",
            id: newId,
          });
        }
      } catch (err) {
        result.errors++;
        result.details.push({
          index: i,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  runBatch();

  return result;
}
