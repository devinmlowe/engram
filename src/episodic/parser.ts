import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Exchange, ToolCall } from "./types.js";

// ─── Types ─────────────────────────────────────────────────────

interface JSONLMessage {
  type: string;
  message?: {
    role: "user" | "assistant";
    content: string | ContentBlock[];
  };
  timestamp?: string;
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
}

export interface ParsedConversation {
  conversationId: string;
  project: string;
  exchanges: Exchange[];
  toolCalls: ToolCall[];
  metadata: {
    startedAt?: string;
    endedAt?: string;
    sessionId?: string;
  };
}

// ─── Exclusion Markers ─────────────────────────────────────────

const EXCLUSION_MARKERS = [
  "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>",
  "Only use NO_INSIGHTS_FOUND",
];

const EXCLUSION_CHECK_BYTES = 4096;

/**
 * Check if a conversation file should be skipped (reads only first 4KB).
 */
export function shouldSkipConversation(filePath: string): boolean {
  try {
    const fd = readFileSync(filePath, { encoding: "utf-8", flag: "r" });
    const head = fd.substring(0, EXCLUSION_CHECK_BYTES);
    return EXCLUSION_MARKERS.some((marker) => head.includes(marker));
  } catch {
    return false;
  }
}

// ─── Parser ────────────────────────────────────────────────────

/**
 * Parse a JSONL conversation file into structured exchanges and tool calls.
 *
 * @param filePath - Absolute path to the .jsonl file
 * @param project - Project name for this conversation
 * @param archivePath - Path used for deterministic ID generation
 */
export async function parseConversationFile(
  filePath: string,
  project: string,
  archivePath: string,
): Promise<ParsedConversation> {
  const conversationId = basename(filePath, ".jsonl");
  const allExchanges: Exchange[] = [];
  const allToolCalls: ToolCall[] = [];
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let sessionId: string | undefined;

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNumber = 0;
  let exchangeIndex = 0;

  // Accumulator for current exchange
  let current: {
    userMessage: string;
    userLine: number;
    assistantMessages: string[];
    lastAssistantLine: number;
    timestamp: string;
    sessionId?: string;
    cwd?: string;
    gitBranch?: string;
    modelVersion?: string;
    toolCalls: ToolCall[];
  } | null = null;

  const finalizeExchange = () => {
    if (!current || current.assistantMessages.length === 0) return;

    const exchangeId = createHash("md5")
      .update(`${archivePath}:${current.userLine}-${current.lastAssistantLine}`)
      .digest("hex");

    const assistantMessage = current.assistantMessages.join("\n\n");
    const tokenEstimate = Math.ceil(
      (current.userMessage.length + assistantMessage.length) / 4,
    );

    // Fix up tool call exchange IDs
    const toolCalls = current.toolCalls.map((tc) => ({
      ...tc,
      exchangeId: exchangeId,
    }));

    const exchange: Exchange = {
      id: exchangeId,
      conversationId,
      project,
      timestamp: current.timestamp,
      userMessage: current.userMessage,
      assistantMessage,
      sessionId: current.sessionId,
      cwd: current.cwd,
      gitBranch: current.gitBranch,
      modelVersion: current.modelVersion,
      exchangeIndex,
      tokenEstimate,
      createdAt: Math.floor(Date.now() / 1000),
    };

    allExchanges.push(exchange);
    allToolCalls.push(...toolCalls);

    if (!firstTimestamp) firstTimestamp = current.timestamp;
    lastTimestamp = current.timestamp;
    if (current.sessionId) sessionId = current.sessionId;

    exchangeIndex++;
  };

  for await (const line of rl) {
    lineNumber++;

    let parsed: JSONLMessage;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // Skip malformed lines
    }

    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    if (!parsed.message) continue;

    // Extract text and tool calls from content
    let text = "";
    const toolCalls: ToolCall[] = [];

    if (typeof parsed.message.content === "string") {
      text = parsed.message.content;
    } else if (Array.isArray(parsed.message.content)) {
      const textBlocks = parsed.message.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!);
      text = textBlocks.join("\n");

      // Extract tool_use blocks from assistant messages
      if (parsed.message.role === "assistant") {
        for (const block of parsed.message.content) {
          if (block.type === "tool_use") {
            toolCalls.push({
              id: randomUUID(),
              exchangeId: "", // Set later in finalizeExchange
              toolName: block.name || "unknown",
              toolInput: block.input
                ? JSON.stringify(block.input).substring(0, 1000)
                : undefined,
              isError: false,
              timestamp: parsed.timestamp,
            });
          }
        }
      }
    }

    // Skip empty messages (no text and no tool calls)
    if (!text.trim() && toolCalls.length === 0) continue;

    if (parsed.message.role === "user") {
      finalizeExchange();

      current = {
        userMessage: text || "(tool results only)",
        userLine: lineNumber,
        assistantMessages: [],
        lastAssistantLine: lineNumber,
        timestamp: parsed.timestamp || new Date().toISOString(),
        sessionId: parsed.sessionId,
        cwd: parsed.cwd,
        gitBranch: parsed.gitBranch,
        modelVersion: parsed.version,
        toolCalls: [],
      };
    } else if (parsed.message.role === "assistant" && current) {
      if (text.trim()) {
        current.assistantMessages.push(text);
      }
      current.lastAssistantLine = lineNumber;

      if (toolCalls.length > 0) {
        current.toolCalls.push(...toolCalls);
      }

      // Update metadata from most recent message
      if (parsed.timestamp) current.timestamp = parsed.timestamp;
      if (parsed.sessionId) current.sessionId = parsed.sessionId;
      if (parsed.cwd) current.cwd = parsed.cwd;
      if (parsed.gitBranch) current.gitBranch = parsed.gitBranch;
      if (parsed.version) current.modelVersion = parsed.version;
    }
  }

  // Finalize last exchange
  finalizeExchange();

  return {
    conversationId,
    project,
    exchanges: allExchanges,
    toolCalls: allToolCalls,
    metadata: {
      startedAt: firstTimestamp,
      endedAt: lastTimestamp,
      sessionId,
    },
  };
}
