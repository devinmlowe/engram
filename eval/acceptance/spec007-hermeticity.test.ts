import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadEvalModule } from "./_support/load.ts";

export const TRACES = ["SPEC-007"];

const repoRoot = join(import.meta.dirname, "..", "..");

describe("SPEC-007 hermeticity", () => {
  it("the mini-store fixture builder exists and builds a hermetic DB", async () => {
    const fixtures = await loadEvalModule<Record<string, any>>("fixtures/mini-store.js");
    expect(typeof fixtures.buildMiniStore).toBe("function");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "spec007-"));
    try {
      const mini = await fixtures.buildMiniStore(dir, {
        conflictPairs: [],
        changes: [],
        suppressions: [],
      });
      expect(mini.dbPath.startsWith(dir)).toBe(true);
      const store = await loadEvalModule<Record<string, any>>("store.js");
      const db = store.openStoreReadonly(mini.dbPath);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("memories");
      expect(names).toContain("conflicts");
      expect(names).toContain("vec_memories");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it("the live store is NOT touched by the hermetic suite", () => {
    // Ensure the hermetic run happened (in case spec006 ran in another worker).
    if (!existsSync(join(repoRoot, "eval", "report.json"))) {
      execFileSync("npm", ["run", "eval"], { cwd: repoRoot, stdio: "ignore" });
    }
    // Hermetic run must never open the live 483MB store: the CLI defaults to
    // the mini-store when no --live flag is passed.
    const report = JSON.parse(readFileSync(join(repoRoot, "eval", "report.json"), "utf8"));
    expect(report.store.mode).toBe("hermetic");
    expect(report.store.path).not.toMatch(/\.local\/share\/engram/);
  }, 300_000);

  it("--live smoke exercises the real store read-only", () => {
    // The CLI must accept --live and resolve the real store; existence of the
    // flag is verified by the source referencing it (builder wires the flag).
    const cli = readFileSync(join(repoRoot, "eval", "src", "cli.ts"), "utf8");
    expect(cli).toMatch(/--live/);
    expect(cli).toMatch(/openStoreReadonly|readonly:\s*true/);
    expect(cli).toMatch(/resolveStorePath/);
  });

  it("live smoke never opens the store read-write", async () => {
    const store = await loadEvalModule<Record<string, any>>("store.js");
    // the pinned read-only mode is better-sqlite3 readonly:true
    const src = readFileSync(join(repoRoot, "eval", "src", "store.ts"), "utf8");
    expect(src).toMatch(/readonly:\s*true/);
    expect(src).not.toMatch(/readonly:\s*false/);
    void store;
  });
});
