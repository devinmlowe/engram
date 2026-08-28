#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { getDatabase } from "../../_core/db/index.js";
import { loadConfig } from "../../_core/config/index.js";
import { escapeXml } from "../../_core/search/index.js";
import { initEmbeddings } from "../../_core/embeddings/index.js";
import { rememberFact, storeMemoryBatch } from "../shared/remember.js";
import { getTenantScoping } from "./scoping.js";
import { sliceShowLines, formatShowOutput } from "./show-format.js";
import { buildIntelligenceConfig } from "../../_core/llm/index.js";
import type { MemorySource } from "../../_core/types/index.js";
import {
  unifiedSearch,
  formatRecallXml,
  createOrRefineRecallSession,
  drillRecallResult,
} from "../shared/search.js";
import { explore, exploreSelectiveEntity } from "../shared/explore.js";
import { fetchSnippets } from "../../_core/search/snippets.js";
import { scanFile } from "../../_core/search/scan.js";
import { getSessionStore } from "../../_core/search/index.js";
import { indexFileStructure } from "../../graph/file-indexer.js";
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

// ─── Constants ──────────────────────────────────────────────────

/** Upper bound for the LLM merge inside a `remember` tool call */
const MERGE_TIMEOUT_MS = 15_000;

const VALID_MEMORY_TYPES: readonly MemoryType[] = [
  "preference",
  "decision",
  "pattern",
  "fact",
  "solution",
  "convention",
];

const VALID_SOURCES: readonly SearchSource[] = ["episodic", "semantic", "graph"];

const VALID_MEMORY_SOURCES: readonly MemorySource[] = ["user", "dream", "rlm", "import"];


// ─── Input Schemas ─────────────────────────────────────────────

const RecallInputSchema = z.object({
  query: z.string().min(2, "Query must be at least 2 characters"),
  budget: z.number().int().min(100).max(5000).optional(),
  after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional(),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional(),
  depth: z.enum(["shallow", "deep"]).optional(),
  sources: z
    .array(z.enum(["episodic", "semantic", "graph"]))
    .optional(),
});

const RememberInputSchema = z.object({
  content: z.string().min(1, "Content is required"),
  type: z.enum([
    "preference",
    "decision",
    "pattern",
    "fact",
    "solution",
    "convention",
  ]).optional().default("fact"),
  importance: z.number().min(0).max(1).optional().default(0.7),
  source: z.enum(["user", "dream", "rlm", "import"]).optional().default("user"),
});

const RememberBatchInputSchema = z.object({
  memories: z.array(z.object({
    content: z.string().min(1, "Content is required"),
    type: z.enum([
      "preference",
      "decision",
      "pattern",
      "fact",
      "solution",
      "convention",
    ]).optional().default("fact"),
    importance: z.number().min(0).max(1).optional(),
    source: z.enum(["user", "dream", "rlm", "import"]).optional(),
    relates_to_entities: z.array(z.string()).max(10).optional(),
  })).min(1, "At least one memory is required").max(50, "Maximum batch size is 50"),
});

const ShowInputSchema = z.object({
  path: z.string().min(1, "Path is required"),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

const ExploreInputSchema = z.object({
  entity: z.string().min(1, "Entity name is required"),
  depth: z.number().int().min(1).max(3).optional().default(1),
  limit: z.number().int().min(1).max(50).optional().default(25),
  budget: z.number().int().min(100).max(5000).optional().default(1500),
  relationship_types: z
    .array(
      z.enum([
        "uses",
        "depends_on",
        "related_to",
        "part_of",
        "configured_by",
        "solved_by",
        "contains",
      ]),
    )
    .optional(),
});

const RecallSessionInputSchema = z.object({
  query: z.string().min(2, "Query must be at least 2 characters"),
  session_id: z.string().uuid().optional(),
  budget: z.number().int().min(100).max(10000).optional(),
  sources: z
    .array(z.enum(["episodic", "semantic", "graph"]))
    .optional(),
});

const RecallDrillInputSchema = z.object({
  session_id: z.string().uuid("Invalid session ID"),
  result_index: z.number().int().min(0, "Result index must be >= 0"),
});

const ExploreSelectiveInputSchema = z.object({
  entity: z.string().min(1, "Entity name is required"),
  criteria: z.string().min(1, "Criteria is required"),
  max_depth: z.number().int().min(1).max(5).optional().default(3),
  max_nodes: z.number().int().min(1).max(50).optional().default(50),
  relationship_types: z
    .array(
      z.enum([
        "uses",
        "depends_on",
        "related_to",
        "part_of",
        "configured_by",
        "solved_by",
        "contains",
      ]),
    )
    .optional(),
});

const ReflectInputSchema = z.object({
  mode: z.enum(["communities", "bridges", "temporal", "health", "all"]).optional().default("all"),
  refresh: z.boolean().optional().default(false),
});

const FetchSnippetsInputSchema = z.object({
  path: z.string().min(1, "Path is required"),
  ranges: z.array(z.object({
    start: z.number().int().min(1),
    end: z.number().int().min(1),
  })).min(1).max(20),
  context: z.number().int().min(0).max(50).optional().default(0),
  session_id: z.string().uuid().optional(),
});

const ScanFileInputSchema = z.object({
  path: z.string().min(1, "Path is required"),
  patterns: z.array(z.string()).min(1, "At least one pattern is required").max(10, "Maximum 10 patterns allowed"),
  context_lines: z.number().int().min(0).max(10).optional().default(2),
  group_by: z.enum(["pattern", "location"]).optional().default("location"),
  max_matches: z.number().int().min(1).max(500).optional().default(100),
  deduplicate_overlaps: z.boolean().optional().default(true),
  session_id: z.string().uuid().optional(),
});

const IndexFileStructureInputSchema = z.object({
  path: z.string().min(1, "Path is required"),
});

// ─── Server Setup ──────────────────────────────────────────────

const server = new Server(
  { name: "engram", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ─── Tool Definitions ──────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "recall",
      description:
        "Retrieve relevant memories from past Claude Code conversations and " +
        "extracted knowledge. Uses hybrid semantic + keyword search with " +
        "token-budgeted output across episodic and semantic memory stores. " +
        "Search BEFORE every task to recover decisions, solutions, and context.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 2 },
          budget: {
            type: "number",
            minimum: 100,
            maximum: 5000,
            default: 1500,
            description: "Max tokens in response",
          },
          after: {
            type: "string",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            description: "Only results after this date (YYYY-MM-DD)",
          },
          before: {
            type: "string",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            description: "Only results before this date (YYYY-MM-DD)",
          },
          depth: {
            type: "string",
            enum: ["shallow", "deep"],
            default: "shallow",
          },
          sources: {
            type: "array",
            items: { type: "string", enum: ["episodic", "semantic", "graph"] },
            default: ["episodic", "semantic"],
            description:
              "Which memory stores to search. Defaults to episodic and semantic.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
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
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            minLength: 1,
            description: "The fact, preference, or knowledge to remember",
          },
          type: {
            type: "string",
            enum: [
              "preference",
              "decision",
              "pattern",
              "fact",
              "solution",
              "convention",
            ],
            default: "fact",
            description: "Type of memory",
          },
          importance: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.7,
            description: "Importance score (0-1)",
          },
          source: {
            type: "string",
            enum: ["user", "dream", "rlm", "import"],
            default: "user",
            description: "Source of this memory (user, dream, rlm, import)",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
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
      inputSchema: {
        type: "object",
        properties: {
          memories: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  minLength: 1,
                  description: "The fact, preference, or knowledge to remember",
                },
                type: {
                  type: "string",
                  enum: [
                    "preference",
                    "decision",
                    "pattern",
                    "fact",
                    "solution",
                    "convention",
                  ],
                  default: "fact",
                  description: "Type of memory",
                },
                importance: {
                  type: "number",
                  minimum: 0,
                  maximum: 1,
                  description: "Importance score (0-1)",
                },
                source: {
                  type: "string",
                  enum: ["user", "dream", "rlm", "import"],
                  description: "Source of this memory",
                },
                relates_to_entities: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: 10,
                  description:
                    "Entity names to link this memory to. Bumps mention counts " +
                    "and creates pairwise related_to relationships between entities.",
                },
              },
              required: ["content"],
            },
            minItems: 1,
            maxItems: 50,
            description: "Array of memories to store (max 50)",
          },
        },
        required: ["memories"],
        additionalProperties: false,
      },
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
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          startLine: { type: "number", minimum: 1 },
          endLine: { type: "number", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
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
      inputSchema: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            minLength: 1,
            description:
              "Entity name to explore (e.g., 'TypeScript', 'engram', 'SQLite')",
          },
          depth: {
            type: "number",
            minimum: 1,
            maximum: 3,
            default: 1,
            description: "Number of hops to traverse (1-3)",
          },
          limit: {
            type: "number",
            minimum: 1,
            maximum: 50,
            default: 25,
            description: "Max neighbors to return, sorted by weight (1-50)",
          },
          budget: {
            type: "number",
            minimum: 100,
            maximum: 5000,
            default: 1500,
            description: "Max tokens in response",
          },
          relationship_types: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "uses",
                "depends_on",
                "related_to",
                "part_of",
                "configured_by",
                "solved_by",
                "contains",
              ],
            },
            description: "Filter by relationship types",
          },
        },
        required: ["entity"],
        additionalProperties: false,
      },
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
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["communities", "bridges", "temporal", "health", "all"],
            default: "all",
            description: "What to reflect on.",
          },
          refresh: {
            type: "boolean",
            default: false,
            description: "Force a fresh analysis instead of using cached results.",
          },
        },
        additionalProperties: false,
      },
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
        "remaining token budget. Use recall_drill to expand individual results.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 2,
            description: "Search query",
          },
          session_id: {
            type: "string",
            format: "uuid",
            description: "Existing session ID to refine (omit to create new)",
          },
          budget: {
            type: "number",
            minimum: 100,
            maximum: 10000,
            default: 3000,
            description: "Max total token budget for this session",
          },
          sources: {
            type: "array",
            items: { type: "string", enum: ["episodic", "semantic", "graph"] },
            default: ["episodic", "semantic"],
            description: "Which memory stores to search",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
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
        "For graph results: shows entity with full relationship neighborhood.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            format: "uuid",
            description: "Session ID from recall_session",
          },
          result_index: {
            type: "number",
            minimum: 0,
            description: "0-based index into session results",
          },
        },
        required: ["session_id", "result_index"],
        additionalProperties: false,
      },
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
      inputSchema: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            minLength: 1,
            description:
              "Starting entity name (e.g., 'TypeScript', 'engram', 'SQLite')",
          },
          criteria: {
            type: "string",
            minLength: 1,
            description:
              "What makes a neighbor relevant (e.g., 'build tooling', 'performance optimization')",
          },
          max_depth: {
            type: "number",
            minimum: 1,
            maximum: 5,
            default: 3,
            description: "Maximum traversal depth (1-5)",
          },
          max_nodes: {
            type: "number",
            minimum: 1,
            maximum: 50,
            default: 50,
            description: "Safety cap on total nodes returned (1-50)",
          },
          relationship_types: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "uses",
                "depends_on",
                "related_to",
                "part_of",
                "configured_by",
                "solved_by",
                "contains",
              ],
            },
            description: "Filter by relationship types",
          },
        },
        required: ["entity", "criteria"],
        additionalProperties: false,
      },
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
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          ranges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                start: { type: "number", minimum: 1 },
                end: { type: "number", minimum: 1 },
              },
              required: ["start", "end"],
            },
            minItems: 1,
            maxItems: 20,
            description: "Line ranges to fetch (max 20)",
          },
          context: {
            type: "number",
            minimum: 0,
            maximum: 50,
            default: 0,
            description: "Number of padding lines around each range (0-50)",
          },
          session_id: {
            type: "string",
            format: "uuid",
            description: "Optional session ID for token budget tracking",
          },
        },
        required: ["path", "ranges"],
        additionalProperties: false,
      },
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
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description: "Absolute path to the file to scan",
          },
          patterns: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 10,
            description: "Regex patterns to search for (max 10)",
          },
          context_lines: {
            type: "number",
            minimum: 0,
            maximum: 10,
            default: 2,
            description: "Lines of context before and after each match (0-10)",
          },
          group_by: {
            type: "string",
            enum: ["pattern", "location"],
            default: "location",
            description: "Order results by file location or grouped by pattern",
          },
          max_matches: {
            type: "number",
            minimum: 1,
            maximum: 500,
            default: 100,
            description: "Maximum matches to return (1-500)",
          },
          deduplicate_overlaps: {
            type: "boolean",
            default: true,
            description: "Merge overlapping context windows to avoid duplicate lines",
          },
          session_id: {
            type: "string",
            format: "uuid",
            description: "Optional session ID for token budget tracking",
          },
        },
        required: ["path", "patterns"],
        additionalProperties: false,
      },
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
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description: "Absolute path to the source file to index",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: {
        title: "Index File Structure",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ],
}));

// ─── Tool Handlers ─────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === "recall") {
      const params = RecallInputSchema.parse(args);
      await ensureEmbeddings();

      if (!config) config = loadConfig();
      const scoping = getTenantScoping(process.env);
      const response = await unifiedSearch(getDb(), {
        query: params.query,
        sources: (params.sources ?? ["episodic", "semantic"]) as SearchSource[],
        mode: "hybrid",
        budget: params.budget ?? 1500,
        after: params.after,
        before: params.before,
        depth: params.depth ?? "shallow",
        scopes: scoping.readScopes,
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
          scope: getTenantScoping(process.env).writeScope,
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
        relates_to_entities: m.relates_to_entities,
      }));

      const result = await storeMemoryBatch(getDb(), batchInput, {
        scope: getTenantScoping(process.env).writeScope,
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

      const result = explore(getDb(), {
        entity: params.entity,
        depth: params.depth,
        limit: params.limit,
        relationshipTypes: params.relationship_types as
          | RelationshipType[]
          | undefined,
      });

      // Format as XML with token budget
      const budget = params.budget;
      let tokenEstimate = 0;
      const lines: string[] = [];

      const header = `<engram_graph entity="${escapeXml(result.centerEntity.name)}" type="${result.centerEntity.type}" total_neighbors="${result.neighbors.length}">`;
      lines.push(header);
      tokenEstimate += Math.ceil(header.length / 4);

      if (result.centerEntity.description) {
        const desc = `  <description>${escapeXml(result.centerEntity.description)}</description>`;
        lines.push(desc);
        tokenEstimate += Math.ceil(desc.length / 4);
      }

      let included = 0;
      for (const neighbor of result.neighbors) {
        const dir = neighbor.relationship.direction;
        const attrs =
          dir === "outgoing"
            ? `direction="outgoing" type="${neighbor.relationship.type}" target="${escapeXml(neighbor.entity.name)}" weight="${neighbor.relationship.weight.toFixed(2)}"`
            : `direction="incoming" type="${neighbor.relationship.type}" source="${escapeXml(neighbor.entity.name)}" weight="${neighbor.relationship.weight.toFixed(2)}"`;
        const relLine = neighbor.relationship.context
          ? `  <relationship ${attrs}>\n    ${escapeXml(neighbor.relationship.context)}\n  </relationship>`
          : `  <relationship ${attrs} />`;
        const relTokens = Math.ceil(relLine.length / 4);

        if (tokenEstimate + relTokens > budget) break;
        lines.push(relLine);
        tokenEstimate += relTokens;
        included++;
      }

      if (included < result.neighbors.length) {
        lines.push(`  <!-- ${result.neighbors.length - included} more neighbors omitted (budget) -->`);
      }

      if (result.community) {
        lines.push(
          `  <community name="${escapeXml(result.community.name)}" entities="${result.community.entityCount}" />`,
        );
      }
      lines.push("</engram_graph>");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
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
      };
    }

    if (name === "recall_drill") {
      const params = RecallDrillInputSchema.parse(args);

      const result = await drillRecallResult(
        getDb(),
        params.session_id,
        params.result_index,
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

      const result = await exploreSelectiveEntity(getDb(), {
        entity: params.entity,
        criteria: params.criteria,
        maxDepth: params.max_depth,
        maxNodes: params.max_nodes,
        relationshipTypes: params.relationship_types as
          | RelationshipType[]
          | undefined,
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

      if (params.refresh) {
        if (!config) config = loadConfig();
        const { runReflection } = await import("../../graph/reflection.js");
        result = await runReflection(database, config);
      } else {
        const { buildReflectResultFromCache } = await import("../../graph/reflection.js");
        result = buildReflectResultFromCache(database);
      }

      if (!result) {
        return {
          content: [{
            type: "text",
            text: `<engram_reflection mode="${params.mode}">\n  <status>No reflection data available. Run 'engram dream --phase reflect' first.</status>\n</engram_reflection>`,
          }],
        };
      }

      const xml = formatReflectXml(result, params.mode);
      return { content: [{ type: "text", text: xml }] };
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
});

// ─── Reflect Formatting ─────────────────────────────────────────

function formatReflectXml(result: ReflectResult, mode: string): string {
  const lines: string[] = [];
  const timestamp = new Date(result.generatedAt * 1000).toISOString();

  lines.push(
    `<engram_reflection mode="${escapeXml(mode)}" generation="${result.generation}" timestamp="${timestamp}">`,
  );

  // Communities section
  if (mode === "all" || mode === "communities") {
    const avgCoherence = result.health.averageCoherence;
    lines.push(
      `  <communities count="${result.communities.length}" modularity="${result.health.modularity.toFixed(2)}">`,
    );
    for (const community of result.communities) {
      lines.push(
        `    <community name="${escapeXml(community.name)}" coherence="${community.coherenceScore.toFixed(2)}" entities="${community.entityCount}" memories="${community.memoryCount}">`,
      );
      lines.push(`      <description>${escapeXml(community.description)}</description>`);
      if (community.topEntities.length > 0) {
        lines.push("      <top_entities>");
        for (const entity of community.topEntities) {
          lines.push(
            `        <entity name="${escapeXml(entity.name)}" type="${escapeXml(entity.type)}" />`,
          );
        }
        lines.push("      </top_entities>");
      }
      lines.push("    </community>");
    }
    lines.push("  </communities>");
  }

  // Bridges section
  if (mode === "all" || mode === "bridges") {
    lines.push(`  <bridges count="${result.bridges.length}">`);
    for (const bridge of result.bridges) {
      lines.push(
        `    <bridge entity="${escapeXml(bridge.entityName)}" type="${escapeXml(bridge.entityType)}" score="${bridge.bridgeScore.toFixed(2)}" span="${bridge.communitySpan}">`,
      );
      if (bridge.narrative) {
        lines.push(`      <narrative>${escapeXml(bridge.narrative)}</narrative>`);
      }
      if (bridge.connectedCommunities.length > 0) {
        lines.push("      <connects>");
        for (const communityName of bridge.connectedCommunities) {
          lines.push(`        <community name="${escapeXml(communityName)}" />`);
        }
        lines.push("      </connects>");
      }
      lines.push("    </bridge>");
    }
    lines.push("  </bridges>");
  }

  // Temporal patterns section
  if (mode === "all" || mode === "temporal") {
    lines.push(`  <temporal_patterns count="${result.temporalPatterns.length}">`);
    for (const pattern of result.temporalPatterns) {
      lines.push(
        `    <pattern type="${escapeXml(pattern.type)}" confidence="${pattern.confidence.toFixed(1)}">`,
      );
      lines.push(`      <description>${escapeXml(pattern.description)}</description>`);
      if (pattern.entityIds.length > 0) {
        // Resolve entity names if possible, otherwise show IDs
        lines.push(`      <entities>${escapeXml(pattern.entityIds.join(", "))}</entities>`);
      }
      lines.push("    </pattern>");
    }
    lines.push("  </temporal_patterns>");
  }

  // Health section
  if (mode === "all" || mode === "health") {
    lines.push("  <health>");
    lines.push(`    <stat name="total_nodes" value="${result.health.totalNodes}" />`);
    lines.push(`    <stat name="total_edges" value="${result.health.totalEdges}" />`);
    lines.push(`    <stat name="modularity" value="${result.health.modularity.toFixed(2)}" />`);
    lines.push(`    <stat name="communities" value="${result.health.communityCount}" />`);
    lines.push(`    <stat name="orphan_nodes" value="${result.health.orphanNodes}" />`);
    lines.push(`    <stat name="average_coherence" value="${result.health.averageCoherence.toFixed(2)}" />`);
    lines.push("  </health>");
  }

  // Observations section (always included when available)
  if (result.observations.length > 0) {
    lines.push("  <observations>");
    for (const obs of result.observations) {
      lines.push(
        `    <observation type="${escapeXml(obs.type)}" confidence="${obs.confidence.toFixed(1)}">${escapeXml(obs.content)}</observation>`,
      );
    }
    lines.push("  </observations>");
  }

  lines.push("</engram_reflection>");

  return lines.join("\n");
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  console.error("Engram MCP server running via stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
