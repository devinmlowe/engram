import type Database from "better-sqlite3";
import type { Exchange, ToolCall, Conversation } from "./types.js";

/**
 * Insert an exchange with its embedding and tool calls in a single transaction.
 * Uses INSERT OR REPLACE for idempotent re-indexing.
 */
export function insertExchange(
  db: Database.Database,
  exchange: Exchange,
  embedding: number[],
  toolCalls: ToolCall[],
): void {
  const run = db.transaction(() => {
    // 1. Check for existing row (needed for FTS5 external content delete)
    const existing = db
      .prepare("SELECT rowid, user_message, assistant_message FROM exchanges WHERE id = ?")
      .get(exchange.id) as { rowid: number; user_message: string; assistant_message: string } | undefined;

    // If existing, remove old FTS entry using FTS5 delete command
    if (existing) {
      db.prepare(
        `INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message) VALUES('delete', ?, ?, ?)`,
      ).run(existing.rowid, existing.user_message, existing.assistant_message);
    }

    // 2. Insert/replace exchange row
    db.prepare(`
      INSERT OR REPLACE INTO exchanges
        (id, conversation_id, project, timestamp, user_message, assistant_message,
         session_id, cwd, git_branch, model_version, exchange_index, token_estimate,
         created_at, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exchange.id,
      exchange.conversationId,
      exchange.project,
      exchange.timestamp,
      exchange.userMessage,
      exchange.assistantMessage,
      exchange.sessionId ?? null,
      exchange.cwd ?? null,
      exchange.gitBranch ?? null,
      exchange.modelVersion ?? null,
      exchange.exchangeIndex,
      exchange.tokenEstimate,
      exchange.createdAt,
      exchange.lastAccessed ?? null,
    );

    // 3. Get rowid and insert new FTS entry
    const row = db
      .prepare("SELECT rowid FROM exchanges WHERE id = ?")
      .get(exchange.id) as { rowid: number } | undefined;

    if (row) {
      db.prepare(
        `INSERT INTO exchanges_fts(rowid, user_message, assistant_message) VALUES (?, ?, ?)`,
      ).run(row.rowid, exchange.userMessage, exchange.assistantMessage);
    }

    // 3. Insert into vec0 (delete first — vec0 doesn't support REPLACE)
    db.prepare("DELETE FROM vec_exchanges WHERE id = ?").run(exchange.id);
    db.prepare(
      "INSERT INTO vec_exchanges(id, embedding) VALUES (?, ?)",
    ).run(
      exchange.id,
      Buffer.from(new Float32Array(embedding).buffer),
    );

    // 4. Insert tool calls
    for (const tc of toolCalls) {
      db.prepare(`
        INSERT OR REPLACE INTO tool_calls
          (id, exchange_id, tool_name, tool_input, tool_result_summary, is_error, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        tc.id,
        exchange.id,
        tc.toolName,
        tc.toolInput ?? null,
        tc.toolResultSummary ?? null,
        tc.isError ? 1 : 0,
        tc.timestamp ?? null,
      );
    }
  });

  run();
}

/**
 * Upsert a conversation record.
 */
export function upsertConversation(
  db: Database.Database,
  conversation: Conversation,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO conversations
      (id, project, started_at, ended_at, exchange_count, summary,
       primary_topics, archive_path, last_indexed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    conversation.id,
    conversation.project,
    conversation.startedAt ?? null,
    conversation.endedAt ?? null,
    conversation.exchangeCount,
    conversation.summary ?? null,
    conversation.primaryTopics
      ? JSON.stringify(conversation.primaryTopics)
      : null,
    conversation.archivePath ?? null,
    conversation.lastIndexed ?? null,
  );
}

/**
 * Get a conversation by ID.
 */
export function getConversation(
  db: Database.Database,
  id: string,
): Conversation | null {
  const row = db
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    project: row.project as string,
    startedAt: row.started_at as string | undefined,
    endedAt: row.ended_at as string | undefined,
    exchangeCount: row.exchange_count as number,
    summary: row.summary as string | undefined,
    primaryTopics: row.primary_topics
      ? JSON.parse(row.primary_topics as string)
      : undefined,
    archivePath: row.archive_path as string | undefined,
    lastIndexed: row.last_indexed as number | undefined,
  };
}

/**
 * Get an exchange by ID.
 */
export function getExchange(
  db: Database.Database,
  id: string,
): Exchange | null {
  const row = db
    .prepare("SELECT * FROM exchanges WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    project: row.project as string,
    timestamp: row.timestamp as string,
    userMessage: row.user_message as string,
    assistantMessage: row.assistant_message as string,
    sessionId: row.session_id as string | undefined,
    cwd: row.cwd as string | undefined,
    gitBranch: row.git_branch as string | undefined,
    modelVersion: row.model_version as string | undefined,
    exchangeIndex: row.exchange_index as number,
    tokenEstimate: row.token_estimate as number,
    createdAt: row.created_at as number,
    lastAccessed: row.last_accessed as number | undefined,
  };
}

/**
 * Get tool calls for an exchange.
 */
export function getToolCallsForExchange(
  db: Database.Database,
  exchangeId: string,
): ToolCall[] {
  const rows = db
    .prepare("SELECT * FROM tool_calls WHERE exchange_id = ?")
    .all(exchangeId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    exchangeId: row.exchange_id as string,
    toolName: row.tool_name as string,
    toolInput: row.tool_input as string | undefined,
    toolResultSummary: row.tool_result_summary as string | undefined,
    isError: Boolean(row.is_error),
    timestamp: row.timestamp as string | undefined,
  }));
}
