/**
 * Shared remember operation — dedup + insert logic used by both CLI and MCP.
 *
 * Callers must initialize embeddings before calling rememberFact().
 * The function assumes embeddings are ready (caller handles init).
 *
 * Phase 3, Task 3.2 implementation.
 */

import type Database from "better-sqlite3";
import type { MemoryType } from "../../_core/types/index.js";
import { embedDocument } from "../../_core/embeddings/index.js";
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
    },
    embedding,
  );

  return {
    action: "created",
    memoryId: newId,
    content: params.content,
  };
}
