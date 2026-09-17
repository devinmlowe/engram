/**
 * Contract: the Anthropic SDK is instantiated only inside the LLM factory.
 *
 * ADR-005 makes _core/llm the single owner of provider clients so the
 * Ollama → OpenRouter → Anthropic cascade (SPEC.md INV-3) applies
 * everywhere. Any `new Anthropic(` outside the factory's provider files
 * bypasses the cascade and re-introduces a hard cloud dependency.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC_ROOT = join(__dirname, "..", "..", "src");
const ALLOWED_DIR = join("_core", "llm", "providers");

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listTsFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

describe("no direct Anthropic clients outside the LLM factory", () => {
  it("only src/_core/llm/providers/ may contain `new Anthropic(`", () => {
    const offenders = listTsFiles(SRC_ROOT)
      .filter((f) => !relative(SRC_ROOT, f).startsWith(ALLOWED_DIR + sep))
      .filter((f) => /\bnew Anthropic\s*\(/.test(readFileSync(f, "utf-8")))
      .map((f) => relative(SRC_ROOT, f));

    expect(offenders).toEqual([]);
  });
});
