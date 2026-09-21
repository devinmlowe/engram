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
import type { AnthropicClient as Anthropic } from "../_core/llm/index.js";
import type Database from "better-sqlite3";
import type { Memory, MemorySource, MemoryType } from "./types.js";
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
  getMemoryEmbedding,
  insertMemory,
  recordAccess,
  deactivateMemory,
  insertConflict,
  applyContradiction,
} from "./memory.js";
import { classifyNli } from "./nli.js";
import { collapseExact, collapseByEmbedding, normalizeContent } from "./collapse.js";
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

/** How far up a memory's superseded_by chain the ping-pong guard looks (W12). */
const SUPERSESSION_CHAIN_MAX_HOPS = 5;

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
  /**
   * Provenance stamped on every memory this batch inserts (novel rows and
   * conflict outcomes alike). Defaults to 'dream'; the doctor `extraction
   * smoke` check passes 'smoke' so its rows stay identifiable (#61).
   */
  source?: MemorySource;
}

/**
 * Process a batch of extracted facts through consolidation.
 *
 * W9a: candidates in the same batch are collapsed against each other before
 * any of them touches the store — first on normalised content, then on
 * embedding cosine at the auto-merge threshold. Survivors are then
 * deduplicated against the DB sequentially (order matters). The result list
 * has one entry per input fact, in input order: a collapsed member reports
 * a `merge` into whatever memory its survivor resolved to. A fact whose
 * deduplication throws is reported as `error` (with the cause) and the
 * remaining facts are still processed (#36).
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
    try {
      survivorResults.push(
        await deduplicateEmbeddedFact(
          db,
          near.survivors[i],
          near.embeddings[i],
          conversationId,
          options,
        ),
      );
    } catch (err) {
      // #36: one fact's failure (typically LLM conflict resolution) must not
      // drop the rest of the batch. Report it in place and carry on.
      survivorResults.push({
        action: "error",
        memoryId: "",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  const results: DeduplicationResult[] = [];
  const reported = new Set<number>();
  for (let i = 0; i < facts.length; i++) {
    const survivor = near.memberOf[exact.memberOf[i]];
    const base = survivorResults[survivor];
    if (!reported.has(survivor)) {
      reported.add(survivor);
      results.push(base);
    } else if (base.action === "error") {
      results.push({ ...base, collapsed: true });
    } else {
      results.push({
        action: "merge",
        memoryId: base.memoryId,
        mergedWithId: base.memoryId,
        similarity: 1,
        collapsed: true,
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
  const source = options.source ?? "dream";

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
          source,
        );
      }

      // Neutral: fall through to check next neighbor
    }
  }

  // 4. No match found — insert as novel memory
  return insertNovelMemory(db, fact, embedding, conversationId, scope, source);
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
  source: MemorySource = "dream",
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
    source,
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
  source: MemorySource = "dream",
): DeduplicationResult {
  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const memory = memoryFromFact(newId, fact, fact.content, scope, now, source);

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
  source: MemorySource = "dream",
): Promise<DeduplicationResult> {
  const now = Math.floor(Date.now() / 1000);

  // W12: refuse supersession ping-pong. If the candidate restates a memory
  // that `existingMemory` (transitively) already superseded, the existing
  // chain is authoritative — record the conflict for review, create nothing.
  const predecessor = findSupersededAncestorMatching(db, existingMemory, newFact, newEmbedding);
  if (predecessor) {
    const conflictId = crypto.randomUUID();
    insertConflict(db, {
      id: conflictId,
      memoryId: existingMemory.id,
      conflictingMemoryId: predecessor.id,
      description:
        `Supersession ping-pong refused: candidate "${newFact.content.slice(0, 120)}" ` +
        `restates memory ${predecessor.id}, which ${existingMemory.id} already superseded ` +
        `(conversation ${conversationId}).`,
      createdAt: now,
    });
    return { action: "skip", memoryId: existingMemory.id, conflictId };
  }

  const resolution = await callConflictResolution(existingMemory, newFact);

  const newId = crypto.randomUUID();

  switch (resolution.action) {
    case "update": {
      // New memory supersedes old
      const newMemory = memoryFromFact(
        newId,
        newFact,
        resolution.updatedContent ?? newFact.content,
        scope,
        now,
        source,
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
      const newMemory = memoryFromFact(newId, newFact, newFact.content, scope, now, source);

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
 * Walk `memory`'s superseded_by chain upward (the memories it replaced, and
 * theirs, …) for at most SUPERSESSION_CHAIN_MAX_HOPS hops and return the
 * first ancestor whose content matches the candidate — normalised-equal text
 * or embedding cosine at/above the auto-merge threshold.
 */
function findSupersededAncestorMatching(
  db: Database.Database,
  memory: Memory,
  fact: ExtractedFact,
  factEmbedding: number[],
): Memory | null {
  const predecessorsOf = db.prepare("SELECT id FROM memories WHERE superseded_by = ?");
  const wanted = normalizeContent(fact.content);
  const visited = new Set<string>([memory.id]);
  let frontier = [memory.id];

  for (let hop = 0; hop < SUPERSESSION_CHAIN_MAX_HOPS && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      const rows = predecessorsOf.all(id) as Array<{ id: string }>;
      for (const { id: predId } of rows) {
        if (visited.has(predId)) continue;
        visited.add(predId);
        const pred = getMemory(db, predId);
        if (!pred) continue;
        if (normalizeContent(pred.content) === wanted) return pred;
        const predEmbedding = getMemoryEmbedding(db, predId);
        if (predEmbedding && cosineSimilarity(predEmbedding, factEmbedding) >= AUTO_MERGE_THRESHOLD) {
          return pred;
        }
        next.push(predId);
      }
    }
    frontier = next;
  }
  return null;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
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
