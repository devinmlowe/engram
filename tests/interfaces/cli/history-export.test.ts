/**
 * `engram history export` — custody export hook.
 * Acceptance suite SPEC-010 (docs/memory-history.md).
 *
 * RED against main @ abf0c28: src/_core/db/history.ts and
 * src/interfaces/cli/history.ts do not exist there, so these fail with a
 * module-not-found inside the test body — the "not implemented" signal —
 * never a fixture error.
 *
 * Mirrors the repo's existing CLI test pattern (tests/interfaces/cli/
 * memories.test.ts): pure registration + formatter tests against a
 * throwaway temp DB, plus an entry-point wiring scan; no process spawn.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createTestDb, type TestDb } from "../../helpers.js";
import { deterministicVector as vec } from "../../mocks/embeddings.js";
import { insertMemory } from "../../../src/semantic/memory.js";
import { editMemory } from "../../../src/semantic/forget.js";
import type { Memory } from "../../../src/semantic/types.js";

/** The core export surface (src/_core/db/history.ts — new module). */
async function historyApi() {
  return await import("../../../src/_core/db/history.js");
}

/** The CLI surface (src/interfaces/cli/history.ts — new module). */
async function cliApi() {
  return await import("../../../src/interfaces/cli/history.js");
}

let t: TestDb;

function seed(id: string, content: string): void {
  const memory: Memory = {
    id,
    type: "fact",
    content,
    confidence: 0.9,
    importance: 0.7,
    accessCount: 0,
    createdAt: Math.floor(Date.now() / 1000),
    sourceExchanges: [],
    isActive: true,
    source: "user",
    scope: "global",
  };
  insertMemory(t.db, memory, vec(`doc:${content}`));
}

beforeEach(() => {
  t = createTestDb();
});

afterEach(() => {
  t.cleanup();
});

describe("SPEC-010 export hook — cursor semantics", () => {
  it("listMemoryHistory returns every row ordered by id ASC", async () => {
    const { listMemoryHistory } = (await historyApi()) as {
      listMemoryHistory: (db: TestDb["db"], opts?: { sinceId?: number }) => unknown[];
    };
    seed("m1", "one");
    seed("m2", "two");
    editMemory(t.db, {
      memoryId: "m1",
      content: "one edited",
      embedding: vec("doc:one edited"),
      actor: "cli",
      now: new Date("2026-09-17T10:00:00Z"),
    });
    const rows = listMemoryHistory(t.db) as Array<{ id: number; mechanism: string; memoryId: string }>;
    expect(rows.length).toBe(3);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b)); // ascending cursor order
    expect(rows[0].mechanism).toBe("insert");
    expect(rows[2].mechanism).toBe("edit");
  });

  it("--since-id is an EXCLUSIVE cursor (id > sinceId); omitted means from the beginning", async () => {
    const { listMemoryHistory } = (await historyApi()) as {
      listMemoryHistory: (db: TestDb["db"], opts?: { sinceId?: number }) => Array<{ id: number }>;
    };
    seed("m1", "one");
    seed("m2", "two");
    seed("m3", "three");
    const all = listMemoryHistory(t.db);
    expect(all.length).toBe(3);
    expect(listMemoryHistory(t.db, {}).length).toBe(3); // omitted = no cursor
    const afterFirst = listMemoryHistory(t.db, { sinceId: all[0].id });
    expect(afterFirst.map((r) => r.id)).toEqual(all.slice(1).map((r) => r.id));
    expect(afterFirst.every((r) => r.id > all[0].id)).toBe(true);
  });

  it("a cursor at or beyond the last row exports an empty slice, stably", async () => {
    const { listMemoryHistory } = (await historyApi()) as {
      listMemoryHistory: (db: TestDb["db"], opts?: { sinceId?: number }) => Array<{ id: number }>;
    };
    seed("m1", "one");
    const all = listMemoryHistory(t.db);
    expect(listMemoryHistory(t.db, { sinceId: all[all.length - 1].id })).toEqual([]);
    expect(listMemoryHistory(t.db, { sinceId: 1_000_000_000 })).toEqual([]);
  });

  it("rows expose every history column as a typed projection", async () => {
    const { listMemoryHistory } = (await historyApi()) as {
      listMemoryHistory: (db: TestDb["db"], opts?: { sinceId?: number }) => Array<Record<string, unknown>>;
    };
    seed("m1", "probe");
    const r = listMemoryHistory(t.db)[0];
    expect(Object.keys(r).sort()).toEqual(
      ["actor", "afterContent", "afterHash", "at", "beforeContent", "beforeHash", "id", "mechanism", "memoryId"].sort(),
    );
  });
});

describe("SPEC-010 export hook — JSON correctness (custody-copy fidelity)", () => {
  it("--json emits one JSON object per line with exactly the table column names as keys", async () => {
    const cli = (await cliApi()) as {
      formatHistoryJsonl: (rows: unknown[]) => string;
    };
    const { listMemoryHistory } = (await historyApi()) as {
      listMemoryHistory: (db: TestDb["db"], opts?: { sinceId?: number }) => Array<Record<string, unknown>>;
    };
    expect(typeof cli.formatHistoryJsonl).toBe("function");
    seed("m1", "café ☕ line");
    editMemory(t.db, {
      memoryId: "m1",
      content: "café ☕ line, edited",
      embedding: vec("doc:café ☕ line, edited"),
      actor: "cli",
      now: new Date("2026-09-17T10:00:00Z"),
    });
    const rows = listMemoryHistory(t.db);
    expect(rows.length).toBe(2);
    const jsonl = cli.formatHistoryJsonl(rows);
    const lines = jsonl.trim().split("\n");
    expect(lines.length).toBe(rows.length); // one record per line, JSONL
    lines.forEach((line, i) => {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(obj).sort()).toEqual(
        ["actor", "after_content", "after_hash", "at", "before_content", "before_hash", "id", "mechanism", "memory_id"].sort(),
      );
      expect(obj.id).toBe(rows[i].id);
      expect(obj.memory_id).toBe(rows[i].memoryId);
      expect(obj.mechanism).toBe(rows[i].mechanism);
      expect(obj.before_content).toBe(rows[i].beforeContent);
      expect(obj.after_content).toBe(rows[i].afterContent);
      expect(obj.before_hash).toBe(rows[i].beforeHash);
      expect(obj.after_hash).toBe(rows[i].afterHash);
      expect(obj.actor).toBe(rows[i].actor);
      expect(obj.at).toBe(rows[i].at);
    });
  });
});

describe("SPEC-010 export hook — CLI surface", () => {
  it("registers `history export` with --since-id, --out and --json", async () => {
    const cli = (await cliApi()) as {
      registerHistoryCommand: (program: Command) => void;
    };
    expect(typeof cli.registerHistoryCommand).toBe("function");
    const program = new Command();
    cli.registerHistoryCommand(program);
    const historyCmd = program.commands.find((c) => c.name() === "history");
    expect(historyCmd).toBeDefined();
    const exportCmd = historyCmd!.commands.find((c) => c.name() === "export");
    expect(exportCmd).toBeDefined();
    const opts = exportCmd!.options.map((o) => o.long);
    expect(opts).toEqual(expect.arrayContaining(["--since-id", "--out", "--json"]));
  });

  it("is wired into the CLI entry point", () => {
    const cliSource = readFileSync(
      fileURLToPath(new URL("../../../src/interfaces/cli/index.ts", import.meta.url)),
      "utf-8",
    );
    expect(cliSource).toContain("registerHistoryCommand(program)");
  });
});
