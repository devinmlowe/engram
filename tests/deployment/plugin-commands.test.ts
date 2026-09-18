/**
 * #58 / decision #59 — the slash commands bundled in the Claude Code plugin.
 *
 * `commands/` at the plugin root (= repo root) ships exactly the five portable
 * commands (`recall`, `remember`, `explore-graph`, `reflect`, `engram-connect`);
 * `engram-show-graphs` and `rlm-recall` stay personal (tmux/carbonyl, Task+Bash).
 * Inside a plugin the MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`
 * (code.claude.com/docs/en/mcp — "MCP tool naming in plugins"), so every tool
 * reference must carry the `mcp__plugin_engram_engram__` prefix and name a
 * tool that exists (MCP_TOOL_NAMES).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_TOOL_NAMES } from "../../src/interfaces/mcp/tool-names.js";

const ROOT = process.cwd();
const COMMANDS_DIR = join(ROOT, "commands");
const BUNDLED = ["recall", "remember", "explore-graph", "reflect", "engram-connect"].sort();
const PERSONAL_ONLY = ["engram-show-graphs", "rlm-recall"];
const PLUGIN_PREFIX = "mcp__plugin_engram_engram__";

/** A Windows checkout with core.autocrlf=true yields CRLF; every assertion below is written for LF. */
function readCommand(file: string): string {
  return readFileSync(join(COMMANDS_DIR, file), "utf8").replace(/\r\n/g, "\n");
}

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  expect(m, "frontmatter block present").toBeTruthy();
  const out: Record<string, string> = {};
  for (const line of m![1].split("\n")) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

describe("bundled plugin commands (#59)", () => {
  const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md")).sort();

  it("ships exactly the five portable commands", () => {
    expect(files.map((f) => f.replace(/\.md$/, ""))).toEqual(BUNDLED);
    for (const personal of PERSONAL_ONLY) expect(files).not.toContain(`${personal}.md`);
  });

  for (const file of files) {
    const md = readCommand(file);
    const fm = frontmatter(md);

    it(`${file}: frontmatter has description, argument-hint and allowed-tools`, () => {
      expect(fm.description, "description").toBeTruthy();
      expect(fm["argument-hint"], "argument-hint").toBeTruthy();
      expect(fm["allowed-tools"], "allowed-tools").toBeTruthy();
      expect(md).toContain("$ARGUMENTS");
    });

    it(`${file}: every MCP tool reference uses the plugin prefix and names a real tool`, () => {
      const refs = [...md.matchAll(/mcp__[A-Za-z0-9_-]+/g)].map((m) => m[0]);
      expect(refs.length, "references at least one MCP tool").toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref, `${ref} must be plugin-prefixed`).toMatch(new RegExp(`^${PLUGIN_PREFIX}`));
        const tool = ref.slice(PLUGIN_PREFIX.length);
        expect(MCP_TOOL_NAMES as readonly string[], `${ref} names an existing tool`).toContain(tool);
      }
      // The personal-command prefix must not survive the copy.
      expect(md).not.toContain("mcp__engram__");
      // allowed-tools lists only plugin-prefixed engram tools.
      for (const allowed of fm["allowed-tools"].split(/[\s,]+/).filter(Boolean)) {
        expect(allowed).toMatch(new RegExp(`^${PLUGIN_PREFIX}`));
      }
    });
  }

  it("no command assumes this machine (tmux, carbonyl, the visualizer port, absolute home paths)", () => {
    for (const file of files) {
      const md = readCommand(file);
      expect(md, file).not.toMatch(/tmux|carbonyl|localhost:3001|\/Users\/[A-Za-z]|~\/\.claude/);
    }
  });
});
