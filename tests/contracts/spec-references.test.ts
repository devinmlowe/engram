/**
 * Contract: SPEC / README references resolve to real artifacts.
 *
 * Every module ships a SPEC.md whose verification table cites test files,
 * and READMEs cite source files and the MCP tool list. Those citations rot
 * silently when files move (src/core → src/_core, tests/mcp → tests/interfaces/mcp)
 * or when a tool is added without touching the docs. This test parses the
 * docs and pins them to the filesystem and to MCP_TOOL_NAMES so the drift
 * fails CI instead of misleading the next reader.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MCP_TOOL_NAMES } from "../../src/interfaces/mcp/tool-names.js";

const REPO_ROOT = join(__dirname, "..", "..");

function listDocs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") listDocs(full, out);
    } else if (entry === "SPEC.md" || entry === "README.md") {
      out.push(full);
    }
  }
  return out;
}

/** Root SPEC plus every SPEC.md / README.md under src/ (SRC: one SPEC per module). */
const SPEC_DOCS = [join(REPO_ROOT, "SPEC.md"), ...listDocs(join(REPO_ROOT, "src"))].map((f) =>
  relative(REPO_ROOT, f),
);

/** Docs that make a literal "N tools" / "N MCP tools" claim about the MCP server. */
const TOOL_COUNT_DOCS = [
  "README.md",
  "src/interfaces/mcp/README.md",
  "docs/api-reference.md",
  "docs/user-guide.md",
];

/** Docs that enumerate the MCP tools by name. */
const TOOL_LIST_DOCS = ["README.md", "src/interfaces/mcp/README.md"];

interface PathRef {
  doc: string;
  raw: string;
  /** Path normalised to be repo-root relative (leading ./ ../ stripped). */
  path: string;
  kind: "test-file" | "src-file" | "dir";
}

/**
 * Pull `backticked` tokens that look like repo paths. Relative prefixes
 * (./, ../) are dropped because module SPECs cite tests/ from src/<module>/
 * and the intent is always the repo-root tests/ tree.
 */
function extractPathRefs(doc: string): PathRef[] {
  const text = readFileSync(join(REPO_ROOT, doc), "utf-8");
  const refs: PathRef[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1];
    if (/[\s*{}<>]/.test(raw)) continue; // globs, prose, placeholders
    const anchored = raw.match(/(?:^|\/)((?:tests|src)\/.*)$/);
    if (!anchored) continue;
    const path = anchored[1];
    let kind: PathRef["kind"] | null = null;
    if (path.startsWith("tests/") && path.endsWith(".test.ts")) kind = "test-file";
    else if (path.startsWith("src/") && path.endsWith(".ts")) kind = "src-file";
    else if (path.endsWith("/")) kind = "dir";
    if (kind) refs.push({ doc, raw, path, kind });
  }
  return refs;
}

describe("SPEC/README path references resolve on disk", () => {
  const allRefs = SPEC_DOCS.flatMap(extractPathRefs);

  it("finds path references to check (guard against a silent no-op)", () => {
    expect(allRefs.length).toBeGreaterThan(20);
  });

  it("every cited tests/**/*.test.ts and src/**/*.ts file exists", () => {
    const missing = allRefs
      .filter((r) => r.kind !== "dir")
      .filter((r) => !existsSync(join(REPO_ROOT, r.path)))
      .map((r) => `${r.doc} -> \`${r.raw}\``);
    expect(missing).toEqual([]);
  });

  it("every cited tests/ or src/ directory exists", () => {
    const missing = allRefs
      .filter((r) => r.kind === "dir")
      .filter((r) => {
        const full = join(REPO_ROOT, r.path);
        return !existsSync(full) || !statSync(full).isDirectory();
      })
      .map((r) => `${r.doc} -> \`${r.raw}\``);
    expect(missing).toEqual([]);
  });
});

describe("MCP tool count and tool list claims match MCP_TOOL_NAMES", () => {
  const expected = MCP_TOOL_NAMES.length;

  for (const doc of TOOL_COUNT_DOCS) {
    it(`${doc}: every "N tools" / "N MCP tools" claim equals ${expected}`, () => {
      const text = readFileSync(join(REPO_ROOT, doc), "utf-8");
      const claims = [...text.matchAll(/\b(\d+)\s+(?:MCP\s+)?tools\b/gi)].map((m) => ({
        claim: m[0],
        count: Number(m[1]),
      }));
      expect(claims.length, `${doc} makes no numeric tool-count claim`).toBeGreaterThan(0);
      const wrong = claims.filter((c) => c.count !== expected).map((c) => `${doc}: "${c.claim}"`);
      expect(wrong).toEqual([]);
    });
  }

  for (const doc of TOOL_LIST_DOCS) {
    it(`${doc}: lists every tool in MCP_TOOL_NAMES by name`, () => {
      const text = readFileSync(join(REPO_ROOT, doc), "utf-8");
      const absent = MCP_TOOL_NAMES.filter((name) => !text.includes(`\`${name}\``));
      expect(absent).toEqual([]);
    });
  }
});
