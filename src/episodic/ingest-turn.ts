/**
 * Episodic ingest for externally-hosted conversations (W2).
 *
 * The dream ingest phase only reads Claude Code JSONL transcripts, so turns
 * that happen inside Hermes (or any other agent) never reach the episodic
 * layer. `ingestTurn` lets a caller push one user/assistant turn at a time
 * through the same store helpers the JSONL path uses (insertExchange /
 * upsertConversation), so FTS + vector rows are populated identically.
 *
 * Keys are deterministic so re-sending a turn is idempotent:
 *   conversation id = `<source>:<session_id>`
 *   exchange id     = `<conversation id>:<turn_index>`
 *
 * The conversation carries the caller's tenant `scope` (ADR-010); the dream
 * consolidate phase stamps every memory extracted from it with that scope.
 */

import type Database from "better-sqlite3";
import { embedExchange } from "../_core/embeddings/index.js";
import type { Exchange, ToolCall } from "./types.js";
import {
  insertExchange,
  upsertConversation,
  getConversation,
  getExchange,
} from "./store.js";

export const DEFAULT_TURN_SOURCE = "hermes";

/** Cap serialized tool input/output the same way the JSONL parser does. */
const TOOL_PAYLOAD_MAX_CHARS = 1000;

export interface IngestTurnToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
}

export interface IngestTurnInput {
  sessionId: string;
  turnIndex: number;
  scope: string;
  userText: string;
  assistantText: string;
  toolCalls?: IngestTurnToolCall[];
  /** ISO-8601; defaults to now. */
  timestamp?: string;
  /** Platform/source label; defaults to "hermes". Part of the conversation key. */
  source?: string;
}

export interface IngestTurnResult {
  conversationId: string;
  exchangeId: string;
  /** false when the (session_id, turn_index) exchange already existed and was updated in place */
  created: boolean;
  exchangeCount: number;
  scope: string;
}

export function conversationIdFor(source: string, sessionId: string): string {
  return `${source}:${sessionId}`;
}

export function exchangeIdFor(conversationId: string, turnIndex: number): string {
  return `${conversationId}:${turnIndex}`;
}

function serializePayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.substring(0, TOOL_PAYLOAD_MAX_CHARS);
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) throw new Error(`${field} must be a non-empty string`);
  return trimmed;
}

/**
 * Upsert one turn: exchange (+ FTS, vector, tool calls) and its conversation.
 * Embeds synchronously, like the JSONL sync path. Throws on invalid input;
 * the MCP handler turns that into an `isError` result.
 */
export async function ingestTurn(
  db: Database.Database,
  input: IngestTurnInput,
): Promise<IngestTurnResult> {
  const sessionId = requireNonEmpty(input.sessionId, "session_id");
  const scope = requireNonEmpty(input.scope, "scope");
  const source = input.source === undefined ? DEFAULT_TURN_SOURCE : requireNonEmpty(input.source, "source");
  if (!Number.isInteger(input.turnIndex) || input.turnIndex < 0) {
    throw new Error("turn_index must be an integer >= 0");
  }
  if (typeof input.userText !== "string" || typeof input.assistantText !== "string") {
    throw new Error("user_text and assistant_text are required");
  }

  let timestamp: string;
  if (input.timestamp === undefined) {
    timestamp = new Date().toISOString();
  } else {
    const parsed = new Date(input.timestamp);
    if (Number.isNaN(parsed.getTime())) throw new Error("timestamp must be an ISO-8601 date string");
    timestamp = parsed.toISOString();
  }

  const conversationId = conversationIdFor(source, sessionId);
  const exchangeId = exchangeIdFor(conversationId, input.turnIndex);
  const now = Math.floor(Date.now() / 1000);

  const toolCalls: ToolCall[] = (input.toolCalls ?? []).map((tc, i) => ({
    id: `${exchangeId}:tc:${i}`,
    exchangeId,
    toolName: requireNonEmpty(tc.name, `tool_calls[${i}].name`),
    toolInput: serializePayload(tc.input),
    toolResultSummary: serializePayload(tc.output),
    isError: false,
    timestamp,
  }));

  const embedding = await embedExchange(input.userText, input.assistantText, {
    project: source,
    date: timestamp.split("T")[0],
    tools: toolCalls.map((tc) => tc.toolName),
  });

  const existing = getExchange(db, exchangeId);

  const exchange: Exchange = {
    id: exchangeId,
    conversationId,
    project: source,
    timestamp,
    userMessage: input.userText,
    assistantMessage: input.assistantText,
    sessionId,
    exchangeIndex: input.turnIndex,
    tokenEstimate: Math.ceil((input.userText.length + input.assistantText.length) / 4),
    createdAt: existing?.createdAt ?? now,
  };

  const exchangeCount = db.transaction(() => {
    // Re-ingest replaces the turn's tool calls wholesale (insertExchange only upserts by id).
    db.prepare("DELETE FROM tool_calls WHERE exchange_id = ?").run(exchangeId);
    insertExchange(db, exchange, embedding, toolCalls);

    const agg = db
      .prepare(
        "SELECT COUNT(*) AS n, MIN(timestamp) AS s, MAX(timestamp) AS e FROM exchanges WHERE conversation_id = ?",
      )
      .get(conversationId) as { n: number; s: string | null; e: string | null };
    const prev = getConversation(db, conversationId);

    upsertConversation(db, {
      id: conversationId,
      project: source,
      startedAt: agg.s ?? timestamp,
      endedAt: agg.e ?? timestamp,
      exchangeCount: agg.n,
      summary: prev?.summary,
      primaryTopics: prev?.primaryTopics,
      archivePath: prev?.archivePath,
      lastIndexed: now,
      scope,
    });
    return agg.n;
  })();

  return {
    conversationId,
    exchangeId,
    created: existing === null,
    exchangeCount,
    scope,
  };
}
