/**
 * W2: `ingest_turn` MCP tool — episodic ingest for Hermes turns.
 *
 * Hermes conversations never reached engram's episodic layer (only Claude
 * Code JSONL transcripts do, via the dream ingest phase). This tool lets a
 * Hermes profile push one user/assistant turn at a time. Exercises the real
 * `handleToolCall` against a temp DB with deterministic mock embeddings.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

vi.mock("../../../src/_core/embeddings/index.js", async () =>
  (await import("../../mocks/embeddings.js")).deterministicEmbeddings(),
);

const tmpDir = mkdtempSync(join(tmpdir(), "engram-ingest-turn-"));
process.env.ENGRAM_DB_PATH = join(tmpDir, "ingest.db");
process.env.ENGRAM_DATA_DIR = tmpDir;
delete process.env.ENGRAM_SCOPE;
delete process.env.ENGRAM_READ_SCOPES;

function openRo(): Database.Database {
  const db = new Database(process.env.ENGRAM_DB_PATH!, { readonly: true });
  sqliteVec.load(db); // vec_exchanges is a vec0 virtual table
  return db;
}

function exchangesFor(sessionId: string): Array<{ id: string; conversation_id: string; exchange_index: number; user_message: string; assistant_message: string }> {
  const db = openRo();
  try {
    return db
      .prepare(
        "SELECT id, conversation_id, exchange_index, user_message, assistant_message FROM exchanges WHERE session_id = ? ORDER BY exchange_index",
      )
      .all(sessionId) as Array<{ id: string; conversation_id: string; exchange_index: number; user_message: string; assistant_message: string }>;
  } finally {
    db.close();
  }
}

function conversationsFor(conversationId: string): Array<{ id: string; scope: string; exchange_count: number; project: string }> {
  const db = openRo();
  try {
    return db
      .prepare("SELECT id, scope, exchange_count, project FROM conversations WHERE id = ?")
      .all(conversationId) as Array<{ id: string; scope: string; exchange_count: number; project: string }>;
  } finally {
    db.close();
  }
}

function ftsHits(term: string): number {
  const db = openRo();
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH ?")
      .get(term) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function vecCount(exchangeId: string): number {
  const db = openRo();
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM vec_exchanges WHERE id = ?")
      .get(exchangeId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function toolCallsFor(exchangeId: string): Array<{ tool_name: string; tool_input: string | null; tool_result_summary: string | null }> {
  const db = openRo();
  try {
    return db
      .prepare("SELECT tool_name, tool_input, tool_result_summary FROM tool_calls WHERE exchange_id = ? ORDER BY id")
      .all(exchangeId) as Array<{ tool_name: string; tool_input: string | null; tool_result_summary: string | null }>;
  } finally {
    db.close();
  }
}

describe("ingest_turn MCP tool", () => {
  let handleToolCall: typeof import("../../../src/interfaces/mcp/server.js").handleToolCall;

  beforeAll(async () => {
    ({ handleToolCall } = await import("../../../src/interfaces/mcp/server.js"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is registered in MCP_TOOL_NAMES and dispatched to workers", async () => {
    const { MCP_TOOL_NAMES } = await import("../../../src/interfaces/mcp/tool-names.js");
    const { WORKER_TOOLS } = await import("../../../src/interfaces/mcp/dispatch.js");
    expect(MCP_TOOL_NAMES).toContain("ingest_turn");
    expect(WORKER_TOOLS.has("ingest_turn")).toBe(true);
  });

  it("creates a conversation + exchange, FTS-searchable, with vector and tool calls", async () => {
    const res = await handleToolCall("ingest_turn", {
      session_id: "sess-alpha",
      turn_index: 0,
      scope: "hermes:career",
      user_text: "Did the Databricks recruiter reply about the zebrafish role?",
      assistant_text: "Yes, the recruiter confirmed the zebrafish interview for Thursday.",
      tool_calls: [{ name: "email_search", input: { q: "Databricks" }, output: "1 result" }],
      timestamp: "2026-09-16T10:00:00.000Z",
    });
    expect(res.isError, res.content[0].text as string).toBeFalsy();

    const exchanges = exchangesFor("sess-alpha");
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].exchange_index).toBe(0);
    expect(exchanges[0].user_message).toContain("zebrafish");

    const convs = conversationsFor(exchanges[0].conversation_id);
    expect(convs).toHaveLength(1);
    expect(convs[0].exchange_count).toBe(1);

    expect(ftsHits("zebrafish")).toBe(1);
    expect(vecCount(exchanges[0].id)).toBe(1);

    const tcs = toolCallsFor(exchanges[0].id);
    expect(tcs).toHaveLength(1);
    expect(tcs[0].tool_name).toBe("email_search");
    expect(JSON.parse(tcs[0].tool_input!)).toEqual({ q: "Databricks" });
    expect(tcs[0].tool_result_summary).toBe("1 result");

    const text = res.content[0].text as string;
    expect(text).toContain(exchanges[0].conversation_id);
  });

  it("re-ingesting the same (session_id, turn_index) updates in place — no duplicates", async () => {
    const res = await handleToolCall("ingest_turn", {
      session_id: "sess-alpha",
      turn_index: 0,
      scope: "hermes:career",
      user_text: "Did the Databricks recruiter reply about the quokka role?",
      assistant_text: "Yes — updated answer.",
      tool_calls: [],
    });
    expect(res.isError, res.content[0].text as string).toBeFalsy();

    const exchanges = exchangesFor("sess-alpha");
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].user_message).toContain("quokka");
    expect(exchanges[0].assistant_message).toBe("Yes — updated answer.");

    // FTS reflects the new text only
    expect(ftsHits("quokka")).toBe(1);
    expect(ftsHits("zebrafish")).toBe(0);
    // single vector row, previous tool calls cleared
    expect(vecCount(exchanges[0].id)).toBe(1);
    expect(toolCallsFor(exchanges[0].id)).toHaveLength(0);
    expect(conversationsFor(exchanges[0].conversation_id)[0].exchange_count).toBe(1);
  });

  it("two turns in one session → one conversation, two exchanges in order", async () => {
    const res = await handleToolCall("ingest_turn", {
      session_id: "sess-alpha",
      turn_index: 1,
      scope: "hermes:career",
      user_text: "Add it to the calendar.",
      assistant_text: "Done, Thursday 10am.",
    });
    expect(res.isError, res.content[0].text as string).toBeFalsy();

    const exchanges = exchangesFor("sess-alpha");
    expect(exchanges).toHaveLength(2);
    expect(exchanges.map((e) => e.exchange_index)).toEqual([0, 1]);
    expect(new Set(exchanges.map((e) => e.conversation_id)).size).toBe(1);

    const convs = conversationsFor(exchanges[0].conversation_id);
    expect(convs).toHaveLength(1);
    expect(convs[0].exchange_count).toBe(2);
  });

  it("persists the scope on the conversation and defaults source to hermes", async () => {
    const exchanges = exchangesFor("sess-alpha");
    const conv = conversationsFor(exchanges[0].conversation_id)[0];
    expect(conv.scope).toBe("hermes:career");
    expect(conv.project).toBe("hermes");
  });

  it("different sessions and sources get different conversations", async () => {
    await handleToolCall("ingest_turn", {
      session_id: "sess-beta",
      turn_index: 0,
      scope: "hermes:pmp",
      user_text: "When is the PMP exam?",
      assistant_text: "February 2027.",
    });
    await handleToolCall("ingest_turn", {
      session_id: "sess-beta",
      turn_index: 0,
      scope: "hermes:pmp",
      source: "other-agent",
      user_text: "When is the PMP exam?",
      assistant_text: "February 2027.",
    });
    const beta = exchangesFor("sess-beta");
    expect(beta).toHaveLength(2);
    expect(new Set(beta.map((e) => e.conversation_id)).size).toBe(2);
    expect(new Set(exchangesFor("sess-alpha").map((e) => e.conversation_id)).size).toBe(1);
  });

  it("persists author as JSON on the exchange row; absent author stays NULL (#18)", async () => {
    const withAuthor = await handleToolCall("ingest_turn", {
      session_id: "sess-author",
      turn_index: 0,
      scope: "hermes:career",
      user_text: "who am I?",
      assistant_text: "Devin.",
      author: { id: "u-1", name: "devin", is_bot: false },
    });
    expect(withAuthor.isError, withAuthor.content[0].text as string).toBeFalsy();
    const without = await handleToolCall("ingest_turn", {
      session_id: "sess-author",
      turn_index: 1,
      scope: "hermes:career",
      user_text: "and now?",
      assistant_text: "Still Devin.",
    });
    expect(without.isError, without.content[0].text as string).toBeFalsy();

    const db = openRo();
    try {
      const rows = db
        .prepare("SELECT exchange_index, author_json FROM exchanges WHERE session_id = ? ORDER BY exchange_index")
        .all("sess-author") as Array<{ exchange_index: number; author_json: string | null }>;
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0].author_json!)).toEqual({ id: "u-1", name: "devin", is_bot: false });
      expect(rows[1].author_json).toBeNull();
    } finally {
      db.close();
    }

    // getExchange exposes it; an unknown author key is rejected by the schema
    const { getExchange } = await import("../../../src/episodic/store.js");
    const ro = openRo();
    try {
      expect(getExchange(ro, "hermes:sess-author:0")?.authorJson).toBe(JSON.stringify({ id: "u-1", name: "devin", is_bot: false }));
      expect(getExchange(ro, "hermes:sess-author:1")?.authorJson).toBeUndefined();
    } finally {
      ro.close();
    }
    const badAuthor = await handleToolCall("ingest_turn", {
      session_id: "sess-author",
      turn_index: 2,
      scope: "hermes:career",
      user_text: "x",
      assistant_text: "y",
      author: { id: "u-1", handle: "nope" },
    });
    expect(badAuthor.isError).toBe(true);
    expect(exchangesFor("sess-author")).toHaveLength(2);
  });

  it("rejects an invalid scope and missing required fields", async () => {
    const base = {
      session_id: "sess-bad",
      turn_index: 0,
      scope: "hermes:x",
      user_text: "hi",
      assistant_text: "hello",
    };
    const blankScope = await handleToolCall("ingest_turn", { ...base, scope: "   " });
    expect(blankScope.isError).toBe(true);
    expect(blankScope.content[0].text as string).toMatch(/scope/i);

    const noScope = await handleToolCall("ingest_turn", { ...base, scope: undefined });
    expect(noScope.isError).toBe(true);

    const noSession = await handleToolCall("ingest_turn", { ...base, session_id: undefined });
    expect(noSession.isError).toBe(true);

    const negTurn = await handleToolCall("ingest_turn", { ...base, turn_index: -1 });
    expect(negTurn.isError).toBe(true);

    const fracTurn = await handleToolCall("ingest_turn", { ...base, turn_index: 1.5 });
    expect(fracTurn.isError).toBe(true);

    const noUser = await handleToolCall("ingest_turn", { ...base, user_text: undefined });
    expect(noUser.isError).toBe(true);

    const noAssistant = await handleToolCall("ingest_turn", { ...base, assistant_text: undefined });
    expect(noAssistant.isError).toBe(true);

    const badTs = await handleToolCall("ingest_turn", { ...base, timestamp: "not-a-date" });
    expect(badTs.isError).toBe(true);

    expect(exchangesFor("sess-bad")).toHaveLength(0);
  });
});
