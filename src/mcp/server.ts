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
} from "../episodic/search.js";
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
  Memory,
  MemoryType,
} from "../core/types.js";

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

const VALID_SOURCES: readonly SearchSource[] = ["episodic", "semantic"];

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
    .array(z.enum(["episodic", "semantic"]))
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
            items: { type: "string", enum: ["episodic", "semantic"] },
            default: ["episodic", "semantic"],
            description:
              "Which memory stores to search. Defaults to both.",
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
