#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainThread, Worker } from "node:worker_threads";
import { getDatabase } from "../../_core/db/index.js";
import {
  createToolDispatcher,
  parseTimeoutMs,
  parseWorkerCount,
  DEFAULT_WORKER_TIMEOUT_MS,
  type ToolCallContext,
  type ToolHandler,
  type ToolResult,
} from "./dispatch.js";
import { createEngramHttpServer } from "./http.js";
import { DEFAULT_MCP_PORT, parseMcpPort } from "./port.js";
import { runStdioEntry } from "./bridge.js";
import { resolveMcpToken } from "./auth.js";
import { ENGRAM_VERSION } from "../../_core/version/index.js";
import { loadConfig } from "../../_core/config/index.js";
import { updateHealthField } from "../cli/update-check.js";
import { escapeXml } from "../../_core/search/index.js";
import { initEmbeddings } from "../../_core/embeddings/index.js";
import { rememberFact, storeMemoryBatch } from "../shared/remember.js";
import { resolveCallScoping } from "./scoping.js";
import { ingestTurn, DEFAULT_TURN_SOURCE } from "../../episodic/ingest-turn.js";
import {
  forgetMemory,
  UNKNOWN_MCP_ACTOR,
  type ForgetResult,
} from "../../semantic/forget.js";
import { resolveMemoryId } from "../../semantic/inspect.js";
import { normalizeContent } from "../../semantic/collapse.js";
import { sliceShowLines, formatShowOutput } from "./show-format.js";
import { buildIntelligenceConfig } from "../../_core/llm/index.js";
import type { MemorySource } from "../../_core/types/index.js";
import {
  unifiedSearch,
  formatRecallXml,
  createOrRefineRecallSession,
  drillRecallResult,
} from "../shared/search.js";
import { exploreEntity, exploreSelective } from "../../graph/search.js";
import { formatExplore, formatReflect } from "../../graph/format.js";
import { fetchSnippets } from "../../_core/search/snippets.js";
import { scanFile } from "../../_core/search/scan.js";
import { getSessionStore } from "../../_core/search/index.js";
import { indexFileStructure } from "../../graph/file-indexer.js";
import {
  listCommitments,
  formatCommitmentsXml,
  updateCommitmentStatus,
  COMMITMENT_RESOLUTIONS,
  type CommitmentQueryStatus,
  type CommitmentStatus,
} from "../../semantic/commitments.js";
import type Database from "better-sqlite3";
import type {
  EngramConfig,
  SearchSource,
} from "../../_core/types/index.js";
import type { RelationshipType } from "../../graph/types.js";
import type { MemoryType } from "../../semantic/types.js";
import type { ReflectResult } from "../../graph/types.js";

// ─── Lazy State ────────────────────────────────────────────────

let db: Database.Database | null = null;
let config: EngramConfig | null = null;
let embeddingsReady = false;

function getDb(): Database.Database {
  if (!db) {
    config = loadConfig();
    db = getDatabase(config);
  }
  return db;
}

async function ensureEmbeddings(): Promise<void> {
  if (embeddingsReady) return;
  if (!config) config = loadConfig();
  await initEmbeddings(config);
  embeddingsReady = true;
}

/**
 * Pre-warm the embedding model with a dummy inference so the first real
 * request doesn't pay the ONNX runtime initialization cost (which can exceed
 * the 30s MCP tool-call timeout). Used by the HTTP server and by each worker.
 */
export async function warmUpEmbeddings(): Promise<void> {
  await ensureEmbeddings();
  const { embedQuery } = await import("../../_core/embeddings/index.js");
  await embedQuery("warmup");
  // The cross-encoder reranker is otherwise loaded lazily by the first recall
  // that reranks — inside that call's timeout window. Load it up front so a
  // fresh worker's first recall pays no model start-up cost. Failure is
  // non-fatal: recall degrades to the original ranking.
  if (!config) config = loadConfig();
  if (config.search.rerankEnabled && config.search.reranker.enabled) {
    const { initReranker } = await import("../../_core/search/reranker.js");
    await initReranker(config.search.reranker.model);
  }
}

// ─── Constants ──────────────────────────────────────────────────

/** Upper bound for the LLM merge inside a `remember` tool call */
const MERGE_TIMEOUT_MS = 15_000;

const VALID_MEMORY_SOURCES = ["user", "dream", "rlm", "import", "hermes-mirror"] as const satisfies readonly MemorySource[];


// ─── Input Schemas ─────────────────────────────────────────────

const ScopeParamSchema = z
  .string()
  .trim()
  .min(1, "scope must be a non-empty scope string (e.g. \"hermes:career\")");
const ReadScopesParamSchema = z
  .array(z.string().trim().min(1, "read_scopes entries must be non-empty scope strings"))
  .min(1, "read_scopes must contain at least one scope");

// The `.describe()` strings below are what ListTools advertises: every tool's
// inputSchema is generated from its zod schema (toInputSchema), so a
// description or default lives in exactly one place.
const SCOPE_READ_DESC =
  "Tenant identity for this call (e.g. \"hermes:career\"); reads " +
  "default to global + this scope. Overrides ENGRAM_SCOPE for this call only.";
const SCOPE_GRAPH_DESC =
  "Tenant identity for this call (e.g. \"hermes:career\"); derives the read default global + own";
const SCOPE_WRITE_DESC =
  "Tenant scope to stamp on this write (e.g. \"hermes:career\"). " +
  "Overrides the ENGRAM_SCOPE env default for this call only.";
const READ_SCOPES_DESC =
  "Explicit scopes to read from (e.g. [\"global\", \"hermes:career\"]). " +
  "Overrides ENGRAM_READ_SCOPES for this call only.";
const READ_SCOPES_GRAPH_DESC = `${READ_SCOPES_DESC.slice(0, -1)} (#25).`;
const REINFORCE_DESC =
  "Reinforce the semantic memories this call returns (FSRS: bumps " +
  "access_count/last_accessed and grows stability). Set false for " +
  "read-only or diagnostic callers that must not mutate the store.";
const MEMORY_SOURCES_DESC = "Source of this memory (user, dream, rlm, import, hermes-mirror)";
const RELATIONSHIP_TYPES_DESC = "Filter by relationship types";
const SESSION_ID_DESC = "Optional session ID for token budget tracking";

const MemoryTypeSchema = z.enum(["preference", "decision", "pattern", "fact", "solution", "convention"]);
const SearchSourcesSchema = z.array(z.enum(["episodic", "semantic", "graph"]));
const RelationshipTypesSchema = z
  .array(z.enum(["uses", "depends_on", "related_to", "part_of", "configured_by", "solved_by", "contains"]))
  .optional()
  .describe(RELATIONSHIP_TYPES_DESC);

const CommitmentsInputSchema = z.object({
  status: z.enum(["pending", "done", "dropped", "superseded", "all"]).optional().default("pending").describe("Lifecycle state to list"),
  include_due_within_days: z.number().min(0).max(3650).optional().describe("Only items with a due date within this many days (overdue items included)"),
  limit: z.number().int().min(1).max(500).optional().default(20).describe("Max items"),
  budget: z.number().int().min(100).max(10000).optional().default(1500).describe("Token budget for the XML response"),
  scope: ScopeParamSchema.optional().describe(SCOPE_GRAPH_DESC),
  read_scopes: ReadScopesParamSchema.optional().describe(READ_SCOPES_GRAPH_DESC),
});

const CommitmentsUpdateInputSchema = z.object({
  id: z.string().min(6, "Commitment id (or a unique prefix of at least 6 characters) is required").describe("Commitment id (from the commitments tool) or a unique prefix"),
  status: z.enum(["done", "dropped", "superseded"]).describe("Resolution"),
  superseded_by: z.string().min(6).optional().describe("Id of the commitment that replaces this one (required when status is superseded)"),
});

// Per-request tenant scoping (ADR-010 / W1). Same rules as the env path:
// trimmed, non-empty. Absent → env defaults apply.
const IngestTurnInputSchema = z.object({
  session_id: z.string().trim().min(1, "session_id is required").describe("Caller's conversation/session identifier (stable across turns)"),
  turn_index: z.number().int("turn_index must be an integer").min(0, "turn_index must be >= 0").describe("0-based position of this turn within the session"),
  scope: ScopeParamSchema.describe("Tenant scope of the conversation (e.g. \"hermes:career\")"),
  user_text: z.string().describe("The user's message for this turn"),
  assistant_text: z.string().describe("The assistant's reply for this turn"),
  tool_calls: z
    .array(
      z.object({
        name: z.string().trim().min(1, "tool_calls[].name is required"),
        input: z.unknown().optional().describe("Tool input (any JSON)"),
        output: z.unknown().optional().describe("Tool output/result summary (any JSON)"),
      }),
    )
    .optional()
    .describe("Tools invoked during the turn (input/output are truncated to 1000 chars)"),
  timestamp: z
    .string()
    .refine((v) => !Number.isNaN(new Date(v).getTime()), "timestamp must be an ISO-8601 date string")
    .optional()
    .describe("ISO-8601 time of the turn (default: now)"),
  source: z.string().trim().min(1, "source must be a non-empty label").optional().default(DEFAULT_TURN_SOURCE).describe("Platform/source label; part of the conversation key (default \"hermes\")"),
  author: z
    .object({
      id: z.string().optional().describe("Platform user id"),
      name: z.string().optional().describe("Display name"),
      is_bot: z.boolean().optional().describe("True when the author is a bot"),
    })
    .strict()
    .optional()
    .describe("Who authored the user side of the turn (stored as JSON on the exchange)"),
});

const RecallInputSchema = z.object({
  query: z.string().min(2, "Query must be at least 2 characters"),
  scope: ScopeParamSchema.optional().describe(SCOPE_READ_DESC),
  read_scopes: ReadScopesParamSchema.optional().describe(READ_SCOPES_DESC),
  budget: z.number().int().min(100).max(5000).optional().default(1500).describe("Max tokens in response"),
  after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional()
    .describe("Only results after this date (YYYY-MM-DD)"),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional()
    .describe("Only results before this date (YYYY-MM-DD; that day is excluded)"),
  dateHint: z.string().trim().min(1).max(200).optional().describe(
    "Natural-language date window, resolved in UTC: today, yesterday, " +
    "this/last week|month|year, N days|weeks|months ago, this day last year, " +
    "in <month>, <month> <year>, since <phrase>, before <phrase>, " +
    "on this day (same month/day across all years), or an ISO date/month. " +
    "Explicit after/before take precedence over the hint. Unrecognized " +
    "hints apply no filter and are reported in <date_filter note>.",
  ),
  dateBasis: z.enum(["filed", "event"]).optional().default("filed").describe(
    "What the dates refer to: 'filed' = when the memory was recorded " +
    "(memories IN March); 'event' = when the described events happened, " +
    "via source-exchange timestamps (memories ABOUT March). Episodic " +
    "results are identical under both.",
  ),
  depth: z.enum(["shallow", "deep"]).optional().default("shallow"),
  sources: SearchSourcesSchema.optional().default(["episodic", "semantic"]).describe("Which memory stores to search. Defaults to episodic and semantic."),
  reinforce: z.boolean().optional().default(true).describe(REINFORCE_DESC),
});

const RememberInputSchema = z.object({
  content: z.string().min(1, "Content is required").describe("The fact, preference, or knowledge to remember"),
  scope: ScopeParamSchema.optional().describe(SCOPE_WRITE_DESC),
  type: MemoryTypeSchema.optional().default("fact").describe("Type of memory"),
  importance: z.number().min(0).max(1).optional().default(0.7).describe("Importance score (0-1)"),
  source: z.enum(VALID_MEMORY_SOURCES).optional().default("user").describe(MEMORY_SOURCES_DESC),
  context: z.string().trim().max(500, "context must be at most 500 characters").optional().describe("Provenance note stored alongside the memory (e.g. what produced this write)"),
});

const RememberBatchInputSchema = z.object({
  memories: z.array(z.object({
    content: z.string().min(1, "Content is required").describe("The fact, preference, or knowledge to remember"),
    type: MemoryTypeSchema.optional().default("fact").describe("Type of memory"),
    importance: z.number().min(0).max(1).optional().describe("Importance score (0-1)"),
    source: z.enum(VALID_MEMORY_SOURCES).optional().describe(MEMORY_SOURCES_DESC),
    context: z.string().trim().max(500, "context must be at most 500 characters").optional().describe("Provenance note stored alongside the memory"),
    relates_to_entities: z.array(z.string()).max(10).optional().describe(
      "Entity names to link this memory to. Bumps mention counts " +
      "and creates pairwise related_to relationships between entities.",
    ),
  }).strict()).min(1, "At least one memory is required").max(50, "Maximum batch size is 50").describe("Array of memories to store (max 50)"),
  scope: ScopeParamSchema.optional().describe(SCOPE_WRITE_DESC),
});

const ShowInputSchema = z.object({
  path: z.string().min(1, "Path is required"),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

const ExploreInputSchema = z.object({
  entity: z.string().min(1, "Entity name is required").describe("Entity name to explore (e.g., 'TypeScript', 'engram', 'SQLite')"),
  depth: z.number().int().min(1).max(3).optional().default(1).describe("Number of hops to traverse (1-3)"),
  limit: z.number().int().min(1).max(50).optional().default(25).describe("Max neighbors to return, sorted by weight (1-50)"),
  budget: z.number().int().min(100).max(5000).optional().default(1500).describe("Max tokens in response"),
  relationship_types: RelationshipTypesSchema,
  scope: ScopeParamSchema.optional().describe(SCOPE_GRAPH_DESC),
  read_scopes: ReadScopesParamSchema.optional().describe(READ_SCOPES_GRAPH_DESC),
});

const RecallSessionInputSchema = z.object({
  query: z.string().min(2, "Query must be at least 2 characters").describe("Search query"),
  scope: ScopeParamSchema.optional().describe(SCOPE_READ_DESC),
  read_scopes: ReadScopesParamSchema.optional().describe(READ_SCOPES_DESC),
  session_id: z.string().uuid().optional().describe("Existing session ID to refine (omit to create new)"),
  budget: z.number().int().min(100).max(10000).optional().default(3000).describe("Max total token budget for this session"),
  sources: SearchSourcesSchema.optional().default(["episodic", "semantic"]).describe("Which memory stores to search"),
  reinforce: z.boolean().optional().default(true).describe(REINFORCE_DESC),
});

const RecallDrillInputSchema = z.object({
  session_id: z.string().uuid("Invalid session ID").describe("Session ID from recall_session"),
  result_index: z.number().int().min(0, "Result index must be >= 0").describe("0-based index into session results"),
  reinforce: z.boolean().optional().default(true).describe(REINFORCE_DESC),
});

const ExploreSelectiveInputSchema = z.object({
  entity: z.string().min(1, "Entity name is required").describe("Starting entity name (e.g., 'TypeScript', 'engram', 'SQLite')"),
  criteria: z.string().min(1, "Criteria is required").describe("What makes a neighbor relevant (e.g., 'build tooling', 'performance optimization')"),
  max_depth: z.number().int().min(1).max(5).optional().default(3).describe("Maximum traversal depth (1-5)"),
  max_nodes: z.number().int().min(1).max(50).optional().default(50).describe("Safety cap on total nodes returned (1-50)"),
  relationship_types: RelationshipTypesSchema,
  scope: ScopeParamSchema.optional().describe(SCOPE_GRAPH_DESC),
  read_scopes: ReadScopesParamSchema.optional().describe(READ_SCOPES_GRAPH_DESC),
});

const ReflectInputSchema = z.object({
  mode: z.enum(["communities", "bridges", "temporal", "health", "all"]).optional().default("all").describe("What to reflect on."),
  refresh: z.boolean().optional().default(false).describe("Force a fresh analysis instead of using cached results."),
});

const FetchSnippetsInputSchema = z.object({
  path: z.string().min(1, "Path is required"),
  ranges: z.array(z.object({
    start: z.number().int().min(1),
    end: z.number().int().min(1),
  })).min(1).max(20).describe("Line ranges to fetch (max 20)"),
  context: z.number().int().min(0).max(50).optional().default(0).describe("Number of padding lines around each range (0-50)"),
  session_id: z.string().uuid().optional().describe(SESSION_ID_DESC),
});

const ScanFileInputSchema = z.object({
  path: z.string().min(1, "Path is required").describe("Absolute path to the file to scan"),
  patterns: z.array(z.string()).min(1, "At least one pattern is required").max(10, "Maximum 10 patterns allowed").describe("Regex patterns to search for (max 10)"),
  context_lines: z.number().int().min(0).max(10).optional().default(2).describe("Lines of context before and after each match (0-10)"),
  group_by: z.enum(["pattern", "location"]).optional().default("location").describe("Order results by file location or grouped by pattern"),
  max_matches: z.number().int().min(1).max(500).optional().default(100).describe("Maximum matches to return (1-500)"),
  deduplicate_overlaps: z.boolean().optional().default(true).describe("Merge overlapping context windows to avoid duplicate lines"),
  session_id: z.string().uuid().optional().describe(SESSION_ID_DESC),
});

const IndexFileStructureInputSchema = z.object({
  path: z.string().min(1, "Path is required").describe("Absolute path to the source file to index"),
});

// #55: exactly one of memory_id / query. Query mode only acts with
// confirm: true AND an unambiguous single match (see handleForget).
const ForgetInputSchema = z
  .object({
    memory_id: z.string().trim().min(6, "memory_id must be a memory id (or a unique prefix of at least 6 characters)").optional().describe("Id of the memory to forget (from recall's <semantic id>), or a unique prefix of 6+ characters"),
    query: z.string().trim().min(2, "query must be at least 2 characters").optional().describe("Find candidate memories instead of naming one; returns ids, deletes nothing unless confirm + a single match"),
    confirm: z.boolean().optional().default(false).describe("In query mode: forget the match when exactly one memory matches"),
    hard: z.boolean().optional().default(false).describe("Delete the row outright instead of the soft delete + retention purge"),
    scope: ScopeParamSchema.optional().describe(
      "Tenant identity for this call (e.g. \"hermes:career\"); reads default to " +
      "global + this scope. \"global\" acts on a memory in any scope.",
    ),
    read_scopes: ReadScopesParamSchema.optional().describe("Scopes this call may act on (e.g. [\"global\", \"hermes:career\"]). Overrides ENGRAM_READ_SCOPES for this call only."),
  })
  .strict()
  .refine((v) => (v.memory_id !== undefined) !== (v.query !== undefined), {
    message: "Pass exactly one of memory_id or query",
  });

/**
 * JSON Schema for ListTools, generated from the zod input schema (io: "input",
 * so defaulted fields stay optional). Dropped as noise: the `$schema` marker,
 * the safe-integer bounds zod adds to every unbounded `.int()`, and the regex
 * it repeats next to `format: "uuid"`. The top-level object is closed the way
 * every hand-written schema was — the validator still strips unknown keys
 * (Hermes' warm-up recall sends `limit`).
 */
function toInputSchema(schema: z.ZodType): Tool["inputSchema"] {
  const json = JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: "input" })), function (this: Record<string, unknown>, key, value) {
    if (key === "$schema") return undefined;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) return undefined;
    if (key === "minimum" && value === -Number.MAX_SAFE_INTEGER) return undefined;
    if (key === "pattern" && this.format === "uuid") return undefined;
    return value;
  });
  return { ...json, additionalProperties: false };
}

/** Candidates returned by forget's query mode before anything is deleted. */
const FORGET_CANDIDATE_LIMIT = 10;

// ─── Server Setup ──────────────────────────────────────────────

const server = new Server(
  { name: "engram", version: ENGRAM_VERSION },
  { capabilities: { tools: {} } },
);

/**
 * Register all MCP tool handlers on a Server instance.
 * Used by both the stdio server and the per-session HTTP server.
 *
 * `callTool` decides where a tool executes: inline on this thread (stdio
 * mode, the historical behaviour) or via the worker-pool dispatcher (HTTP
 * mode). The list-tools handler always runs on the calling thread.
 */
/**
 * The tools the server advertises (ListTools). Exported so tests can pin
 * names, descriptions and annotations without a transport.
 *
 * Annotation policy (#22): retrieval tools keep `readOnlyHint: true` even
 * though recall reinforces returned memories. Reinforcement is FSRS
 * bookkeeping only (access_count, last_accessed, stability) — it never
 * creates, edits or deletes a memory or changes its content — and flipping
 * the hint would make MCP clients prompt for approval on every recall.
 * `reinforce: false` opts out per call.
 */
interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  annotations: Tool["annotations"];
}

export const MCP_TOOL_DEFINITIONS: Tool[] = ([
  {
    name: "recall",
    description:
      "Retrieve relevant memories from past Claude Code conversations and " +
      "extracted knowledge. Uses hybrid semantic + keyword search with " +
      "token-budgeted output across episodic and semantic memory stores. " +
      "Search BEFORE every task to recover decisions, solutions, and context. " +
      "Time-scope with after/before (YYYY-MM-DD) or a natural-language dateHint " +
      "(\"last week\", \"in March\", \"this day last year\", \"on this day\"); " +
      "dateBasis picks whether dates mean when a memory was filed or when the " +
      "events it describes happened. The applied window is echoed in <date_filter>. " +
      "Retrieval records access bookkeeping on the returned memories (access_count, last_accessed, stability); " +
      "pass reinforce: false to opt out.",
    schema: RecallInputSchema,
    annotations: {
      title: "Recall Memories",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "remember",
    description:
      "Store a fact, preference, decision, or other knowledge as a semantic " +
      "memory. Use this to explicitly record important information that should " +
      "persist across conversations. Automatically deduplicates against " +
      "existing memories.",
    schema: RememberInputSchema,
    annotations: {
      title: "Remember",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "remember_batch",
    description:
      "Store multiple facts, preferences, decisions, or other knowledge items " +
      "as semantic memories in a single call. Supports up to 50 items per batch. " +
      "Automatically deduplicates against existing memories and within the batch. " +
      "Use for bulk ingestion from RLM agents or dream pipeline. Optionally link " +
      "each memory to existing graph entities via relates_to_entities.",
    schema: RememberBatchInputSchema,
    annotations: {
      title: "Batch Remember",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "show",
    description:
      "Read full conversations to extract detailed context after " +
      "finding relevant results with recall. Use startLine/endLine " +
      "pagination for large conversations.",
    schema: ShowInputSchema,
    annotations: {
      title: "Show Conversation",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "explore",
    description:
      "Explore connections in the knowledge graph starting from an entity. " +
      "Shows what a concept, tool, project, or technology is connected to. " +
      "Use after recall to understand how things relate to each other.",
    schema: ExploreInputSchema,
    annotations: {
      title: "Explore Knowledge Graph",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "reflect",
    description:
      "View emergent patterns and structure in the knowledge graph. " +
      "Shows topic communities with meaningful names, bridge entities " +
      "connecting different domains, temporal patterns, and graph health. " +
      "Use after working on a topic to understand how it connects to " +
      "other knowledge domains.",
    schema: ReflectInputSchema,
    annotations: {
      title: "Reflect on Knowledge Graph",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "recall_session",
    description:
      "Create or continue an iterative search session for multi-step memory " +
      "exploration. Omit session_id to start a new session; provide session_id " +
      "to refine with a new query. Sessions track accumulated results and " +
      "remaining token budget. Use recall_drill to expand individual results. " +
      "Retrieval records access bookkeeping on the returned memories (access_count, last_accessed, stability); " +
      "pass reinforce: false to opt out.",
    schema: RecallSessionInputSchema,
    annotations: {
      title: "Recall Session",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "recall_drill",
    description:
      "Drill into a specific result from a recall session to get expanded " +
      "context. For episodic results: shows surrounding conversation exchanges. " +
      "For semantic results: shows source conversation segments. " +
      "For graph results: shows entity with full relationship neighborhood. " +
      "Retrieval records access bookkeeping on the returned memories (access_count, last_accessed, stability); " +
      "pass reinforce: false to opt out.",
    schema: RecallDrillInputSchema,
    annotations: {
      title: "Drill Into Result",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "explore_selective",
    description:
      "Explore the knowledge graph selectively by expanding only branches " +
      "relevant to specified criteria. Unlike explore (fixed-depth BFS), this " +
      "uses embedding similarity to prune irrelevant neighbors and recursively " +
      "follows only relevant paths. Use when you want to find connections related " +
      "to a specific topic or question.",
    schema: ExploreSelectiveInputSchema,
    annotations: {
      title: "Selective Graph Exploration",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "fetch_snippets",
    description:
      "Fetch multiple line ranges from a single file in one call. Ranges are " +
      "merged when overlapping, padded with optional context lines, and joined " +
      "with gap markers. More efficient than multiple show calls for targeted " +
      "code reading.",
    schema: FetchSnippetsInputSchema,
    annotations: {
      title: "Fetch Snippets",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "scan_file",
    description:
      "Scan a file server-side with regex patterns and return structured matches " +
      "with surrounding context. The file is read on the server and never loaded " +
      "into conversation context. Supports multiple patterns, context windows, " +
      "overlap deduplication, and function context detection.",
    schema: ScanFileInputSchema,
    annotations: {
      title: "Scan File",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "index_file_structure",
    description:
      "Parse a source file to extract function, class, and module definitions, " +
      "then index them as entities in the knowledge graph with 'contains' relationships. " +
      "Enables RLM to discover file contents without reading the full file.",
    schema: IndexFileStructureInputSchema,
    annotations: {
      title: "Index File Structure",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "commitments",
    description:
      "List tracked commitments — first-person promises, intentions and " +
      "follow-ups owed by others, extracted nightly from conversations " +
      "(\"mention once, never dropped\"). Default: pending items, overdue " +
      "first, then by due date, then newest. Use include_due_within_days to " +
      "surface only what is due soon or overdue.",
    schema: CommitmentsInputSchema,
    annotations: {
      title: "Commitments",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "commitments_update",
    description:
      "Resolve a tracked commitment once the user confirms it is handled: " +
      "mark it done, dropped, or superseded by another commitment. Accepts " +
      "the full id or a unique prefix (6+ characters).",
    schema: CommitmentsUpdateInputSchema,
    annotations: {
      title: "Update Commitment",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "ingest_turn",
    description:
      "Record one user/assistant turn of an external agent conversation " +
      "(e.g. a Hermes profile) in engram's episodic layer so it becomes " +
      "searchable and feeds the nightly dream extraction. Idempotent: " +
      "re-sending the same session_id + turn_index updates the turn in " +
      "place. The conversation carries the given tenant scope, and every " +
      "memory later extracted from it inherits that scope. An optional " +
      "author {id, name, is_bot} is stored on the turn.",
    schema: IngestTurnInputSchema,
    annotations: {
      title: "Ingest Turn",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "forget",
    description:
      "Remove a memory the user says is wrong or stale. Pass the memory_id " +
      "from a recall result (<semantic id=\"…\">) to forget it in one call. " +
      "Pass query instead to search for candidates: the tool returns matching " +
      "memories with their ids and forgets nothing unless confirm is true AND " +
      "exactly one memory matches (a single result, or a single result whose " +
      "content equals the query). The memory is soft-deleted (kept for " +
      "ENGRAM_FORGET_RETENTION_DAYS, then purged by the dream pipeline), drops " +
      "out of every recall path immediately, is logged in the change log with " +
      "this client's name, and will not be re-extracted from the same " +
      "conversation. hard: true deletes it outright. Only memories within " +
      "read_scopes can be forgotten unless scope is \"global\".",
    schema: ForgetInputSchema,
    annotations: {
      title: "Forget Memory",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] satisfies ToolSpec[]).map(({ schema, ...tool }) => ({ ...tool, inputSchema: toInputSchema(schema) }));
/**
 * Exported so tests can drive a real `Server` over an in-memory transport
 * (stdio-equivalent) and over the HTTP front end.
 */
export function registerToolHandlers(srv: Server, callTool: ToolHandler = handleToolCall) {
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOL_DEFINITIONS,
  }));

  // ─── Tool Handlers ─────────────────────────────────────────────

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // The client's `clientInfo.name` from the initialize handshake is the
    // actor recorded by `forget` (#55). Read per call: each HTTP session has
    // its own Server, and stdio has exactly one client.
    const clientName = srv.getClientVersion()?.name?.trim() || undefined;
    return callTool(name, args, clientName ? { clientName } : undefined);
  });
}  // end registerToolHandlers

/**
 * Execute one MCP tool call on the current thread and return its result.
 * Never throws: every failure is reported as an `isError` result. This is
 * the unit of work the worker pool ships to worker threads.
 */
export async function handleToolCall(name: string, args: unknown, context?: ToolCallContext): Promise<ToolResult> {
  try {
    if (name === "forget") {
      return await handleForget(ForgetInputSchema.parse(args ?? {}), context);
    }

    if (name === "recall") {
      const params = RecallInputSchema.parse(args);
      await ensureEmbeddings();

      if (!config) config = loadConfig();
      const scoping = resolveCallScoping(process.env, params);
      const response = await unifiedSearch(getDb(), {
        query: params.query,
        sources: (params.sources ?? ["episodic", "semantic"]) as SearchSource[],
        mode: "hybrid",
        budget: params.budget ?? 1500,
        after: params.after,
        before: params.before,
        dateHint: params.dateHint,
        dateBasis: params.dateBasis,
        depth: params.depth ?? "shallow",
        scopes: scoping.readScopes,
        reinforce: params.reinforce,
      }, config);
      const xml = formatRecallXml(response);

      return {
        content: [{ type: "text", text: xml }],
      };
    }

    if (name === "remember") {
      const params = RememberInputSchema.parse(args);
      await ensureEmbeddings();

      if (!config) config = loadConfig();
      const result = await rememberFact(
        getDb(),
        {
          content: params.content,
          type: params.type as MemoryType,
          importance: params.importance,
          source: params.source as MemorySource,
          context: params.context || undefined,
          scope: resolveCallScoping(process.env, params).writeScope,
        },
        // The merge runs inside a synchronous tool call; the dream pipeline's
        // 120s generation timeout is far too long to block the agent on
        { intelligence: { ...buildIntelligenceConfig(config), timeoutMs: MERGE_TIMEOUT_MS } },
      );

      if (result.action === "merged") {
        return {
          content: [
            {
              type: "text",
              text: `Merged with existing memory ${result.memoryId}: ${result.content}`,
            },
          ],
        };
      }

      if (result.action === "updated") {
        return {
          content: [
            {
              type: "text",
              text: `Updated existing memory: ${result.memoryId}`,
            },
          ],
        };
      }

      return {
        content: [
          { type: "text", text: `Remembered: ${params.content}` },
        ],
      };
    }

    if (name === "remember_batch") {
      const params = RememberBatchInputSchema.parse(args);
      await ensureEmbeddings();

      const batchInput = params.memories.map((m) => ({
        content: m.content,
        type: m.type as MemoryType,
        importance: m.importance,
        source: m.source as MemorySource | undefined,
        context: m.context || undefined,
        relates_to_entities: m.relates_to_entities,
      }));

      const result = await storeMemoryBatch(getDb(), batchInput, {
        scope: resolveCallScoping(process.env, params).writeScope,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              total: result.total,
              created: result.created,
              deduplicated: result.deduplicated,
              errors: result.errors,
              entitiesLinked: result.entitiesLinked,
              details: result.details,
            }, null, 2),
          },
        ],
      };
    }

    if (name === "show") {
      const params = ShowInputSchema.parse(args);

      if (!existsSync(params.path)) {
        throw new Error(`File not found: ${params.path}`);
      }

      const content = readFileSync(params.path, "utf-8");
      const { lines, firstLineNum } = sliceShowLines(content, params.startLine, params.endLine);

      // Format JSONL lines as readable markdown
      const formatted = formatShowOutput(lines, firstLineNum);

      return {
        content: [{ type: "text", text: formatted }],
      };
    }

    if (name === "explore") {
      const params = ExploreInputSchema.parse(args);

      const result = exploreEntity(getDb(), {
        entity: params.entity,
        depth: params.depth,
        limit: params.limit,
        relationshipTypes: params.relationship_types as
          | RelationshipType[]
          | undefined,
        scopes: resolveCallScoping(process.env, params).readScopes,
      });

      return {
        content: [{ type: "text", text: formatExplore(result, "xml", params.budget) }],
      };
    }

    if (name === "recall_session") {
      const params = RecallSessionInputSchema.parse(args);
      await ensureEmbeddings();

      if (!config) config = loadConfig();
      const result = await createOrRefineRecallSession(
        getDb(),
        {
          query: params.query,
          sessionId: params.session_id,
          budget: params.budget,
          sources: params.sources as SearchSource[] | undefined,
          scopes: resolveCallScoping(process.env, params).readScopes,
          reinforce: params.reinforce,
        },
        config,
      );

      const xml = formatRecallXml({
        results: result.results,
        tokensUsed: result.results.reduce((sum, r) => sum + r.tokenEstimate, 0),
        totalResults: result.resultCount,
        query: params.query,
      });

      const qm = result.qualityMetrics;
      const sessionMeta = `<session id="${result.sessionId}" budget_remaining="${result.budgetRemaining}" result_count="${result.resultCount}" avg_score="${qm.averageScore.toFixed(3)}" recommend="${qm.recommendAction}" />`;

      return {
        content: [{ type: "text", text: `${sessionMeta}\n${xml}` }],
        sessionId: result.sessionId,
      };
    }

    if (name === "recall_drill") {
      const params = RecallDrillInputSchema.parse(args);

      const result = await drillRecallResult(
        getDb(),
        params.session_id,
        params.result_index,
        { reinforce: params.reinforce },
      );

      const lines: string[] = [];
      lines.push(`<engram_drill result_id="${escapeXml(result.resultId)}">`);
      lines.push(`  <content>${escapeXml(result.drill.content)}</content>`);

      if (result.drill.before.length > 0) {
        lines.push("  <context_before>");
        for (const item of result.drill.before) {
          lines.push(`    <exchange>${escapeXml(item)}</exchange>`);
        }
        lines.push("  </context_before>");
      }

      if (result.drill.after.length > 0) {
        lines.push("  <context_after>");
        for (const item of result.drill.after) {
          lines.push(`    <exchange>${escapeXml(item)}</exchange>`);
        }
        lines.push("  </context_after>");
      }

      if (result.drill.relatedEntities.length > 0) {
        lines.push("  <related_entities>");
        for (const entity of result.drill.relatedEntities) {
          const desc = entity.description ? ` description="${escapeXml(entity.description)}"` : "";
          lines.push(`    <entity name="${escapeXml(entity.name)}" type="${escapeXml(entity.type)}"${desc} />`);
        }
        lines.push("  </related_entities>");
      }

      if (result.drill.suggestions.length > 0) {
        lines.push("  <suggestions>");
        for (const suggestion of result.drill.suggestions) {
          lines.push(`    <suggestion>${escapeXml(suggestion)}</suggestion>`);
        }
        lines.push("  </suggestions>");
      }

      lines.push("</engram_drill>");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }

    if (name === "explore_selective") {
      const params = ExploreSelectiveInputSchema.parse(args);
      await ensureEmbeddings();

      const result = await exploreSelective(getDb(), {
        entityName: params.entity,
        criteria: params.criteria,
        maxDepth: params.max_depth,
        maxNodes: params.max_nodes,
        relationshipTypes: params.relationship_types as
          | RelationshipType[]
          | undefined,
        scopes: resolveCallScoping(process.env, params).readScopes,
      });

      // Format as JSON (selective explore results are richer than XML can cleanly express)
      const output = {
        center: result.center,
        nodes: result.nodes.map((n) => ({
          name: n.entity.name,
          type: n.entity.type,
          description: n.entity.description,
          depth: n.depth,
          relevance: Number(n.relevanceScore.toFixed(3)),
          path: n.path,
        })),
        edges: result.edges.map((e) => ({
          source: e.source,
          target: e.target,
          type: e.relationship,
          weight: Number(e.weight.toFixed(2)),
        })),
        pruned_count: result.pruned,
        summary: `Found ${result.nodes.length} relevant nodes (pruned ${result.pruned}) from "${result.center.name}" matching criteria "${params.criteria}"`,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    }

    if (name === "fetch_snippets") {
      const params = FetchSnippetsInputSchema.parse(args);

      const result = fetchSnippets({
        path: params.path,
        ranges: params.ranges,
        context: params.context,
        session_id: params.session_id,
      });

      // Deduct from session budget if session_id provided
      if (params.session_id) {
        const store = getSessionStore();
        const session = store.get(params.session_id);
        if (session) {
          session.totalBudgetUsed += result.tokenEstimate;
        }
      }

      return {
        content: [{ type: "text", text: result.content }],
        metadata: {
          totalLines: result.totalLines,
          rangesCovered: result.rangesCovered,
          tokenEstimate: result.tokenEstimate,
        },
      };
    }

    if (name === "reflect") {
      const params = ReflectInputSchema.parse(args);
      const database = getDb();

      let result: ReflectResult | null;

      {
        const { runReflection, buildReflectResultFromCache } = await import("../../graph/reflection.js");
        result = params.refresh
          ? await runReflection(database, config ?? (config = loadConfig()))
          : buildReflectResultFromCache(database);
      }

      if (!result) {
        return {
          content: [{
            type: "text",
            text: `<engram_reflection mode="${params.mode}">\n  <status>No reflection data available. Run 'engram dream --phase reflect' first.</status>\n</engram_reflection>`,
          }],
        };
      }

      return { content: [{ type: "text", text: formatReflect(result, params.mode, "xml") }] };
    }

    if (name === "scan_file") {
      const params = ScanFileInputSchema.parse(args);

      const result = scanFile({
        path: params.path,
        patterns: params.patterns,
        context_lines: params.context_lines,
        group_by: params.group_by,
        max_matches: params.max_matches,
        deduplicate_overlaps: params.deduplicate_overlaps,
        session_id: params.session_id,
      });

      // Deduct from session budget if session_id provided
      if (params.session_id) {
        const store = getSessionStore();
        const session = store.get(params.session_id);
        if (session) {
          session.totalBudgetUsed += result.tokenEstimate;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: result.path,
              totalLines: result.totalLines,
              totalMatches: result.totalMatches,
              matchesByPattern: result.matchesByPattern,
              truncated: result.truncated,
              tokenEstimate: result.tokenEstimate,
              patternErrors: result.patternErrors,
              matches: result.matches,
            }, null, 2),
          },
        ],
      };
    }

    if (name === "index_file_structure") {
      const params = IndexFileStructureInputSchema.parse(args);
      const result = indexFileStructure(getDb(), params.path);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === "commitments") {
      const params = CommitmentsInputSchema.parse(args ?? {});
      const result = listCommitments(getDb(), {
        status: (params.status ?? "pending") as CommitmentQueryStatus,
        dueWithinDays: params.include_due_within_days,
        limit: params.limit ?? 20,
        scopes: resolveCallScoping(process.env, params).readScopes,
      });
      return {
        content: [{ type: "text", text: formatCommitmentsXml(result, { budget: params.budget ?? 1500 }) }],
      };
    }

    if (name === "commitments_update") {
      const params = CommitmentsUpdateInputSchema.parse(args);
      if (!COMMITMENT_RESOLUTIONS.includes(params.status as CommitmentStatus)) {
        throw new Error(`Invalid status: ${params.status}`);
      }
      const updated = updateCommitmentStatus(getDb(), params.id, params.status as CommitmentStatus, {
        supersededBy: params.superseded_by,
      });
      const suffix = updated.supersededBy ? ` (superseded by ${updated.supersededBy})` : "";
      return {
        content: [
          { type: "text", text: `Commitment ${updated.id} marked ${updated.status}${suffix}: ${updated.content}` },
        ],
      };
    }

    if (name === "ingest_turn") {
      const params = IngestTurnInputSchema.parse(args);
      await ensureEmbeddings();

      const result = await ingestTurn(getDb(), {
        sessionId: params.session_id,
        turnIndex: params.turn_index,
        scope: resolveCallScoping(process.env, { scope: params.scope }).writeScope as string,
        userText: params.user_text,
        assistantText: params.assistant_text,
        toolCalls: params.tool_calls,
        timestamp: params.timestamp,
        source: params.source,
        author: params.author,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                conversationId: result.conversationId,
                exchangeId: result.exchangeId,
                created: result.created,
                exchangeCount: result.exchangeCount,
                scope: result.scope,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`,
        },
      ],
      isError: true,
    };
  }
}  // end handleToolCall

// ─── Forget (#55) ───────────────────────────────────────────────

type ForgetParams = z.infer<typeof ForgetInputSchema>;

/**
 * `forget` handler. `memory_id` acts directly. `query` runs the same semantic
 * search recall uses (no reinforcement) and returns candidates; it acts only
 * when `confirm` is set and the query is unambiguous — one result, or one
 * result whose normalised content equals the normalised query — so an agent
 * can never delete on a weak match.
 */
async function handleForget(params: ForgetParams, context?: ToolCallContext): Promise<ToolResult> {
  const actor = context?.clientName ?? UNKNOWN_MCP_ACTOR;
  const scoping = resolveCallScoping(process.env, params);
  const db = getDb();

  const act = (memoryId: string): ToolResult => {
    const result = forgetMemory(db, {
      memoryId,
      actor,
      hard: params.hard,
      readScopes: scoping.readScopes,
      scope: params.scope,
    });
    return { content: [{ type: "text", text: formatForgottenXml(result, actor) }] };
  };

  if (params.memory_id !== undefined) {
    const id = resolveMemoryId(db, params.memory_id);
    if (!id) throw new Error(`Memory not found: ${params.memory_id}`);
    return act(id);
  }

  const query = params.query as string;
  await ensureEmbeddings();
  if (!config) config = loadConfig();
  const response = await unifiedSearch(
    db,
    {
      query,
      sources: ["semantic"],
      mode: "hybrid",
      limit: FORGET_CANDIDATE_LIMIT,
      budget: 4000,
      scopes: params.scope === "global" ? undefined : scoping.readScopes,
      reinforce: false,
    },
    config,
  );
  const candidates = response.results.filter((r) => r.source === "semantic");
  const wanted = normalizeContent(query);
  const exact = candidates.filter((c) => normalizeContent(c.content) === wanted);
  const match = candidates.length === 1 ? candidates[0] : exact.length === 1 ? exact[0] : undefined;

  if (params.confirm && match) {
    return act(match.id);
  }

  const lines: string[] = [];
  const reason = !params.confirm
    ? "confirm was not set"
    : candidates.length === 0
      ? "no memory matched"
      : "the query is ambiguous (several candidates, none equal to the query)";
  lines.push(
    `<forget_candidates query="${escapeXml(query)}" count="${candidates.length}" forgotten="none" reason="${escapeXml(reason)}">`,
  );
  for (const c of candidates) {
    const meta = c.metadata as Record<string, unknown>;
    const type = typeof meta.type === "string" ? meta.type : "fact";
    const relevance = Math.round(c.score * 100);
    const exactAttr = exact.includes(c) ? ` exact="true"` : "";
    lines.push(`  <candidate id="${escapeXml(c.id)}" type="${escapeXml(type)}" relevance="${relevance}%"${exactAttr}>`);
    lines.push(`    ${escapeXml(c.content)}`);
    lines.push("  </candidate>");
  }
  lines.push(
    candidates.length > 0
      ? "  <hint>Nothing was forgotten. Call forget again with memory_id set to the candidate to remove.</hint>"
      : "  <hint>Nothing was forgotten. No memory matched this query.</hint>",
  );
  lines.push("</forget_candidates>");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function formatForgottenXml(result: ForgetResult, actor: string): string {
  const g = result.graph;
  const staleEntities = g.entities.filter((e) => e.stale).length;
  const staleRelationships = g.relationships.filter((r) => r.stale).length;
  const lines: string[] = [];
  lines.push(
    `<forgotten id="${escapeXml(result.memoryId)}" scope="${escapeXml(result.scope)}" hard="${result.hard}" deleted_at="${escapeXml(result.deletedAt)}" actor="${escapeXml(actor)}">`,
  );
  lines.push(`  <content>${escapeXml(result.content)}</content>`);
  lines.push(
    `  <graph entities_touched="${g.entities.length}" stale_entities="${staleEntities}" relationships_touched="${g.relationships.length}" stale_relationships="${staleRelationships}" />`,
  );
  lines.push(
    result.hard
      ? "  <note>Deleted outright. The content hash stays suppressed so the dream pipeline will not re-extract it.</note>"
      : "  <note>Soft-deleted: out of every recall path now; purged by the dream prune phase after the retention window. `engram memories restore <id>` undoes it until then.</note>",
  );
  lines.push("</forgotten>");
  return lines.join("\n");
}

// Register handlers on the stdio server (used when --http is not passed)
registerToolHandlers(server);

// ─── Main ──────────────────────────────────────────────────────

/** Path of the compiled worker script, resolved next to this module. */
function resolveWorkerPath(): string {
  const compiled = fileURLToPath(new URL("./worker.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  // Running from source via tsx: tsx registers its loader for worker threads too.
  const source = fileURLToPath(new URL("./worker.ts", import.meta.url));
  if (existsSync(source)) return source;
  throw new Error(`Engram MCP worker script not found next to ${import.meta.url}`);
}

/** True when this file is the process entry point (not imported by a worker or test). */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * Run the full server in this process on stdio. Exported so the stdio entry
 * (`bridge.ts` → `runStdioEntry`) can start it lazily from the CLI without
 * a second mode decision.
 */
export async function connectStdioInline(): Promise<void> {
  console.error("Engram MCP server running via stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Entry point for `node dist/interfaces/mcp/server.js [--http] [--port N] [--standalone]`
 * and `engram mcp --http`. `--http` serves Streamable HTTP with the worker
 * pool; otherwise the stdio entry decides between bridging to a healthy
 * daemon and running inline (#58/#60).
 */
export async function startMcpServer(args: string[] = process.argv.slice(2)): Promise<void> {
  const httpMode = args.includes("--http");
  const portIdx = args.indexOf("--port");
  // --port wins; ENGRAM_MCP_PORT lets the supervisor launchers (scripts/run-mcp-daemon.sh,
  // the service env file) pick the port without editing a rendered plist/unit (#28).
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : parseMcpPort(process.env.ENGRAM_MCP_PORT, DEFAULT_MCP_PORT);

  if (httpMode) {
    console.error(`Engram MCP server running via HTTP on port ${port}`);

    // Tool calls run on a worker-thread pool (ENGRAM_HTTP_WORKERS, default 2)
    // so a multi-second recall never blocks /health, the MCP handshake, or
    // other clients. ENGRAM_HTTP_WORKERS=0 restores inline single-threaded
    // dispatch on the main thread.
    const workerCount = parseWorkerCount(process.env.ENGRAM_HTTP_WORKERS, 2);
    const timeoutMs = parseTimeoutMs(process.env.ENGRAM_WORKER_TIMEOUT_MS, DEFAULT_WORKER_TIMEOUT_MS);
    const dispatcher = createToolDispatcher({
      workers: workerCount,
      direct: handleToolCall,
      spawn: () => new Worker(resolveWorkerPath()),
      timeoutMs,
    });

    if (workerCount === 0) {
      // Inline mode: warm the embedding model on this thread, as before.
      warmUpEmbeddings()
        .then(() => console.error("Embedding model warmed up"))
        .catch((e) => console.error("Embedding pre-warm failed:", e));
    } else {
      dispatcher
        .whenReady()
        .then(() => console.error(`Embedding model warmed up in ${workerCount} worker(s)`))
        .catch((e) => console.error("Worker pool readiness failed:", e));
    }

    // ENGRAM_MCP_HOST widens the bind address; anything but loopback needs
    // ENGRAM_MCP_TOKEN, which `/mcp` then requires as a bearer token (#27).
    const host = process.env.ENGRAM_MCP_HOST?.trim() || "127.0.0.1";
    const token = resolveMcpToken(process.env);
    const http = createEngramHttpServer({
      port,
      host,
      token,
      registerHandlers: (srv) => registerToolHandlers(srv, dispatcher.call),
      health: () => {
        const stats = dispatcher.stats();
        config ??= loadConfig();
        // #65: the daily version check the CLI caches (never the network from here).
        // #87: the database this daemon serves, so a scoped stdio start with another
        // ENGRAM_DB_PATH runs inline instead of bridging into the wrong database.
        return { workers: stats ?? { size: 0 }, dbPath: config.dbPath, update: updateHealthField(config.dataDir) };
      },
    });

    const shutdown = async (signal: string) => {
      console.error(`Engram MCP HTTP server shutting down (${signal})`);
      await Promise.allSettled([http.close(), dispatcher.close()]);
      process.exit(0);
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));

    const address = await http.listen();
    console.error(
      `Engram MCP HTTP server listening on http://${host}:${address.port}/mcp (workers: ${workerCount}, timeout: ${timeoutMs}ms, auth: ${token ? "bearer token" : "none, loopback only"})`,
    );
  } else {
    await runStdioEntry({ args, env: process.env, inline: connectStdioInline });
  }
}

// Only start a transport when this file is the process entry point on the
// main thread. Worker threads (worker.ts) and tests import the tool handlers
// from this module and must not open stdio or bind a port. `engram mcp`
// calls startMcpServer / connectStdioInline explicitly (src/interfaces/cli/index.ts).
if (isMainThread && isDirectRun()) {
  startMcpServer().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
