/**
 * #58 — distribution manifests agree with package.json and have the shape
 * their consumers require:
 *
 *   .claude-plugin/plugin.json       Claude Code plugin (mcpServers → `npx -y @devinmlowe/engram@<v> mcp`)
 *   .claude-plugin/marketplace.json  self-hosted marketplace listing this repo as the `engram` plugin
 *   server.json                      registry.modelcontextprotocol.io entry (npm package artifact)
 *   package.json                     mcpName (registry ownership check) + files[] (what the tarball carries)
 *
 * `scripts/sync-manifests.cjs --check` is what CI and the release workflow
 * run; this test pins its verdict on the committed files and its ability to
 * detect and repair drift, plus the tarball contents.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const sync = require(join(ROOT, "scripts/sync-manifests.cjs")) as typeof import("../../scripts/sync-manifests.cjs");

const read = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const docs = () => ({
  pkg: read("package.json"),
  plugin: read(".claude-plugin/plugin.json"),
  marketplace: read(".claude-plugin/marketplace.json"),
  server: read("server.json"),
});

describe("sync-manifests --check on the committed files", () => {
  it("reports no problems", () => {
    const { problems, version } = sync.analyze(docs());
    expect(problems).toEqual([]);
    expect(version).toBe(read("package.json").version);
  });

  it("the CLI form exits 0 and names the version", () => {
    const out = execFileSync(process.execPath, [join(ROOT, "scripts/sync-manifests.cjs"), "--check"], { encoding: "utf8" });
    expect(out).toContain(`agree on ${read("package.json").version}`);
  });

  it("detects every kind of drift and computes the repaired documents", () => {
    const d = docs();
    d.plugin.version = "0.0.1";
    d.plugin.mcpServers.engram.args[1] = `${d.pkg.name}@0.0.1`;
    d.marketplace.plugins[0].version = "0.0.1";
    d.marketplace.metadata.version = "0.0.1";
    d.server.version = "0.0.1";
    d.server.packages[0].version = "0.0.1";
    const { problems, fixed } = sync.analyze(d);
    expect(problems.length).toBe(6);
    expect(problems.join("\n")).toMatch(/plugin\.json: version/);
    expect(problems.join("\n")).toMatch(/plugin\.json: mcpServers\.engram\.args pins/);
    expect(problems.join("\n")).toMatch(/marketplace\.json: plugins\[engram\]\.version/);
    expect(problems.join("\n")).toMatch(/server\.json: packages\[0\]\.version/);
    // The repaired documents pass.
    expect(sync.analyze({ ...d, ...fixed }).problems).toEqual([]);
    expect(fixed.plugin.mcpServers.engram.args[1]).toBe(`${d.pkg.name}@${d.pkg.version}`);
  });

  it("refuses the old file-path form of mcpServers and an unpinned npx spec", () => {
    const d = docs();
    d.plugin.mcpServers = "../.mcp.json";
    expect(sync.analyze(d).problems.join("\n")).toMatch(/mcpServers must be an inline object/);
    const e = docs();
    e.plugin.mcpServers.engram.args = ["-y", e.pkg.name, "mcp"];
    expect(sync.analyze(e).problems.join("\n")).toMatch(/must contain "@devinmlowe\/engram@<version>"/);
  });

  it("insists mcpName matches the registry name and files[] carries the plugin", () => {
    const d = docs();
    d.pkg.mcpName = "io.github.someone-else/engram";
    d.pkg.files = d.pkg.files.filter((f: string) => f !== "commands");
    const problems = sync.analyze(d).problems.join("\n");
    expect(problems).toMatch(/mcpName .* must equal server\.json name/);
    expect(problems).toMatch(/files\[\] must include "commands"/);
  });
});

describe(".claude-plugin/plugin.json (Claude Code plugin manifest)", () => {
  const plugin = read(".claude-plugin/plugin.json");
  const pkg = read("package.json");

  it("mcpServers is inline and runs the published npm binary through npx, pinned to this version", () => {
    // The pre-#58 manifest pointed at ../.mcp.json → `node ./dist/...`, which only
    // works with Claude Code opened inside the checkout. The plugin must not depend
    // on the checkout, or on the root .mcp.json.
    expect(typeof plugin.mcpServers).toBe("object");
    expect(plugin.mcpServers.engram).toEqual({
      command: "npx",
      args: ["-y", `${pkg.name}@${pkg.version}`, "mcp"],
    });
    expect(JSON.stringify(plugin)).not.toContain(".mcp.json");
    expect(JSON.stringify(plugin)).not.toContain("dist/");
  });

  it("name/version/metadata", () => {
    expect(plugin.name).toBe("engram");
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.license).toBe(pkg.license);
    expect(plugin.repository).toContain("github.com/devinmlowe/engram");
    // Components live at the plugin root (= repo root), never inside .claude-plugin/.
    expect(existsSync(join(ROOT, "commands"))).toBe(true);
    expect(existsSync(join(ROOT, ".claude-plugin", "commands"))).toBe(false);
  });

  it("the root .mcp.json stays for checkout development and is independent of the plugin", () => {
    const cfg = read(".mcp.json");
    expect(cfg.mcpServers.engram.command).toBe("node");
    expect(cfg.mcpServers.engram.args.join(" ")).toContain("dist/interfaces/mcp/server.js");
  });
});

describe(".claude-plugin/marketplace.json (self-hosted marketplace)", () => {
  const marketplace = read(".claude-plugin/marketplace.json");
  const pkg = read("package.json");

  it("lists this repo as the engram plugin, version pinned", () => {
    expect(marketplace.name).toBe("engram");
    expect(marketplace.owner.name).toBeTruthy();
    const entry = marketplace.plugins.find((p: { name: string }) => p.name === "engram");
    expect(entry).toBeTruthy();
    expect(entry.source).toBe("./");
    expect(entry.version).toBe(pkg.version);
    expect(entry.description).toContain("/recall");
  });

  it("README documents marketplace add + install", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("/plugin marketplace add devinmlowe/engram");
    expect(readme).toContain("/plugin install engram@engram");
    expect(readme).toContain("MCP_TIMEOUT");
  });
});

describe("server.json (registry.modelcontextprotocol.io)", () => {
  const server = read("server.json");
  const pkg = read("package.json");

  it("names the GitHub-authenticated namespace and the npm package as the artifact", () => {
    expect(server.name).toBe("io.github.devinmlowe/engram");
    expect(pkg.mcpName).toBe(server.name);
    expect(server.$schema).toMatch(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
    expect(server.version).toBe(pkg.version);
    expect(server.repository).toEqual({ url: "https://github.com/devinmlowe/engram", source: "github" });
    const npm = server.packages.find((p: { registryType: string }) => p.registryType === "npm");
    expect(npm).toMatchObject({
      identifier: pkg.name,
      version: pkg.version,
      registryBaseUrl: "https://registry.npmjs.org",
      runtimeHint: "npx",
      transport: { type: "stdio" },
    });
    // `npx -y @devinmlowe/engram mcp`: the subcommand is a positional package argument.
    expect(npm.packageArguments[0]).toMatchObject({ type: "positional", value: "mcp" });
    const envNames = npm.environmentVariables.map((e: { name: string }) => e.name);
    expect(envNames).toEqual(expect.arrayContaining(["ENGRAM_DB_PATH", "ENGRAM_MCP_PORT", "ENGRAM_MCP_TOKEN", "ENGRAM_MCP_STANDALONE"]));
    expect(npm.environmentVariables.find((e: { name: string }) => e.name === "ENGRAM_MCP_TOKEN").isSecret).toBe(true);
  });
});

describe("npm tarball carries the plugin and registry files", () => {
  it("npm pack --dry-run lists .claude-plugin/*, commands/*.md, server.json and the sync script", () => {
    // npm is npm.cmd on Windows; a shell resolves either.
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
    const [{ files }] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const paths = files.map((f) => f.path);
    for (const required of [
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      "server.json",
      "scripts/preflight.cjs",
      "scripts/sync-manifests.cjs",
      // #61: `engram setup` installs the services from an npm install too
      "scripts/install-mcp-daemon.sh",
      "scripts/install-daemon.sh",
      "scripts/install-visualizer.sh",
      "scripts/run-mcp-daemon.sh",
      "scripts/run-dream.sh",
      "scripts/install-mcp-daemon.ps1",
      "systemd/engram-mcp.service",
      "prompts/smoke-conversation.json",
      "commands/recall.md",
      "commands/remember.md",
      "commands/explore-graph.md",
      "commands/reflect.md",
      "commands/engram-connect.md",
      "package.json",
    ]) {
      expect(paths, `tarball must contain ${required}`).toContain(required);
    }
    // The bin the plugin's npx command resolves to.
    expect(paths.some((p) => p === "dist/interfaces/cli/index.js") || !existsSync(join(ROOT, "dist"))).toBe(true);
  }, 60_000);
});
