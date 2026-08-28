import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";

// Wrap (not replace) embedExchange so tests can count real embedding calls
vi.mock("../../src/_core/embeddings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/_core/embeddings/index.js")>();
  return { ...actual, embedExchange: vi.fn(actual.embedExchange) };
});
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  syncConversations,
  discoverConversations,
  extractProjectName,
} from "../../src/episodic/sync.js";
import { getConversation } from "../../src/episodic/store.js";
import { initEmbeddings, embedExchange } from "../../src/_core/embeddings/index.js";
import { createTestDb } from "../helpers.js";
import type { TestDb } from "../helpers.js";

// ─── Unit Tests ────────────────────────────────────────────────

describe("extractProjectName", () => {
  it("extracts last segment from encoded dir name", () => {
    expect(extractProjectName("-Users-devinmlowe-Documents-git-engram")).toBe("engram");
  });

  it("handles single-segment names", () => {
    expect(extractProjectName("myproject")).toBe("myproject");
  });

  it("handles trailing separator", () => {
    expect(extractProjectName("-Users-home-project")).toBe("project");
  });
});

describe("discoverConversations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "engram-disc-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .jsonl files in project directories", () => {
    const projectDir = join(tmpDir, "-Users-test-project1");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "conv1.jsonl"), "");
    writeFileSync(join(projectDir, "conv2.jsonl"), "");
    writeFileSync(join(projectDir, "notes.txt"), ""); // Not a jsonl

    const files = discoverConversations(tmpDir);
    expect(files).toHaveLength(2);
    expect(files[0].project).toBe("project1");
    expect(files.every((f) => f.file.endsWith(".jsonl"))).toBe(true);
  });

  it("handles multiple projects", () => {
    for (const proj of ["proj-a", "proj-b"]) {
      const dir = join(tmpDir, proj);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "conv.jsonl"), "");
    }

    const files = discoverConversations(tmpDir);
    expect(files).toHaveLength(2);
  });

  it("returns empty for non-existent directory", () => {
    expect(discoverConversations("/nonexistent/path")).toEqual([]);
  });

  it("returns empty for empty directory", () => {
    expect(discoverConversations(tmpDir)).toEqual([]);
  });
});

// ─── Integration Tests ─────────────────────────────────────────

describe("syncConversations (integration)", () => {
  let t: TestDb;
  let projectsDir: string;

  beforeAll(async () => {
    await initEmbeddings();
  }, 120_000);

  beforeEach(() => {
    t = createTestDb();
    projectsDir = mkdtempSync(join(tmpdir(), "engram-projects-"));

    // Override config to use temp dirs
    t.config.claudeProjectsDir = projectsDir;
    t.config.archiveDir = join(t.tmpDir, "archive");
  });

  afterEach(() => {
    t.cleanup();
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function createProjectConversation(
    project: string,
    conversationId: string,
    exchanges: Array<{ user: string; assistant: string }>,
  ) {
    const dir = join(projectsDir, project);
    mkdirSync(dir, { recursive: true });

    const lines = exchanges.flatMap((ex, i) => [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: ex.user },
        timestamp: `2026-02-26T10:0${i}:00Z`,
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: ex.assistant },
        timestamp: `2026-02-26T10:0${i}:01Z`,
      }),
    ]);

    writeFileSync(join(dir, `${conversationId}.jsonl`), lines.join("\n"));
  }

  it("syncs a simple conversation end-to-end", async () => {
    createProjectConversation("test-project", "conv-001", [
      { user: "What is SQLite?", assistant: "SQLite is a database engine..." },
    ]);

    const result = await syncConversations(t.db, t.config);

    expect(result.discovered).toBe(1);
    expect(result.indexed).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify conversation was stored
    const conv = getConversation(t.db, "conv-001");
    expect(conv).not.toBeNull();
    expect(conv!.exchangeCount).toBe(1);
    expect(conv!.lastIndexed).toBeGreaterThan(0);
  });

  it("copies files to archive", async () => {
    createProjectConversation("my-project", "conv-archive", [
      { user: "Test", assistant: "Response" },
    ]);

    await syncConversations(t.db, t.config);

    const archivePath = join(t.config.archiveDir, "project", "conv-archive.jsonl");
    expect(existsSync(archivePath)).toBe(true);
  });

  it("is idempotent — re-sync skips already indexed", async () => {
    createProjectConversation("test-project", "conv-idem", [
      { user: "Test", assistant: "Response" },
    ]);

    const result1 = await syncConversations(t.db, t.config);
    expect(result1.indexed).toBe(1);

    const result2 = await syncConversations(t.db, t.config);
    expect(result2.skipped).toBe(1);
    expect(result2.indexed).toBe(0);
  });

  it("a grown conversation only embeds the NEW exchanges", async () => {
    createProjectConversation("test-project", "conv-grow", [
      { user: "First question", assistant: "First answer" },
      { user: "Second question", assistant: "Second answer" },
    ]);
    await syncConversations(t.db, t.config);
    vi.mocked(embedExchange).mockClear();

    // Same conversation gains one exchange; bump mtime so the copy is detected
    createProjectConversation("test-project", "conv-grow", [
      { user: "First question", assistant: "First answer" },
      { user: "Second question", assistant: "Second answer" },
      { user: "Third question", assistant: "Third answer" },
    ]);
    const src = join(projectsDir, "test-project", "conv-grow.jsonl");
    const future = new Date(Date.now() + 5_000);
    utimesSync(src, future, future);

    const result = await syncConversations(t.db, t.config);
    expect(result.indexed).toBe(1);
    expect(vi.mocked(embedExchange)).toHaveBeenCalledTimes(1);
    const count = t.db.prepare("SELECT COUNT(*) AS n FROM exchanges WHERE conversation_id = 'conv-grow'").get() as { n: number };
    expect(count.n).toBe(3);
    expect(getConversation(t.db, "conv-grow")!.exchangeCount).toBe(3);
  });

  it("force flag re-indexes everything", async () => {
    createProjectConversation("test-project", "conv-force", [
      { user: "Test", assistant: "Response" },
    ]);

    await syncConversations(t.db, t.config);
    const result = await syncConversations(t.db, t.config, { force: true });

    expect(result.indexed).toBe(1);
  });

  it("handles multiple conversations across projects", async () => {
    createProjectConversation("proj-a", "conv-a1", [
      { user: "Hello from A", assistant: "Hi A!" },
    ]);
    createProjectConversation("proj-b", "conv-b1", [
      { user: "Hello from B", assistant: "Hi B!" },
    ]);

    const result = await syncConversations(t.db, t.config);

    expect(result.discovered).toBe(2);
    expect(result.indexed).toBe(2);
  });

  it("skips conversations with exclusion markers", async () => {
    const dir = join(projectsDir, "test-project");
    mkdirSync(dir, { recursive: true });

    const lines = [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content:
            "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>",
        },
        timestamp: "2026-02-26T10:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "OK, skipping" },
        timestamp: "2026-02-26T10:00:01Z",
      }),
    ];
    writeFileSync(join(dir, "skip-me.jsonl"), lines.join("\n"));

    const result = await syncConversations(t.db, t.config);
    expect(result.skipped).toBe(1);
    expect(result.indexed).toBe(0);
  });

  it("dry run reports discovery without indexing", async () => {
    createProjectConversation("test-project", "conv-dry", [
      { user: "Test", assistant: "Response" },
    ]);

    const result = await syncConversations(t.db, t.config, { dryRun: true });
    expect(result.discovered).toBeGreaterThan(0);
    expect(result.indexed).toBe(0);

    const conv = getConversation(t.db, "conv-dry");
    expect(conv).toBeNull();
  });

  it("filters by project name", async () => {
    createProjectConversation("proj-a", "conv-a", [
      { user: "A", assistant: "A response" },
    ]);
    createProjectConversation("proj-b", "conv-b", [
      { user: "B", assistant: "B response" },
    ]);

    const result = await syncConversations(t.db, t.config, { project: "a" });

    expect(result.indexed).toBe(1);
    expect(getConversation(t.db, "conv-a")).not.toBeNull();
    expect(getConversation(t.db, "conv-b")).toBeNull();
  });
});
