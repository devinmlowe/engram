import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  parseConversationFile,
  shouldSkipConversation,
} from "../../src/episodic/parser.js";
import { createTestFixture } from "../helpers.js";

// Track fixtures for cleanup
const fixtures: string[] = [];

function fixture(content: string): string {
  const path = createTestFixture(content);
  fixtures.push(path);
  return path;
}

afterEach(() => {
  for (const f of fixtures) {
    try {
      rmSync(dirname(f), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  fixtures.length = 0;
});

describe("Parser", () => {
  it("parses a simple user-assistant exchange", async () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Hello" },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Hi there!" },
        timestamp: "2026-02-26T10:00:01Z",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result = await parseConversationFile(filePath, "test-project", filePath);

    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0].userMessage).toBe("Hello");
    expect(result.exchanges[0].assistantMessage).toBe("Hi there!");
    expect(result.exchanges[0].project).toBe("test-project");
    expect(result.exchanges[0].exchangeIndex).toBe(0);
  });

  it("pairs multi-turn conversations correctly", async () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Question 1" },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Answer 1" },
        timestamp: "2026-02-26T10:00:01Z",
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Question 2" },
        timestamp: "2026-02-26T10:00:02Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Answer 2" },
        timestamp: "2026-02-26T10:00:03Z",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result = await parseConversationFile(filePath, "test", filePath);

    expect(result.exchanges).toHaveLength(2);
    expect(result.exchanges[0].userMessage).toBe("Question 1");
    expect(result.exchanges[0].assistantMessage).toBe("Answer 1");
    expect(result.exchanges[0].exchangeIndex).toBe(0);
    expect(result.exchanges[1].userMessage).toBe("Question 2");
    expect(result.exchanges[1].assistantMessage).toBe("Answer 2");
    expect(result.exchanges[1].exchangeIndex).toBe(1);
  });

  it("accumulates multiple assistant messages", async () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Do something" },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "First part" },
        timestamp: "2026-02-26T10:00:01Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Second part" },
        timestamp: "2026-02-26T10:00:02Z",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result = await parseConversationFile(filePath, "test", filePath);

    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0].assistantMessage).toBe("First part\n\nSecond part");
  });

  it("extracts tool_use blocks from assistant content arrays", async () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Read file.ts" },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me read that file." },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "/tmp/file.ts" },
            },
          ],
        },
        timestamp: "2026-02-26T10:00:01Z",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result = await parseConversationFile(filePath, "test", filePath);

    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0].assistantMessage).toBe("Let me read that file.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe("Read");
    expect(result.toolCalls[0].exchangeId).toBe(result.exchanges[0].id);
  });

  it("handles content as string (not array)", async () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Simple string content" },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Simple response" },
        timestamp: "2026-02-26T10:00:01Z",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result = await parseConversationFile(filePath, "test", filePath);

    expect(result.exchanges[0].userMessage).toBe("Simple string content");
    expect(result.exchanges[0].assistantMessage).toBe("Simple response");
  });

  it("skips malformed JSON lines", async () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Hello" },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      "this is not valid json {{{",
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "World" },
        timestamp: "2026-02-26T10:00:01Z",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result = await parseConversationFile(filePath, "test", filePath);

    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0].userMessage).toBe("Hello");
  });

  it("generates deterministic exchange IDs", async () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Deterministic" },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Response" },
        timestamp: "2026-02-26T10:00:01Z",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result1 = await parseConversationFile(filePath, "test", filePath);
    const result2 = await parseConversationFile(filePath, "test", filePath);

    expect(result1.exchanges[0].id).toBe(result2.exchanges[0].id);
  });

  it("extracts conversationId from filename", async () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Hi" },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Hello" },
        timestamp: "2026-02-26T10:00:01Z",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result = await parseConversationFile(filePath, "test", filePath);

    // The fixture filename is "test-conversation.jsonl" → id = "test-conversation"
    expect(result.conversationId).toBe("test-conversation");
  });

  it("estimates token count", async () => {
    const userMsg = "A".repeat(100);
    const assistantMsg = "B".repeat(300);
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: userMsg },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: assistantMsg },
        timestamp: "2026-02-26T10:00:01Z",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result = await parseConversationFile(filePath, "test", filePath);

    // Token estimate = ceil((100 + 300) / 4) = 100
    expect(result.exchanges[0].tokenEstimate).toBe(100);
  });

  it("extracts metadata (sessionId, cwd, gitBranch)", async () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Hi" },
        timestamp: "2026-02-26T10:00:00Z",
        sessionId: "sess-123",
        cwd: "/home/user/project",
        gitBranch: "feature-branch",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Hello" },
        timestamp: "2026-02-26T10:00:01Z",
        version: "1.2.3",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result = await parseConversationFile(filePath, "test", filePath);

    expect(result.exchanges[0].sessionId).toBe("sess-123");
    expect(result.exchanges[0].cwd).toBe("/home/user/project");
    expect(result.exchanges[0].gitBranch).toBe("feature-branch");
    expect(result.exchanges[0].modelVersion).toBe("1.2.3");
    expect(result.metadata.sessionId).toBe("sess-123");
  });

  it("skips non-message types", async () => {
    const jsonl = [
      JSON.stringify({ type: "system", message: { content: "system msg" } }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Hello" },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "file-history-snapshot",
        files: ["/tmp/test.ts"],
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Hi" },
        timestamp: "2026-02-26T10:00:01Z",
      }),
    ].join("\n");

    const filePath = fixture(jsonl);
    const result = await parseConversationFile(filePath, "test", filePath);

    expect(result.exchanges).toHaveLength(1);
  });
});

describe("shouldSkipConversation", () => {
  it("returns true for DO NOT INDEX marker", () => {
    const jsonl = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content:
          "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>",
      },
      timestamp: "2026-02-26T10:00:00Z",
    });

    const filePath = fixture(jsonl);
    expect(shouldSkipConversation(filePath)).toBe(true);
  });

  it("returns false for normal conversations", () => {
    const jsonl = JSON.stringify({
      type: "user",
      message: { role: "user", content: "Normal conversation" },
      timestamp: "2026-02-26T10:00:00Z",
    });

    const filePath = fixture(jsonl);
    expect(shouldSkipConversation(filePath)).toBe(false);
  });

  it("returns false for non-existent files", () => {
    expect(shouldSkipConversation("/nonexistent/path.jsonl")).toBe(false);
  });
});
