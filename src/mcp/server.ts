#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { initDatabase } from "../core/db.js";
import { loadConfig } from "../core/config.js";
import {
  searchMultiSource,
  formatRecallXml,
  escapeXml,
} from "../episodic/search.js";
import { exploreEntity } from "../graph/search.js";
import { initEmbeddings, embedDocument } from "../episodic/embeddings.js";
import {
  insertMemory,
  findNearestMemories,
  recordAccess,
  getMemory,
} from "../semantic/memory.js";
import type Database from "better-sqlite3";
import type {
  EngramConfig,
  SearchOptions,
  SearchSource,
  RelationshipType,
  Memory,
  MemoryType,
} from "../core/types.js";
import type { ReflectResult } from "../graph/types.js";

// ─── Lazy State ────────────────────────────────────────────────

let db: Database.Database | null = null;
let config: EngramConfig | null = null;
let embeddingsReady = false;

function getDb(): Database.Database {
  if (!db) {
    config = loadConfig();
    db = initDatabase(config);
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

const VALID_MEMORY_TYPES: readonly MemoryType[] = [
  "preference",
  "decision",
  "pattern",
  "fact",
  "solution",
  "convention",
];

const VALID_SOURCES: readonly SearchSource[] = ["episodic", "semantic", "graph"];

/** Auto-merge threshold for near-duplicate detection */
const REMEMBER_DEDUP_THRESHOLD = 0.95;

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
});

const ShowInputSchema = z.object({
  path: z.string().min(1, "Path is required"),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

const ExploreInputSchema = z.object({
  entity: z.string().min(1, "Entity name is required"),
  depth: z.number().int().min(1).max(3).optional().default(1),
  relationship_types: z
    .array(
      z.enum([
        "uses",
        "depends_on",
        "related_to",
        "part_of",
        "configured_by",
        "solved_by",
      ]),
    )
    .optional(),
});

const ReflectInputSchema = z.object({
  mode: z.enum(["communities", "bridges", "temporal", "health", "all"]).optional().default("all"),
  refresh: z.boolean().optional().default(false),
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
  ],
}));

// ─── Tool Handlers ─────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === "recall") {
      const params = RecallInputSchema.parse(args);
      await ensureEmbeddings();

      const searchOptions: SearchOptions = {
        query: params.query,
        sources: (params.sources ?? ["episodic", "semantic"]) as SearchSource[],
        mode: "hybrid",
        budget: params.budget ?? 1500,
        after: params.after,
        before: params.before,
        depth: params.depth ?? "shallow",
      };

      const response = await searchMultiSource(getDb(), searchOptions);
      const xml = formatRecallXml(response);

      return {
        content: [{ type: "text", text: xml }],
      };
    }

    if (name === "remember") {
      const params = RememberInputSchema.parse(args);
      await ensureEmbeddings();

      const database = getDb();

      // 1. Embed the content
      const embedding = await embedDocument(params.content);

      // 2. Check for near-duplicates
      const neighbors = findNearestMemories(database, embedding, 3);

      for (const neighbor of neighbors) {
        // Convert L2 distance to cosine similarity for unit vectors
        const similarity = 1 - (neighbor.distance * neighbor.distance) / 2;

        if (similarity >= REMEMBER_DEDUP_THRESHOLD) {
          // Near-duplicate found — update existing memory
          recordAccess(database, neighbor.id);
          return {
            content: [
              {
                type: "text",
                text: `Updated existing memory: ${neighbor.id}`,
              },
            ],
          };
        }
      }

      // 3. No duplicate — insert new memory
      const newId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);

      const memory: Memory = {
        id: newId,
        type: params.type as MemoryType,
        content: params.content,
        confidence: 0.9, // User-stated facts get high confidence
        importance: params.importance,
        accessCount: 0,
        createdAt: now,
        sourceExchanges: [],
        isActive: true,
      };

      insertMemory(database, memory, embedding);

      return {
        content: [
          { type: "text", text: `Remembered: ${params.content}` },
        ],
      };
    }

    if (name === "show") {
      const params = ShowInputSchema.parse(args);

      if (!existsSync(params.path)) {
        throw new Error(`File not found: ${params.path}`);
      }

      const content = readFileSync(params.path, "utf-8");
      const allLines = content.split("\n").filter((l) => l.trim());

      const start = params.startLine ? params.startLine - 1 : 0;
      const end = params.endLine ?? allLines.length;
      const lines = allLines.slice(start, end);

      // Format JSONL lines as readable markdown
      const formatted = formatShowOutput(lines, start + 1);

      return {
        content: [{ type: "text", text: formatted }],
      };
    }

    if (name === "explore") {
      const params = ExploreInputSchema.parse(args);

      const result = exploreEntity(getDb(), {
        entity: params.entity,
        depth: params.depth,
        relationshipTypes: params.relationship_types as
          | RelationshipType[]
          | undefined,
      });

      // Format as XML
      const lines: string[] = [];
      lines.push(
        `<engram_graph entity="${escapeXml(result.centerEntity.name)}" type="${result.centerEntity.type}">`,
      );
      if (result.centerEntity.description) {
        lines.push(
          `  <description>${escapeXml(result.centerEntity.description)}</description>`,
        );
      }
      for (const neighbor of result.neighbors) {
        const dir = neighbor.relationship.direction;
        const attrs =
          dir === "outgoing"
            ? `direction="outgoing" type="${neighbor.relationship.type}" target="${escapeXml(neighbor.entity.name)}" weight="${neighbor.relationship.weight.toFixed(2)}"`
            : `direction="incoming" type="${neighbor.relationship.type}" source="${escapeXml(neighbor.entity.name)}" weight="${neighbor.relationship.weight.toFixed(2)}"`;
        lines.push(`  <relationship ${attrs}>`);
        if (neighbor.relationship.context) {
          lines.push(`    ${escapeXml(neighbor.relationship.context)}`);
        }
        lines.push("  </relationship>");
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

    if (name === "reflect") {
      const params = ReflectInputSchema.parse(args);
      const database = getDb();

      let result: ReflectResult | null;

      if (params.refresh) {
        if (!config) config = loadConfig();
        const { runReflection } = await import("../graph/reflection.js");
        result = await runReflection(database, config);
      } else {
        const { buildReflectResultFromCache } = await import("../graph/reflection.js");
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

// ─── Show Formatting ───────────────────────────────────────────

function formatShowOutput(lines: string[], startLineNum: number): string {
  let output = "# Conversation\n\n";

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed.type !== "user" && parsed.type !== "assistant") continue;
      if (!parsed.message?.content) continue;

      const lineNum = startLineNum + i;
      const role = parsed.type === "user" ? "User" : "Assistant";
      const timestamp = parsed.timestamp
        ? new Date(parsed.timestamp).toLocaleString()
        : "";

      output += `### ${role} (line ${lineNum}${timestamp ? `, ${timestamp}` : ""})\n\n`;

      if (typeof parsed.message.content === "string") {
        output += `${parsed.message.content}\n\n`;
      } else if (Array.isArray(parsed.message.content)) {
        for (const block of parsed.message.content) {
          if (block.type === "text" && block.text) {
            output += `${block.text}\n\n`;
          } else if (block.type === "tool_use") {
            output += `**Tool:** \`${block.name}\`\n\n`;
          }
        }
      }
    } catch {
      continue;
    }
  }

  return output;
}

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
