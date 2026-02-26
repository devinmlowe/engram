import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  deriveConversationId,
  deriveProject,
  estimateTokens,
  mapSourceToTarget,
  mapToolCall,
  ensureCheckpointTable,
  saveCheckpoint,
  getCheckpoint,
} from "../../src/migration/migrate.js";
import type { SourceExchange } from "../../src/migration/types.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";

// ─── Pure Function Tests ────────────────────────────────────────

describe("deriveConversationId", () => {
  it("extracts UUID from archive path", () => {
    const path =
      "/Users/user/.local/share/engram/archive/myproject/abc-123-def-456.jsonl";
    expect(deriveConversationId(path)).toBe("abc-123-def-456");
  });

  it("handles paths without .jsonl extension", () => {
    const path = "/some/path/uuid-value.jsonl";
    expect(deriveConversationId(path)).toBe("uuid-value");
  });

  it("handles bare filename", () => {
    expect(deriveConversationId("conversation-id.jsonl")).toBe(
      "conversation-id",
    );
  });
});

describe("deriveProject", () => {
  it("extracts project name from archive path directory", () => {
    const path =
      "/Users/user/.claude/projects/-Users-user-Documents-git-engram/abc.jsonl";
    expect(deriveProject(path)).toBe("engram");
  });

  it("handles simple directory names", () => {
    const path = "/archive/my-project/conv.jsonl";
    expect(deriveProject(path)).toBe("project");
  });
});

describe("estimateTokens", () => {
  it("estimates tokens as character count / 4", () => {
    const user = "Hello world"; // 11 chars
    const assistant = "Hi there!"; // 9 chars
    // (11 + 9) / 4 = 5
    expect(estimateTokens(user, assistant)).toBe(5);
  });

  it("rounds up fractional tokens", () => {
    const user = "Hi"; // 2 chars
    const assistant = "Hello"; // 5 chars
    // (2 + 5) / 4 = 1.75, ceil = 2
    expect(estimateTokens(user, assistant)).toBe(2);
  });

  it("handles empty strings", () => {
    expect(estimateTokens("", "")).toBe(0);
  });

  it("handles long messages", () => {
    const user = "a".repeat(4000);
    const assistant = "b".repeat(4000);
    expect(estimateTokens(user, assistant)).toBe(2000);
  });
});

describe("mapSourceToTarget", () => {
  const source: SourceExchange = {
    id: "exch-001",
    project: "test-project",
    timestamp: "2026-01-15T10:30:00Z",
    user_message: "How do I use SQLite?",
    assistant_message: "SQLite is a lightweight database engine...",
    archive_path:
      "/archive/-Users-user-Documents-git-myproject/conv-uuid.jsonl",
    line_start: 0,
    line_end: 50,
    session_id: "sess-001",
    cwd: "/Users/user/Documents/git/myproject",
    git_branch: "main",
    claude_version: "claude-sonnet-4-20250514",
    is_sidechain: 0,
  };

  it("maps all fields correctly", () => {
    const result = mapSourceToTarget(source, 3);

    expect(result.id).toBe("exch-001");
    expect(result.conversationId).toBe("conv-uuid");
    expect(result.project).toBe("myproject");
    expect(result.timestamp).toBe("2026-01-15T10:30:00Z");
    expect(result.userMessage).toBe("How do I use SQLite?");
    expect(result.assistantMessage).toBe(
      "SQLite is a lightweight database engine...",
    );
    expect(result.sessionId).toBe("sess-001");
    expect(result.cwd).toBe("/Users/user/Documents/git/myproject");
    expect(result.gitBranch).toBe("main");
    expect(result.modelVersion).toBe("claude-sonnet-4-20250514");
    expect(result.exchangeIndex).toBe(3);
    expect(result.tokenEstimate).toBeGreaterThan(0);
    expect(result.createdAt).toBeGreaterThan(0);
  });

  it("handles null optional fields", () => {
    const sourceWithNulls: SourceExchange = {
      ...source,
      session_id: null,
      cwd: null,
      git_branch: null,
      claude_version: null,
    };

    const result = mapSourceToTarget(sourceWithNulls, 0);
    expect(result.sessionId).toBeUndefined();
    expect(result.cwd).toBeUndefined();
    expect(result.gitBranch).toBeUndefined();
    expect(result.modelVersion).toBeUndefined();
  });
});

describe("mapToolCall", () => {
  it("maps fields correctly", () => {
    const source = {
      id: "tc-001",
      exchange_id: "exch-001",
      tool_name: "Read",
      tool_input: '{"path": "/some/file.ts"}',
      tool_result: "File contents here...",
      is_error: 0,
      timestamp: "2026-01-15T10:30:01Z",
    };

    const result = mapToolCall(source);

    expect(result.id).toBe("tc-001");
    expect(result.exchangeId).toBe("exch-001");
    expect(result.toolName).toBe("Read");
    expect(result.toolInput).toBe('{"path": "/some/file.ts"}');
    expect(result.toolResultSummary).toBe("File contents here...");
    expect(result.isError).toBe(false);
    expect(result.timestamp).toBe("2026-01-15T10:30:01Z");
  });

  it("truncates long tool_input to 1000 chars", () => {
    const longInput = "x".repeat(2000);
    const result = mapToolCall({
      id: "tc-002",
      exchange_id: "exch-001",
      tool_name: "Write",
      tool_input: longInput,
      tool_result: null,
      is_error: 0,
      timestamp: null,
    });

    expect(result.toolInput).toHaveLength(1000);
  });

  it("truncates long tool_result to 500 chars", () => {
    const longResult = "y".repeat(1000);
    const result = mapToolCall({
      id: "tc-003",
      exchange_id: "exch-001",
      tool_name: "Bash",
      tool_input: null,
      tool_result: longResult,
      is_error: 1,
      timestamp: null,
    });

    expect(result.toolResultSummary).toHaveLength(500);
    expect(result.isError).toBe(true);
  });

  it("handles null inputs", () => {
    const result = mapToolCall({
      id: "tc-004",
      exchange_id: "exch-001",
      tool_name: "Search",
      tool_input: null,
      tool_result: null,
      is_error: null,
      timestamp: null,
    });

    expect(result.toolInput).toBeUndefined();
    expect(result.toolResultSummary).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(result.timestamp).toBeUndefined();
  });
});

// ─── Checkpoint Tests (require DB) ──────────────────────────────

describe("Checkpoint Management", () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
  });

  afterEach(() => {
    t.cleanup();
  });

  it("ensureCheckpointTable creates the table", () => {
    ensureCheckpointTable(t.db);

    const tables = t.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='migration_checkpoints'",
      )
      .all() as { name: string }[];

    expect(tables).toHaveLength(1);
  });

  it("ensureCheckpointTable is idempotent", () => {
    ensureCheckpointTable(t.db);
    ensureCheckpointTable(t.db); // Should not throw
  });

  it("getCheckpoint returns null when empty", () => {
    ensureCheckpointTable(t.db);
    expect(getCheckpoint(t.db)).toBeNull();
  });

  it("saveCheckpoint + getCheckpoint round-trips", () => {
    ensureCheckpointTable(t.db);

    const checkpoint = {
      lastExchangeId: "exch-050",
      processedCount: 50,
      timestamp: 1700000000,
      phase: "embedding",
    };

    saveCheckpoint(t.db, checkpoint);

    const retrieved = getCheckpoint(t.db);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.lastExchangeId).toBe("exch-050");
    expect(retrieved!.processedCount).toBe(50);
    expect(retrieved!.timestamp).toBe(1700000000);
    expect(retrieved!.phase).toBe("embedding");
  });

  it("saveCheckpoint overwrites previous checkpoint", () => {
    ensureCheckpointTable(t.db);

    saveCheckpoint(t.db, {
      lastExchangeId: "exch-010",
      processedCount: 10,
      timestamp: 1700000000,
      phase: "embedding",
    });

    saveCheckpoint(t.db, {
      lastExchangeId: "exch-100",
      processedCount: 100,
      timestamp: 1700001000,
      phase: "tool_calls",
    });

    const retrieved = getCheckpoint(t.db);
    expect(retrieved!.lastExchangeId).toBe("exch-100");
    expect(retrieved!.processedCount).toBe(100);
    expect(retrieved!.phase).toBe("tool_calls");
  });
});
