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
import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import type { Memory, MemoryType } from "./types.js";
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
  ExtractedFact,
  DeduplicationResult,
  ConflictResolution,
} from "./types.js";
import { embedDocument } from "../_core/embeddings/index.js";
import {
  findNearestMemories,
  getMemory,
  insertMemory,
  recordAccess,
  deactivateMemory,
  insertConflict,
  applyContradiction,
} from "./memory.js";
import { classifyNli } from "./nli.js";
import { collapseExact, collapseByEmbedding } from "./collapse.js";
import { applyTransientPolicy } from "./transient.js";

// ─── Module State ───────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Output budget for a conflict resolution (short structured verdict). */
const CONFLICT_MAX_TOKENS = 1024;

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
 * Verify that at least one tier of the LLM cascade can resolve conflicts.
 *
 * Credentials and clients are owned by the _core/llm factory; this only
 * checks reachability so callers fail fast with a clear message. Per
 * SPEC.md INV-3 a reachable local Ollama model is sufficient on its own.
 */
export async function initConsolidator(): Promise<void> {
  if (isAnthropicAvailable() || isOpenRouterAvailable()) return;
  if (await isOllamaAvailable(intelligenceConfig())) return;
  throw new Error(
    "No conflict resolution provider configured. " +
      "Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, or run Ollama with the configured local model.",
  );
}

/**
 * Reset the consolidator state (for testing). Clears the factory's client.
 */
export function resetConsolidator(): void {
  resetIntelligence();
}

/**
 * Inject a custom Anthropic client into the factory (for testing with mocks).
 */
export function setConsolidatorClient(customClient: Anthropic): void {
  setIntelligenceClient(customClient);
}

/** Cascade configuration derived from the application config. */
function intelligenceConfig(): IntelligenceConfig {
  return buildIntelligenceConfig(loadConfig());
}

// ─── Conflict Resolution Tool Schema ────────────────────────────

const RESOLVE_CONFLICT_TOOL_NAME = "resolve_conflict";
const RESOLVE_CONFLICT_TOOL_DESCRIPTION =
  "Resolve a memory conflict between two contradictory memories";

/** JSON schema for the resolution verdict (factory adds `type: object`). */
const RESOLVE_CONFLICT_SCHEMA: Record<string, unknown> = {
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
};

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Convert L2 distance (from sqlite-vec) to cosine similarity.
 * For unit-normalized vectors: cosine_sim = 1 - (distance^2 / 2)
 */
function distanceToCosineSim(distance: number): number {
  return 1 - (distance * distance) / 2;
}

/** Per-conversation consolidation options. */
export interface ConsolidateOptions {
  /**
   * Tenant scope inherited from the source conversation (ADR-010 / W2).
   * Novel memories are stamped with it and dedup candidates are confined to
   * it. Defaults to 'global' (Claude Code transcripts).
   */
  scope?: string;
}

/**
 * Process a batch of extracted facts through consolidation.
 *
 * W9a: candidates in the same batch are collapsed against each other before
 * any of them touches the store — first on normalised content, then on
 * embedding cosine at the auto-merge threshold. Survivors are then
 * deduplicated against the DB sequentially (order matters). The result list
 * has one entry per input fact, in input order: a collapsed member reports
 * a `merge` into whatever memory its survivor resolved to.
 */
export async function consolidateFacts(
  db: Database.Database,
  facts: ExtractedFact[],
  conversationId: string,
  options: ConsolidateOptions = {},
): Promise<DeduplicationResult[]> {
  if (facts.length === 0) return [];

  const exact = collapseExact(facts);
  const embeddings: number[][] = [];
  for (const fact of exact.survivors) {
    embeddings.push(await embedDocument(fact.content));
  }
  const near = collapseByEmbedding(exact.survivors, embeddings, AUTO_MERGE_THRESHOLD);

  const survivorResults: DeduplicationResult[] = [];
  for (let i = 0; i < near.survivors.length; i++) {
    survivorResults.push(
      await deduplicateEmbeddedFact(
        db,
        near.survivors[i],
        near.embeddings[i],
        conversationId,
        options,
      ),
    );
  }

  const results: DeduplicationResult[] = [];
  const reported = new Set<number>();
  for (let i = 0; i < facts.length; i++) {
    const survivor = near.memberOf[exact.memberOf[i]];
    const base = survivorResults[survivor];
    if (!reported.has(survivor)) {
      reported.add(survivor);
      results.push(base);
    } else {
      results.push({
        action: "merge",
        memoryId: base.memoryId,
        mergedWithId: base.memoryId,
        similarity: 1,
      });
    }
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
  options: ConsolidateOptions = {},
): Promise<DeduplicationResult> {
  // 1. Embed the fact content
  const embedding = await embedDocument(fact.content);
  return deduplicateEmbeddedFact(db, fact, embedding, conversationId, options);
}

/** Steps 2–4 of `deduplicateFact` for a fact whose embedding is already known. */
async function deduplicateEmbeddedFact(
  db: Database.Database,
  fact: ExtractedFact,
  embedding: number[],
  conversationId: string,
  options: ConsolidateOptions,
): Promise<DeduplicationResult> {
  const scope = options.scope ?? "global";

  // 2. Find nearest neighbors — within the conversation's own scope only:
  // a memory in one tenant scope must never absorb, reinforce, or be
  // deactivated by a fact from another (ADR-010). Claude Code transcripts
  // consolidate against 'global'; a hermes:<profile> conversation against
  // that profile's memories.
  const neighbors = findNearestMemories(db, embedding, 5, scope);

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
          scope,
        );
      }

      // Neutral: fall through to check next neighbor
    }
  }

  // 4. No match found — insert as novel memory
  return insertNovelMemory(db, fact, embedding, conversationId, scope);
}

// ─── Novel Memory Insertion ─────────────────────────────────────

/** Confidence stored when the extractor did not supply one (W9c). */
const DEFAULT_CONFIDENCE = 0.5;

/** Model-supplied confidence clamped to [0, 1]; 0.5 only when absent. */
function effectiveConfidence(fact: ExtractedFact): number {
  const c = fact.confidence;
  if (typeof c !== "number" || Number.isNaN(c)) return DEFAULT_CONFIDENCE;
  return Math.max(0, Math.min(1, c));
}

/**
 * Build the Memory row for a fact about to be written. Single place where
 * confidence (W9c) and the transient-status policy (W9b: importance cap +
 * short stability tier) are applied, so every insert path agrees.
 */
function memoryFromFact(
  id: string,
  fact: ExtractedFact,
  content: string,
  scope: string,
  now: number,
): Memory {
  const policy = applyTransientPolicy({ content, importance: fact.importance });
  const memory: Memory = {
    id,
    type: fact.type,
    content,
    context: fact.context,
    confidence: effectiveConfidence(fact),
    importance: policy.importance,
    accessCount: 0,
    createdAt: now,
    sourceExchanges: fact.sourceExchangeIds,
    isActive: true,
    source: "dream",
    scope,
    extractionBasis: fact.extractionBasis,
  };
  if (policy.stability !== undefined) memory.stability = policy.stability;
  return memory;
}

/**
 * Insert a new memory from a novel fact (no existing match).
 */
function insertNovelMemory(
  db: Database.Database,
  fact: ExtractedFact,
  embedding: number[],
  conversationId: string,
  scope: string,
): DeduplicationResult {
  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const memory = memoryFromFact(newId, fact, fact.content, scope, now);

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
  scope: string,
): Promise<DeduplicationResult> {
  const resolution = await callConflictResolution(existingMemory, newFact);

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  switch (resolution.action) {
    case "update": {
      // New memory supersedes old
      const newMemory = memoryFromFact(
        newId,
        newFact,
        resolution.updatedContent ?? newFact.content,
        scope,
        now,
      );

      applyContradiction(db, existingMemory.id);
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
      const newMemory = memoryFromFact(newId, newFact, newFact.content, scope, now);

      // Both stay active, but the existing memory was contradicted: persist
      // the FSRS penalty so its retrievability decays faster
      applyContradiction(db, existingMemory.id);
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
 *
 * Reads the conflict resolution prompt and runs it through the _core/llm
 * factory cascade (Ollama → OpenRouter → Anthropic primary → fallback) for
 * structured output. Model ids come from config (dream.apiModel).
 */
async function callConflictResolution(
  existingMemory: Memory,
  newFact: ExtractedFact,
): Promise<ConflictResolution> {
  const systemPrompt = loadConflictPrompt();
  const userMessage = formatConflictInput(existingMemory, newFact);

  const { result } = await generateStructured<Record<string, unknown>>(
    systemPrompt,
    userMessage,
    RESOLVE_CONFLICT_SCHEMA,
    intelligenceConfig(),
    {
      toolName: RESOLVE_CONFLICT_TOOL_NAME,
      toolDescription: RESOLVE_CONFLICT_TOOL_DESCRIPTION,
      maxTokens: CONFLICT_MAX_TOKENS,
    },
  );

  const action = normalizeAction(result.action as string);
  return {
    action,
    reasoning: (result.reasoning as string) || "No reasoning provided.",
    updatedContent:
      action === "update" ? (result.updated_content as string) : undefined,
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
let conflictPromptCache: string | null = null;

function loadConflictPrompt(): string {
  if (conflictPromptCache !== null) return conflictPromptCache;
  const promptPath = join(
    __dirname,
    "..",
    "..",
    "prompts",
    "resolve-conflict.md",
  );
  conflictPromptCache = readFileSync(promptPath, "utf-8");
  return conflictPromptCache;
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
