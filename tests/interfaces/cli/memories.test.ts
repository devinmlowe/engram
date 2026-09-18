/**
 * `engram memories` (#55): the subcommand tree is registered on the CLI and
 * the pure formatters print provenance (originating conversation, extractor
 * tier / source, extraction basis, scope, FSRS stats), deletion state and the
 * change log with the `cli` actor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { createTestDb, type TestDb } from "../../helpers.js";
import { insertMemory } from "../../../src/semantic/memory.js";
import { forgetMemory, editMemory } from "../../../src/semantic/forget.js";
import { getMemoryProvenance, listMemories, listMemoryChanges } from "../../../src/semantic/inspect.js";
import { linkMemoryToEntities } from "../../../src/interfaces/shared/remember.js";
import {
  registerMemoriesCommand,
  formatMemoryList,
  formatMemoryShow,
  formatChangeLog,
  formatForgetResult,
} from "../../../src/interfaces/cli/memories.js";

vi.mock("../../../src/_core/embeddings/index.js", () => ({
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  embedDocument: vi.fn().mockImplementation(() => Promise.resolve(new Array(256).fill(1 / 16))),
  embedQuery: vi.fn(),
  getActiveModel: vi.fn().mockReturnValue("mock-model"),
  resetEmbeddings: vi.fn(),
}));

let t: TestDb;
const EMB = new Array(256).fill(1 / 16);

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

describe("engram memories command tree", () => {
  it("registers list, show, edit, delete (alias forget), restore, purge and log", () => {
    const program = new Command();
    registerMemoriesCommand(program);
    const memories = program.commands.find((c) => c.name() === "memories")!;
    expect(memories).toBeDefined();
    expect(memories.commands.map((c) => c.name()).sort()).toEqual(["delete", "edit", "list", "log", "purge", "restore", "show"]);
    expect(memories.commands.find((c) => c.name() === "delete")!.aliases()).toContain("forget");
    const list = memories.commands.find((c) => c.name() === "list")!;
    expect(list.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--type", "--scope", "--since", "--query", "--deleted", "--json"]));
    expect(memories.commands.find((c) => c.name() === "delete")!.options.map((o) => o.long)).toContain("--hard");
    expect(memories.commands.find((c) => c.name() === "purge")!.options.map((o) => o.long)).toContain("--conversation");
    expect(memories.commands.find((c) => c.name() === "log")!.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--memory", "--limit"]));
  });

  it("is wired into the CLI entry point", async () => {
    const { readFileSync } = await import("node:fs");
    const cliSource = readFileSync(new URL("../../../src/interfaces/cli/index.ts", import.meta.url), "utf-8");
    expect(cliSource).toContain("registerMemoriesCommand(program)");
    expect(cliSource).toContain('.command("validate")');
    expect(cliSource).toContain('"--fix"');
  });
});

describe("memories show output", () => {
  it("prints the originating conversation, extractor source/tier, extraction basis, scope and FSRS stats for a dream-extracted memory", () => {
    t.db
      .prepare("INSERT INTO conversations (id, project, summary, started_at, archive_path, scope) VALUES ('conv-9', 'engram', 'Designing the forget tool', '2026-09-17T09:00:00Z', '/archive/conv-9.jsonl', 'global')")
      .run();
    t.db
      .prepare("INSERT INTO exchanges (id, conversation_id, project, timestamp, exchange_index, user_message) VALUES ('x9', 'conv-9', 'engram', '2026-09-17T09:05:00Z', 4, 'Make forget a soft delete with retention')")
      .run();
    insertMemory(
      t.db,
      {
        id: "mem-dream-1",
        type: "decision",
        content: "Forget is a soft delete with a 30-day retention purge",
        confidence: 0.5,
        importance: 0.8,
        accessCount: 3,
        createdAt: 1_758_000_000,
        sourceExchanges: ["x9"],
        isActive: true,
        source: "dream",
        scope: "global",
        extractionBasis: "explicit",
        stability: 42,
      },
      EMB,
    );

    const lines = formatMemoryShow(getMemoryProvenance(t.db, "mem-dream-1")!);
    const text = lines.join("\n");
    expect(text).toContain("Memory mem-dream-1");
    expect(text).toContain("Type:             decision");
    expect(text).toContain("Scope:            global");
    expect(text).toContain("Source:           dream (extracted by the dream pipeline)");
    expect(text).toContain("Extraction basis: explicit");
    expect(text).toContain("Status:           active");
    expect(text).toContain("Stability:          42.0 days");
    expect(text).toMatch(/Retrievability:\s+\d\.\d{3}/);
    expect(text).toContain("Accessed:           3×");
    expect(text).toContain("Embedding:          indexed");
    expect(text).toContain("Conversation conv-9");
    expect(text).toContain("Title:      Designing the forget tool");
    expect(text).toContain('Archive:    /archive/conv-9.jsonl  (MCP: show path="/archive/conv-9.jsonl")');
    expect(text).toContain("#4 x9 (2026-09-17T09:05:00): Make forget a soft delete with retention");
  });

  it("shows deletion state, graph evidence, and the change log with the cli actor", () => {
    t.db.prepare("INSERT INTO entities (id, name, type, mention_count) VALUES ('e1', 'Forget', 'concept', 1), ('e2', 'Retention', 'concept', 1)").run();
    insertMemory(
      t.db,
      { id: "mem-u", type: "fact", content: "Retention defaults to thirty days", confidence: 0.9, importance: 0.7, accessCount: 0, createdAt: 1_758_000_000, sourceExchanges: [], isActive: true, source: "user" },
      EMB,
    );
    linkMemoryToEntities(t.db, "mem-u", ["Forget", "Retention"]);
    const before = formatMemoryShow(getMemoryProvenance(t.db, "mem-u")!).join("\n");
    expect(before).toContain("Provenance:       no source conversation (stored directly via remember)");
    expect(before).toContain("Graph evidence for:");
    expect(before).toContain("Forget (concept, 2 mentions)");

    editMemory(t.db, { memoryId: "mem-u", content: "Retention defaults to 30 days", embedding: EMB, actor: "cli", now: new Date("2026-09-17T10:00:00.000Z") });
    forgetMemory(t.db, { memoryId: "mem-u", actor: "cli", now: new Date("2026-09-17T11:00:00.000Z") });
    const after = formatMemoryShow(getMemoryProvenance(t.db, "mem-u")!).join("\n");
    expect(after).toContain("Status:           forgotten 2026-09-17T11:00:00.000Z by cli (restore with `engram memories restore mem-u`)");
    expect(after).toContain("Embedding:          none");
    expect(after).toContain("Change log:");
    expect(after).toContain("2026-09-17T11:00:00.000Z  forget  mem-u  by cli");
    expect(after).toContain("2026-09-17T10:00:00.000Z  edit    mem-u  by cli");
    expect(after).toContain("- Retention defaults to thirty days");
    expect(after).toContain("+ Retention defaults to 30 days");
  });
});

describe("memories list / log / delete output", () => {
  it("list shows forgotten rows only with --deleted and marks them", () => {
    insertMemory(t.db, { id: "a", type: "fact", content: "alpha", confidence: 0.9, importance: 0.5, accessCount: 0, createdAt: 1_758_000_000, sourceExchanges: [], isActive: true, scope: "hermes:career" }, EMB);
    insertMemory(t.db, { id: "b", type: "fact", content: "beta", confidence: 0.9, importance: 0.5, accessCount: 0, createdAt: 1_758_000_001, sourceExchanges: [], isActive: true }, EMB);
    forgetMemory(t.db, { memoryId: "b", actor: "cli", now: new Date("2026-09-17T00:00:00.000Z") });

    const visible = formatMemoryList(listMemories(t.db)).join("\n");
    expect(visible).toContain("a  ");
    expect(visible).toContain("(hermes:career)");
    expect(visible).not.toContain("beta");
    expect(visible).toContain("1 memory.");

    const all = formatMemoryList(listMemories(t.db, { includeDeleted: true })).join("\n");
    expect(all).toContain("[forgotten 2026-09-17 by cli]");
    expect(all).toContain("2 memories.");
    expect(formatMemoryList([])).toEqual(["No memories match."]);
  });

  it("delete output and the change log", () => {
    insertMemory(t.db, { id: "c", type: "fact", content: "gamma", confidence: 0.9, importance: 0.5, accessCount: 0, createdAt: 1_758_000_000, sourceExchanges: [], isActive: true }, EMB);
    const soft = formatForgetResult(forgetMemory(t.db, { memoryId: "c", actor: "cli" })).join("\n");
    expect(soft).toContain("Forgot c: gamma");
    expect(soft).toContain("engram memories restore c");
    const hard = formatForgetResult(forgetMemory(t.db, { memoryId: "c", actor: "cli", hard: true })).join("\n");
    expect(hard).toContain("Deleted c: gamma");
    expect(hard).not.toContain("restore");

    const log = formatChangeLog(listMemoryChanges(t.db)).join("\n");
    expect(log).toMatch(/purge {3}c {2}by cli/);
    expect(log).toMatch(/forget {2}c {2}by cli/);
    expect(formatChangeLog([])).toEqual(["No changes recorded."]);
  });
});
