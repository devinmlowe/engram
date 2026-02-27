/**
 * Deduplication and conflict resolution for semantic memories.
 *
 * Processes extracted facts against the existing memory store:
 * 1. Embed each fact and find nearest neighbors
 * 2. Apply tiered similarity thresholds (auto-merge / NLI / novel)
 * 3. Resolve conflicts via LLM when NLI detects contradiction
 *
 * Phase 3, Stream D implementation.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import type { Memory, MemoryType } from "../core/types.js";
import { isOpenRouterAvailable, callOpenRouterTool } from "../core/openrouter.js";
import type {
  ExtractedFact,
  DeduplicationResult,
  ConflictResolution,
} from "./types.js";
import { embedDocument } from "../episodic/embeddings.js";
import {
  findNearestMemories,
  getMemory,
  insertMemory,
  recordAccess,
  deactivateMemory,
  insertConflict,
} from "./memory.js";
import { classifyNli } from "./nli.js";

// ─── Module State ───────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let client: Anthropic | null = null;

const CONFLICT_MODEL = "claude-haiku-4-5-20251001";

// ─── Similarity Thresholds ──────────────────────────────────────

/** Above this: auto-merge (near duplicate) */
const AUTO_MERGE_THRESHOLD = 0.95;

/** Above this: run NLI classification */
const NLI_THRESHOLD = 0.85;

/** NLI probability thresholds for classification */
const ENTAILMENT_THRESHOLD = 0.7;
const CONTRADICTION_THRESHOLD = 0.7;

// ─── Initialization ─────────────────────────────────────────────

/**
 * Initialize the conflict resolution clients.
 *
 * Creates the Anthropic client if an API key is available.
 * OpenRouter is used via the shared client when OPENROUTER_API_KEY is set.
 * At least one provider must be configured.
 */
export function initConsolidator(anthropicApiKey?: string): void {
  if (client) return;

  const apiKey = anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    client = new Anthropic({ apiKey });
  }

  if (!client && !isOpenRouterAvailable()) {
    throw new Error(
      "No conflict resolution provider configured. " +
        "Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY environment variable.",
    );
  }
}

/**
 * Reset the consolidator state (for testing).
 */
export function resetConsolidator(): void {
  client = null;
}

/**
 * Set a custom Anthropic client (for testing with mocks).
 */
export function setConsolidatorClient(customClient: Anthropic): void {
  client = customClient;
}

// ─── Conflict Resolution Tool Schema ────────────────────────────

const RESOLVE_CONFLICT_TOOL: Anthropic.Tool = {
  name: "resolve_conflict",
  description: "Resolve a memory conflict between two contradictory memories",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["update", "keep_both", "noop"],
      },
      reasoning: {
        type: "string",
        description: "Explanation for the chosen resolution",
      },
      updated_content: {
        type: "string",
        description: "Updated content for the memory (only for update action)",
      },
    },
    required: ["action", "reasoning"],
  },
};

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Convert L2 distance (from sqlite-vec) to cosine similarity.
 * For unit-normalized vectors: cosine_sim = 1 - (distance^2 / 2)
 */
function distanceToCosineSim(distance: number): number {
  return 1 - (distance * distance) / 2;
}

/**
 * Process a batch of extracted facts through consolidation.
 * Facts are processed sequentially — order matters for within-batch dedup.
 */
export async function consolidateFacts(
  db: Database.Database,
  facts: ExtractedFact[],
  conversationId: string,
): Promise<DeduplicationResult[]> {
  const results: DeduplicationResult[] = [];

  for (const fact of facts) {
    const result = await deduplicateFact(db, fact, conversationId);
    results.push(result);
  }

  return results;
}

/**
 * Deduplicate a single fact against the existing memory store.
 *
 * Algorithm:
 * 1. Embed the fact content
 * 2. Find nearest neighbors in vec_memories
 * 3. Apply tiered thresholds:
 *    - sim >= 0.95: auto-merge (record access on existing)
 *    - sim 0.85-0.95: run NLI classification
 *    - sim < 0.85: insert as novel memory
 */
export async function deduplicateFact(
  db: Database.Database,
  fact: ExtractedFact,
  conversationId: string,
): Promise<DeduplicationResult> {
  // 1. Embed the fact content
  const embedding = await embedDocument(fact.content);

  // 2. Find nearest neighbors
  const neighbors = findNearestMemories(db, embedding, 5);

  // 3. Check each neighbor against thresholds
  for (const neighbor of neighbors) {
    const similarity = distanceToCosineSim(neighbor.distance);

    // Tier 1: Auto-merge (near duplicate)
    if (similarity >= AUTO_MERGE_THRESHOLD) {
      recordAccess(db, neighbor.id);
      return {
        action: "merge",
        memoryId: neighbor.id,
        mergedWithId: neighbor.id,
        similarity,
      };
    }

    // Tier 2: NLI classification
    if (similarity >= NLI_THRESHOLD) {
      const existingMemory = getMemory(db, neighbor.id);
      if (!existingMemory) continue;

      const nliResult = await classifyNli(
        existingMemory.content,
        fact.content,
      );

      // Entailment: merge as reinforcement
      if (nliResult.entailment > ENTAILMENT_THRESHOLD) {
        recordAccess(db, neighbor.id);
        return {
          action: "merge",
          memoryId: neighbor.id,
          mergedWithId: neighbor.id,
          similarity,
        };
      }

      // Contradiction: resolve conflict
      if (nliResult.contradiction > CONTRADICTION_THRESHOLD) {
        return resolveMemoryConflict(
          db,
          existingMemory,
          fact,
          embedding,
          conversationId,
        );
      }

      // Neutral: fall through to check next neighbor
    }
  }

  // 4. No match found — insert as novel memory
  return insertNovelMemory(db, fact, embedding, conversationId);
}

// ─── Novel Memory Insertion ─────────────────────────────────────

/**
 * Insert a new memory from a novel fact (no existing match).
 */
function insertNovelMemory(
  db: Database.Database,
  fact: ExtractedFact,
  embedding: number[],
  conversationId: string,
): DeduplicationResult {
  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const memory: Memory = {
    id: newId,
    type: fact.type,
    content: fact.content,
    context: fact.context,
    confidence: 0.5,
    importance: fact.importance,
    accessCount: 0,
    createdAt: now,
    sourceExchanges: fact.sourceExchangeIds,
    isActive: true,
  };

  insertMemory(db, memory, embedding);

  return {
    action: "insert",
    memoryId: newId,
  };
}

// ─── Conflict Resolution ────────────────────────────────────────

/**
 * Resolve a contradiction between an existing memory and a new fact.
 *
 * Calls Claude Haiku with the conflict resolution prompt to classify
 * the conflict as UPDATE, KEEP_BOTH, or NOOP.
 */
async function resolveMemoryConflict(
  db: Database.Database,
  existingMemory: Memory,
  newFact: ExtractedFact,
  newEmbedding: number[],
  conversationId: string,
): Promise<DeduplicationResult> {
  const resolution = await callConflictResolution(existingMemory, newFact);

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  switch (resolution.action) {
    case "update": {
      // New memory supersedes old
      const newMemory: Memory = {
        id: newId,
        type: newFact.type,
        content: resolution.updatedContent ?? newFact.content,
        context: newFact.context,
        confidence: 0.5,
        importance: newFact.importance,
        accessCount: 0,
        createdAt: now,
        sourceExchanges: newFact.sourceExchangeIds,
        isActive: true,
      };

      deactivateMemory(db, existingMemory.id, newId);
      insertMemory(db, newMemory, newEmbedding);

      const conflictId = crypto.randomUUID();
      insertConflict(db, {
        id: conflictId,
        memoryId: newId,
        conflictingMemoryId: existingMemory.id,
        description: resolution.reasoning,
        resolution: "update",
        resolvedAt: now,
        createdAt: now,
      });

      return {
        action: "conflict",
        memoryId: newId,
        conflictId,
      };
    }

    case "keep_both": {
      // Insert new alongside existing
      const newMemory: Memory = {
        id: newId,
        type: newFact.type,
        content: newFact.content,
        context: newFact.context,
        confidence: 0.5,
        importance: newFact.importance,
        accessCount: 0,
        createdAt: now,
        sourceExchanges: newFact.sourceExchangeIds,
        isActive: true,
      };

      insertMemory(db, newMemory, newEmbedding);

      const conflictId = crypto.randomUUID();
      insertConflict(db, {
        id: conflictId,
        memoryId: newId,
        conflictingMemoryId: existingMemory.id,
        description: resolution.reasoning,
        resolution: "keep_both",
        resolvedAt: now,
        createdAt: now,
      });

      return {
        action: "conflict",
        memoryId: newId,
        conflictId,
      };
    }

    case "noop":
    default: {
      // Keep existing, discard new
      return {
        action: "skip",
        memoryId: existingMemory.id,
      };
    }
  }
}

/**
 * Call the LLM to resolve a memory conflict.
 * Reads the conflict resolution prompt and uses tool_use for structured output.
 * Prefers OpenRouter when available, falls back to Anthropic API.
 */
async function callConflictResolution(
  existingMemory: Memory,
  newFact: ExtractedFact,
): Promise<ConflictResolution> {
  const systemPrompt = loadConflictPrompt();
  const userMessage = formatConflictInput(existingMemory, newFact);

  // OpenRouter path
  if (!client && isOpenRouterAvailable()) {
    try {
      const { result } = await callOpenRouterTool<Record<string, unknown>>(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          name: RESOLVE_CONFLICT_TOOL.name,
          description: RESOLVE_CONFLICT_TOOL.description ?? "",
          parameters: RESOLVE_CONFLICT_TOOL.input_schema as Record<string, unknown>,
        },
        { maxTokens: 1024 },
      );

      const action = normalizeAction(result.action as string);
      return {
        action,
        reasoning: (result.reasoning as string) || "No reasoning provided.",
        updatedContent:
          action === "update" ? (result.updated_content as string) : undefined,
      };
    } catch {
      // Fall through to Anthropic if OpenRouter fails
    }
  }

  // Anthropic path
  if (!client) {
    throw new Error(
      "No conflict resolution provider available. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.",
    );
  }

  const response = await client.messages.create({
    model: CONFLICT_MODEL,
    max_tokens: 1024,
    tools: [RESOLVE_CONFLICT_TOOL],
    tool_choice: { type: "tool", name: "resolve_conflict" },
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  // Extract tool_use block
  const toolUseBlock = response.content.find(
    (block) => block.type === "tool_use",
  );

  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    return {
      action: "noop",
      reasoning: "LLM did not return a structured resolution.",
    };
  }

  const input = toolUseBlock.input as Record<string, unknown>;
  const action = normalizeAction(input.action as string);

  return {
    action,
    reasoning: (input.reasoning as string) || "No reasoning provided.",
    updatedContent:
      action === "update" ? (input.updated_content as string) : undefined,
  };
}

/**
 * Normalize the action string from the LLM response.
 */
function normalizeAction(
  raw: string,
): "update" | "keep_both" | "noop" {
  const lower = raw?.toLowerCase().trim();
  if (lower === "update") return "update";
  if (lower === "keep_both") return "keep_both";
  return "noop";
}

/**
 * Load the conflict resolution prompt template from disk.
 */
function loadConflictPrompt(): string {
  const promptPath = join(
    __dirname,
    "..",
    "..",
    "prompts",
    "resolve-conflict.md",
  );
  return readFileSync(promptPath, "utf-8");
}

/**
 * Format the conflict input for the LLM.
 */
function formatConflictInput(
  existingMemory: Memory,
  newFact: ExtractedFact,
): string {
  const createdDate = new Date(existingMemory.createdAt * 1000)
    .toISOString()
    .split("T")[0];

  return `**Existing memory:**
\`\`\`
Type: ${existingMemory.type}
Content: ${existingMemory.content}
Context: ${existingMemory.context ?? "none"}
Created: ${createdDate}, Access count: ${existingMemory.accessCount}
\`\`\`

**New memory:**
\`\`\`
Type: ${newFact.type}
Content: ${newFact.content}
Context: ${newFact.context ?? "none"}
Source exchanges: [${newFact.sourceExchangeIds.join(", ")}]
\`\`\``;
}
