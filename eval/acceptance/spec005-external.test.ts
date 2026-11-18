import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadEvalModule } from "./_support/load.ts";

export const TRACES = ["SPEC-005"];

const evalRoot = join(import.meta.dirname, "..");

describe("SPEC-005 external-comparability hooks", () => {
  it("documents the adapter format for LongMemEval and MemoryAgentBench", () => {
    const docPath = join(evalRoot, "docs", "adapter-format.md");
    expect(existsSync(docPath), `${docPath} must exist`).toBe(true);
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toMatch(/2410\.10813/); // LongMemEval
    expect(doc).toMatch(/2507\.05257/); // MemoryAgentBench
    expect(doc).toMatch(/knowledge-update/i);
    expect(doc).toMatch(/delete-supersede/i);
    // LoCoMo comparability note, no leaderboard claims
    expect(doc).toMatch(/2402\.17753/);
    expect(doc).not.toMatch(/we (rank|score|beat|outperform)/i);
  });

  it("ships sample fixtures that parse and validate against the adapter", async () => {
    const adapter = await loadEvalModule<Record<string, any>>("comparability/adapter.js");
    const samples = [
      "longmem-eval.sample.json",
      "memoryagentbench.sample.json",
    ];
    for (const name of samples) {
      const path = join(evalRoot, "fixtures", "external", name);
      expect(existsSync(path), `${path} must exist`).toBe(true);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const loaded = adapter.loadExternalFixture(path);
      expect(loaded.source.citation).toMatch(/arXiv:\d{4}\.\d{4,5}/);
      expect(loaded.label).toMatch(/shape-derived/i);
      expect(Array.isArray(loaded.cases)).toBe(true);
      expect(loaded.cases.length).toBeGreaterThan(0);
      void parsed;
    }
  });

  it("LoCoMo appears only as a comparability note, never as a run target", () => {
    const docPath = join(evalRoot, "docs", "adapter-format.md");
    const doc = readFileSync(docPath, "utf8");
    const locomo = doc.match(/locomo/i);
    expect(locomo).toBeTruthy();
    expect(doc).toMatch(/comparability note|not run|no leaderboard/i);
  });
});
