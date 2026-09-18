/**
 * Issue #50: `engram mcp install|uninstall|status` and the doctor `hosts`
 * check. Every host config lives in a temp home; the daemon probe and the
 * Hermes deploy script are fakes. Nothing here touches the real ~/.claude.json,
 * ~/.codex, ~/.cursor or ~/.hermes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_NAME } from "../../../src/_core/version/index.js";
import type { ExecResult } from "../../../src/interfaces/cli/services.js";
import {
  HOST_IDS, SERVER_NAME,
  buildEntry, claudePluginStatus, decideTransport, defaultHostContext, formatInstallResults, formatStatus, hostConfigPath, hostPresent,
  parseHostId, readEnvFileVar, readRegisteredEntry, readTomlTable, renderJsonEntry, renderTomlEntry, runMcpInstall, runMcpStatus, runMcpUninstall,
  summariseHostsForDoctor, tildify, unifiedDiff, upsertJsonServer, upsertTomlTable,
  type HealthProbe, type HostContext, type InstallResult,
} from "../../../src/interfaces/cli/hosts.js";
import { checkHosts, DOCTOR_CHECK_NAMES } from "../../../src/interfaces/cli/doctor.js";

let root: string;
let home: string;
let pkg: string;

const healthy: HealthProbe = async () => ({ status: 200, body: JSON.stringify({ status: "ok", workers: { size: 2, ready: 2 } }) });
const refused: HealthProbe = async () => { const e = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException; e.code = "ECONNREFUSED"; throw e; };
const notEngram: HealthProbe = async () => ({ status: 200, body: "<html>hi</html>" });

function ctx(overrides: Partial<HostContext> = {}): HostContext {
  return defaultHostContext({
    home, cwd: join(root, "project"), env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, platform: "darwin",
    packageRoot: pkg, node: "/usr/local/bin/node", hermesHome: join(home, ".hermes"), ...overrides,
  });
}

const CLI = () => join(pkg, "dist", "interfaces", "cli", "index.js");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "engram-hosts-"));
  home = join(root, "home");
  pkg = join(root, "engram");
  mkdirSync(join(home, ".config", "engram"), { recursive: true });
  mkdirSync(join(root, "project"), { recursive: true });
  mkdirSync(join(pkg, "dist", "interfaces", "cli"), { recursive: true });
  mkdirSync(join(pkg, "dist", "interfaces", "mcp"), { recursive: true });
  writeFileSync(CLI(), "// cli");
  writeFileSync(join(pkg, "dist", "interfaces", "mcp", "server.js"), "// server");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CLAUDE_FIXTURE = `{
  "numStartups": 42,
  "installMethod": "native",
  "mcpServers": {
    "MCP_DOCKER": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "mcp",
        "gateway",
        "run"
      ]
    },
    "windows-vm": {
      "type": "http",
      "url": "http://127.0.0.1:4545/mcp"
    }
  },
  "projects": {
    "/Users/x/git/thing": {
      "hasTrustDialogAccepted": true
    }
  },
  "oauthAccount": {
    "emailAddress": "x@example.com"
  }
}`;

const CODEX_FIXTURE = `# Codex config
model = "gpt-5.2-codex"
model_reasoning_effort = "high"   # keep

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.context7.env]
MY_ENV_VAR = "MY_ENV_VALUE"

[features]
memories = false
`;

// ─── JSON writer ──────────────────────────────────────────────────────

describe("JSON writer (claude, cursor)", () => {
  it("adds mcpServers.engram and keeps every other key, other servers, indent and no-trailing-newline byte-for-byte", () => {
    const entry = { type: "http", url: "http://127.0.0.1:9907/mcp" };
    const out = upsertJsonServer(CLAUDE_FIXTURE, SERVER_NAME, entry, "claude.json");
    expect(out.endsWith("\n")).toBe(false); // the fixture (like the real ~/.claude.json) has no trailing newline
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toEqual(["numStartups", "installMethod", "mcpServers", "projects", "oauthAccount"]);
    expect(Object.keys(parsed.mcpServers)).toEqual(["MCP_DOCKER", "windows-vm", "engram"]);
    expect(parsed.mcpServers.engram).toEqual(entry);
    // Everything but the appended engram block is unchanged, byte for byte.
    const block = ',\n    "engram": {\n      "type": "http",\n      "url": "http://127.0.0.1:9907/mcp"\n    }';
    expect(out).toContain(block);
    expect(out.replace(block, "")).toBe(CLAUDE_FIXTURE);
  });

  it("is idempotent and keeps the existing entry's position when replacing it", () => {
    const first = upsertJsonServer(CLAUDE_FIXTURE, SERVER_NAME, { type: "stdio", command: "node", args: ["a"] }, "c");
    const second = upsertJsonServer(first, SERVER_NAME, { type: "stdio", command: "node", args: ["a"] }, "c");
    expect(second).toBe(first);
    const withOther = upsertJsonServer(first, "zzz", { command: "z" }, "c");
    const replaced = upsertJsonServer(withOther, SERVER_NAME, { type: "http", url: "u" }, "c");
    expect(Object.keys(JSON.parse(replaced).mcpServers)).toEqual(["MCP_DOCKER", "windows-vm", "engram", "zzz"]);
  });

  it("removes only engram; preserves 4-space indent, CRLF and a trailing newline; creates the object for a new file", () => {
    const four = JSON.stringify({ a: 1, mcpServers: { engram: { url: "u" }, keep: { command: "k" } } }, null, 4).replace(/\n/g, "\r\n") + "\r\n";
    const out = upsertJsonServer(four, SERVER_NAME, null, "c");
    expect(out).toBe(JSON.stringify({ a: 1, mcpServers: { keep: { command: "k" } } }, null, 4).replace(/\n/g, "\r\n") + "\r\n");
    expect(upsertJsonServer(null, SERVER_NAME, { url: "u" })).toBe('{\n  "mcpServers": {\n    "engram": {\n      "url": "u"\n    }\n  }\n}\n');
    expect(upsertJsonServer('{"other": true}', SERVER_NAME, null, "c")).toBe('{"other": true}'); // nothing to remove: untouched
  });

  it("refuses malformed JSON and a non-object mcpServers instead of clobbering", () => {
    expect(() => upsertJsonServer("{ not json", SERVER_NAME, { url: "u" }, "/x/.claude.json")).toThrow(/not valid JSON.*fix it by hand/);
    expect(() => upsertJsonServer('{"mcpServers": []}', SERVER_NAME, { url: "u" }, "/x/c")).toThrow(/"mcpServers" is not an object/);
    expect(() => upsertJsonServer("[1]", SERVER_NAME, { url: "u" }, "/x/c")).toThrow(/does not hold a JSON object/);
  });
});

// ─── TOML writer ──────────────────────────────────────────────────────

describe("TOML table writer (codex)", () => {
  it("appends [mcp_servers.engram] after a blank line, touching no other line", () => {
    const out = upsertTomlTable(CODEX_FIXTURE, "mcp_servers.engram", ['url = "http://127.0.0.1:9907/mcp"', 'bearer_token_env_var = "ENGRAM_MCP_TOKEN"']);
    expect(out).toBe(CODEX_FIXTURE + '\n[mcp_servers.engram]\nurl = "http://127.0.0.1:9907/mcp"\nbearer_token_env_var = "ENGRAM_MCP_TOKEN"\n');
    expect(out.split("\n").slice(0, CODEX_FIXTURE.split("\n").length - 1)).toEqual(CODEX_FIXTURE.split("\n").slice(0, -1));
  });

  it("replaces the existing table and its sub-tables in place; idempotent", () => {
    const withTable = `${CODEX_FIXTURE}
[mcp_servers.engram]
url = "http://127.0.0.1:9910/mcp"
startup_timeout_sec = 20

[mcp_servers.engram.env]
X = "1"

[other]
k = "v"
`;
    const body = ['command = "/usr/bin/node"', 'args = ["/x/index.js", "mcp"]'];
    const out = upsertTomlTable(withTable, "mcp_servers.engram", body);
    expect(out).toBe(`${CODEX_FIXTURE}
[mcp_servers.engram]
command = "/usr/bin/node"
args = ["/x/index.js", "mcp"]

[other]
k = "v"
`);
    expect(upsertTomlTable(out, "mcp_servers.engram", body)).toBe(out);
    expect(readTomlTable(out, "mcp_servers.engram")).toEqual({ command: "/usr/bin/node", args: ["/x/index.js", "mcp"] });
    expect(readTomlTable(out, "mcp_servers.context7")).toEqual({ command: "npx", args: ["-y", "@upstash/context7-mcp"] });
  });

  it("removes the table (and the blank line it was appended with), restoring the original bytes", () => {
    const installed = upsertTomlTable(CODEX_FIXTURE, "mcp_servers.engram", ['url = "u"']);
    expect(upsertTomlTable(installed, "mcp_servers.engram", null)).toBe(CODEX_FIXTURE);
    const middle = `[a]\nx = 1\n\n[mcp_servers.engram]\nurl = "u"\n\n[b]\ny = 2\n`;
    expect(upsertTomlTable(middle, "mcp_servers.engram", null)).toBe(`[a]\nx = 1\n\n[b]\ny = 2\n`);
    expect(upsertTomlTable(CODEX_FIXTURE, "mcp_servers.engram", null)).toBe(CODEX_FIXTURE);
    expect(upsertTomlTable(null, "mcp_servers.engram", null)).toBe("");
  });

  it("also removes dotted/inline definitions so the server is never defined twice; quoted headers count", () => {
    const dotted = `mcp_servers.engram.url = "old"\n\n[mcp_servers]\nengram = { command = "old" }\nother = { command = "keep" }\n\n[mcp_servers."engram"]\nurl = "older"\n`;
    const out = upsertTomlTable(dotted, "mcp_servers.engram", ['url = "new"']);
    expect(out).toBe(`\n[mcp_servers]\nother = { command = "keep" }\n\n[mcp_servers.engram]\nurl = "new"\n`);
    expect(upsertTomlTable(null, "mcp_servers.engram", ['url = "u"'])).toBe('[mcp_servers.engram]\nurl = "u"\n');
  });

  it("parses inline http_headers and escapes backslashes/quotes when rendering (Windows paths)", () => {
    const text = `[mcp_servers.engram]\nurl = "u"\nhttp_headers = { Authorization = "Bearer abc" }\n`;
    expect(readTomlTable(text, "mcp_servers.engram")).toEqual({ url: "u", http_headers: { Authorization: "Bearer abc" } });
    const lines = renderTomlEntry({ transport: "stdio", port: 9907, url: "u", command: "C:\\Program Files\\node.exe", args: ["C:\\x\\index.js", "mcp"], auth: { mode: "none" } });
    expect(lines).toEqual(['command = "C:\\\\Program Files\\\\node.exe"', 'args = ["C:\\\\x\\\\index.js", "mcp"]']);
    expect(readTomlTable(`[mcp_servers.engram]\n${lines.join("\n")}\n`, "mcp_servers.engram")).toEqual({ command: "C:\\Program Files\\node.exe", args: ["C:\\x\\index.js", "mcp"] });
  });
});

// ─── unified diff ────────────────────────────────────────────────────

describe("unified diff", () => {
  it("emits hunks with context and correct ranges; /dev/null for a new file; empty when equal", () => {
    const a = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"].join("\n") + "\n";
    const b = ["l1", "l2", "l3", "L4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n") + "\n";
    expect(unifiedDiff(a, b, "f")).toBe(["--- f", "+++ f", "@@ -1,9 +1,10 @@", " l1", " l2", " l3", "-l4", "+L4", " l5", " l6", " l7", " l8", " l9", "+l10"].join("\n") + "\n");
    expect(unifiedDiff(null, "x\ny\n", "f")).toBe("--- /dev/null\n+++ f\n@@ -0,0 +1,2 @@\n+x\n+y\n");
    expect(unifiedDiff("same\n", "same\n", "f")).toBe("");
    const far = unifiedDiff(a, a.replace("l1\n", "L1\n").replace("l9\n", "L9\n"), "f");
    expect(far.match(/^@@/gm)?.length).toBe(2);
  });
});

// ─── transport + entry ────────────────────────────────────────────────

describe("transport decision (#51) and the entry it builds", () => {
  const env = { ENGRAM_MCP_PORT: "9910" };
  it("HTTP when the daemon answers, stdio otherwise, with the reason", async () => {
    const http = await decideTransport({ env, probe: healthy });
    expect(http).toMatchObject({ transport: "http", port: 9910, url: "http://127.0.0.1:9910/mcp", reason: "daemon answered /health on :9910", daemonHealthy: true });
    const stdio = await decideTransport({ env, probe: refused });
    expect(stdio.transport).toBe("stdio");
    expect(stdio.reason).toBe("no daemon on :9910 (ECONNREFUSED) — stdio; engram mcp will bridge when one appears");
    const other = await decideTransport({ env, probe: notEngram });
    expect(other.transport).toBe("stdio");
    expect(other.reason).toContain("not like the engram daemon (HTTP 200)");
  });

  it("--transport overrides the probe (stdio skips it; http warns when nothing answers)", async () => {
    let probed = 0;
    const stdio = await decideTransport({ env, override: "stdio", probe: async (p, t) => { probed++; return healthy(p, t); } });
    expect(stdio).toMatchObject({ transport: "stdio", daemonHealthy: null });
    expect(probed).toBe(0);
    const http = await decideTransport({ env, override: "http", probe: refused });
    expect(http.transport).toBe("http");
    expect(http.reason).toMatch(/--transport http; no daemon on :9910 \(ECONNREFUSED\) — the host cannot connect until one runs/);
  });

  it("builds the stdio entry from node + the installed CLI (with --port only when non-default) and the HTTP entry with an env-ref header", async () => {
    const c = ctx();
    const stdio = buildEntry(await decideTransport({ env: {}, probe: refused }), c, { token: { source: null, file: "f" } });
    expect(stdio).toMatchObject({ transport: "stdio", command: "/usr/local/bin/node", args: [CLI(), "mcp"], auth: { mode: "none" } });
    const stdio2 = buildEntry(await decideTransport({ env, probe: refused }), c, { token: { source: null, file: "f" } });
    expect(stdio2.args).toEqual([CLI(), "mcp", "--port", "9910"]);
    const http = buildEntry(await decideTransport({ env: {}, probe: healthy }), c, { token: { source: "env", value: "s3cret", file: "f" } });
    expect(http.auth).toEqual({ mode: "env-ref", envVar: "ENGRAM_MCP_TOKEN" });
    expect(renderJsonEntry("claude", http)).toEqual({ type: "http", url: "http://127.0.0.1:9907/mcp", headers: { Authorization: "Bearer ${ENGRAM_MCP_TOKEN}" } });
    expect(renderJsonEntry("cursor", http)).toEqual({ url: "http://127.0.0.1:9907/mcp", headers: { Authorization: "Bearer ${env:ENGRAM_MCP_TOKEN}" } });
    expect(renderTomlEntry(http)).toEqual(['url = "http://127.0.0.1:9907/mcp"', 'bearer_token_env_var = "ENGRAM_MCP_TOKEN"']);
    expect(renderJsonEntry("claude", stdio)).toEqual({ type: "stdio", command: "/usr/local/bin/node", args: [CLI(), "mcp"] });
    expect(renderJsonEntry("cursor", stdio)).toEqual({ command: "/usr/local/bin/node", args: [CLI(), "mcp"] });
    const noToken = buildEntry(await decideTransport({ env: {}, probe: healthy }), c, { token: { source: null, file: "f" } });
    expect(renderJsonEntry("claude", noToken)).toEqual({ type: "http", url: "http://127.0.0.1:9907/mcp" });
    const inline = buildEntry(await decideTransport({ env: {}, probe: healthy }), c, { token: { source: "env-file", value: "s3cret", file: "f" }, inlineToken: true });
    expect(renderJsonEntry("claude", inline)).toEqual({ type: "http", url: "http://127.0.0.1:9907/mcp", headers: { Authorization: "Bearer s3cret" } });
    expect(renderTomlEntry(inline)).toEqual(['url = "http://127.0.0.1:9907/mcp"', 'http_headers = { Authorization = "Bearer s3cret" }']);
  });

  it("reads the daemon token from the service env file the daemon sources", () => {
    const f = join(home, ".config", "engram", "env");
    writeFileSync(f, "# daemon env\nENGRAM_MCP_PORT=9907\nexport ENGRAM_MCP_TOKEN=\"tok-1\"  \nOTHER='x'\n");
    expect(readEnvFileVar(f, "ENGRAM_MCP_TOKEN")).toBe("tok-1");
    expect(readEnvFileVar(f, "OTHER")).toBe("x");
    expect(readEnvFileVar(f, "MISSING")).toBeUndefined();
    expect(readEnvFileVar(join(home, "nope"), "X")).toBeUndefined();
    writeFileSync(f, "ENGRAM_MCP_TOKEN=\n");
    expect(readEnvFileVar(f, "ENGRAM_MCP_TOKEN")).toBeUndefined();
  });

  it("validates host ids and paths", () => {
    expect(parseHostId(" Claude ")).toBe("claude");
    expect(() => parseHostId("vscode")).toThrow(/unknown host "vscode": expected one of claude, codex, cursor, hermes/);
    const c = ctx();
    expect(hostConfigPath("claude", c, "user")).toBe(join(home, ".claude.json"));
    expect(hostConfigPath("claude", ctx({ env: { CLAUDE_CONFIG_DIR: join(home, "cc") } }), "user")).toBe(join(home, "cc", ".claude.json"));
    expect(hostConfigPath("claude", c, "project")).toBe(join(root, "project", ".mcp.json"));
    expect(hostConfigPath("codex", c, "project")).toBe(join(root, "project", ".codex", "config.toml"));
    expect(hostConfigPath("cursor", c, "project")).toBe(join(root, "project", ".cursor", "mcp.json"));
    expect(() => hostConfigPath("hermes", c, "project")).toThrow(/no project scope/);
    expect(tildify(join(home, ".codex", "config.toml"), home)).toBe("~/.codex/config.toml");
    expect(tildify("/elsewhere/x", home)).toBe("/elsewhere/x");
  });
});

// ─── install / uninstall end to end ───────────────────────────────────

function by(results: InstallResult[], host: string): InstallResult {
  const r = results.find((x) => x.host === host);
  if (!r) throw new Error(`no result for ${host}`);
  return r;
}

describe("engram mcp install (files in a temp home)", () => {
  beforeEach(() => {
    writeFileSync(join(home, ".claude.json"), CLAUDE_FIXTURE);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), CODEX_FIXTURE);
    mkdirSync(join(home, ".cursor"));
  });

  it("writes every host atomically with a .bak, is byte-identical on the second run, and never touches other servers", async () => {
    const c = ctx();
    const first = await runMcpInstall({ hosts: ["claude", "codex", "cursor"], scope: "user" }, { ctx: c, probe: healthy });
    expect(first.map((r) => [r.host, r.action, r.transport])).toEqual([["claude", "written", "http"], ["codex", "written", "http"], ["cursor", "written", "http"]]);
    expect(by(first, "claude").backup).toBe(join(home, ".claude.json.bak"));
    expect(readFileSync(join(home, ".claude.json.bak"), "utf8")).toBe(CLAUDE_FIXTURE);
    expect(by(first, "cursor").backup).toBeNull(); // new file
    const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(claude.mcpServers.engram).toEqual({ type: "http", url: "http://127.0.0.1:9907/mcp" });
    expect(claude.mcpServers.MCP_DOCKER.args).toEqual(["mcp", "gateway", "run"]);
    expect(claude.oauthAccount.emailAddress).toBe("x@example.com");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(CODEX_FIXTURE + '\n[mcp_servers.engram]\nurl = "http://127.0.0.1:9907/mcp"\n');
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"))).toEqual({ mcpServers: { engram: { url: "http://127.0.0.1:9907/mcp" } } });
    expect(readFileSync(join(home, ".codex", "config.toml.bak"), "utf8")).toBe(CODEX_FIXTURE);
    expect(existsSync(join(home, ".cursor", "mcp.json.bak"))).toBe(false);

    const snapshot = ["claude.json" , ".codex/config.toml", ".cursor/mcp.json"].map((f) => readFileSync(join(home, f.startsWith(".") ? f : `.${f}`), "utf8"));
    const bakBefore = statSync(join(home, ".claude.json.bak")).mtimeMs;
    const second = await runMcpInstall({ hosts: ["claude", "codex", "cursor"], scope: "user" }, { ctx: c, probe: healthy });
    expect(second.map((r) => r.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect([".claude.json", ".codex/config.toml", ".cursor/mcp.json"].map((f) => readFileSync(join(home, f), "utf8"))).toEqual(snapshot);
    expect(statSync(join(home, ".claude.json.bak")).mtimeMs).toBe(bakBefore);
    expect(readFileSync(join(home, ".claude.json.bak"), "utf8")).toBe(CLAUDE_FIXTURE);
    const lines = formatInstallResults(second);
    expect(lines[0]).toBe("claude: http — daemon answered /health on :9907");
    expect(lines[1]).toContain("~/.claude.json already has this entry");
  });

  it("falls back to stdio (node + installed CLI) when no daemon answers and says so", async () => {
    const r = await runMcpInstall({ hosts: ["claude", "codex"], scope: "user" }, { ctx: ctx(), probe: refused });
    expect(by(r, "claude").transport).toBe("stdio");
    expect(by(r, "claude").reason).toBe("no daemon on :9907 (ECONNREFUSED) — stdio; engram mcp will bridge when one appears");
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.engram).toEqual({ type: "stdio", command: "/usr/local/bin/node", args: [CLI(), "mcp"] });
    expect(readTomlTable(readFileSync(join(home, ".codex", "config.toml"), "utf8"), "mcp_servers.engram")).toEqual({ command: "/usr/local/bin/node", args: [CLI(), "mcp"] });
    expect(by(r, "claude").notes.at(-1)).toBe("restart Claude Code; /mcp should list engram (16 tools)");
  });

  it("refuses a stdio entry when the installed CLI is missing (unbuilt checkout)", async () => {
    rmSync(CLI());
    await expect(runMcpInstall({ hosts: ["claude"], scope: "user" }, { ctx: ctx(), probe: refused })).rejects.toThrow(/does not exist — run `npm run build`/);
  });

  it("references ENGRAM_MCP_TOKEN per host when the daemon has a token (env file), never the literal; --inline-token writes it with a warning and mode 600", async () => {
    writeFileSync(join(home, ".config", "engram", "env"), "ENGRAM_MCP_TOKEN=s3cret-value\n");
    const c = ctx();
    const r = await runMcpInstall({ hosts: ["claude", "codex", "cursor"], scope: "user" }, { ctx: c, probe: healthy });
    for (const f of [".claude.json", ".codex/config.toml", ".cursor/mcp.json"]) expect(readFileSync(join(home, f), "utf8")).not.toContain("s3cret-value");
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.engram.headers).toEqual({ Authorization: "Bearer ${ENGRAM_MCP_TOKEN}" });
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.engram.headers).toEqual({ Authorization: "Bearer ${env:ENGRAM_MCP_TOKEN}" });
    expect(readTomlTable(readFileSync(join(home, ".codex", "config.toml"), "utf8"), "mcp_servers.engram")).toEqual({ url: "http://127.0.0.1:9907/mcp", bearer_token_env_var: "ENGRAM_MCP_TOKEN" });
    expect(by(r, "claude").auth).toBe("env-ref");
    expect(by(r, "claude").notes.join("\n")).toContain("${ENGRAM_MCP_TOKEN} in headers (references the variable; the literal is never written)");
    expect(by(r, "codex").notes.join("\n")).toContain('bearer_token_env_var = "ENGRAM_MCP_TOKEN"');

    const inline = await runMcpInstall({ hosts: ["cursor", "codex"], scope: "user", inlineToken: true }, { ctx: c, probe: healthy });
    expect(by(inline, "cursor").auth).toBe("inline");
    expect(by(inline, "cursor").notes.join("\n")).toMatch(/WARNING: --inline-token wrote the literal ENGRAM_MCP_TOKEN/);
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.engram.headers).toEqual({ Authorization: "Bearer s3cret-value" });
    expect(statSync(join(home, ".cursor", "mcp.json")).mode & 0o777).toBe(0o600);
    expect(readTomlTable(readFileSync(join(home, ".codex", "config.toml"), "utf8"), "mcp_servers.engram")).toEqual({ url: "http://127.0.0.1:9907/mcp", http_headers: { Authorization: "Bearer s3cret-value" } });
    // the .bak of the env-ref version is kept
    expect(readFileSync(join(home, ".cursor", "mcp.json.bak"), "utf8")).toContain("${env:ENGRAM_MCP_TOKEN}");

    rmSync(join(home, ".config", "engram", "env"));
    await expect(runMcpInstall({ hosts: ["cursor"], scope: "user", inlineToken: true }, { ctx: c, probe: healthy })).rejects.toThrow(/--inline-token: ENGRAM_MCP_TOKEN is not set here nor in/);
    // the variable set in the environment counts too
    const r2 = await runMcpInstall({ hosts: ["claude"], scope: "user" }, { ctx: ctx({ env: { HOME: home, ENGRAM_MCP_TOKEN: "from-env" } }), probe: healthy });
    expect(by(r2, "claude").auth).toBe("env-ref");
    expect(readFileSync(join(home, ".claude.json"), "utf8")).not.toContain("from-env");
  });

  it("--dry-run prints the path and the unified diff and writes nothing", async () => {
    const before = readFileSync(join(home, ".claude.json"), "utf8");
    const r = await runMcpInstall({ hosts: ["claude", "cursor"], scope: "user", dryRun: true }, { ctx: ctx(), probe: healthy });
    expect(r.map((x) => x.action)).toEqual(["dry-run", "dry-run"]);
    expect(by(r, "claude").diff).toMatch(/^--- ~\/\.claude\.json\n\+\+\+ ~\/\.claude\.json\n@@ /);
    expect(by(r, "claude").diff).toContain('+    "engram": {');
    expect(by(r, "cursor").diff).toMatch(/^--- \/dev\/null\n\+\+\+ ~\/\.cursor\/mcp\.json\n/);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before);
    expect(existsSync(join(home, ".claude.json.bak"))).toBe(false);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    const lines = formatInstallResults(r);
    expect(lines).toContain("  would write ~/.claude.json (backup: ~/.claude.json.bak)");
    expect(lines).toContain("  would write ~/.cursor/mcp.json (new file)");
    expect(lines.some((l) => l.startsWith("  @@ "))).toBe(true);
  });

  it("--project writes .mcp.json / .codex/config.toml / .cursor/mcp.json in the cwd", async () => {
    const c = ctx();
    const r = await runMcpInstall({ hosts: ["claude", "codex", "cursor"], scope: "project" }, { ctx: c, probe: healthy });
    expect(r.every((x) => x.action === "written")).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "project", ".mcp.json"), "utf8")).mcpServers.engram.type).toBe("http");
    expect(readFileSync(join(root, "project", ".codex", "config.toml"), "utf8")).toBe('[mcp_servers.engram]\nurl = "http://127.0.0.1:9907/mcp"\n');
    expect(existsSync(join(root, "project", ".cursor", "mcp.json"))).toBe(true);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(CLAUDE_FIXTURE); // user scope untouched
  });

  it("skips the Claude user-scope entry when the plugin is installed, unless --force; --project is unaffected", async () => {
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "context7@claude-plugins-official": [{ scope: "user", installPath: "/x", version: "abc" }],
        "engram@engram": [{ scope: "user", installPath: join(home, ".claude", "plugins", "cache", "engram", "engram", "0.3.0"), version: "0.3.0" }],
      },
    }));
    const c = ctx();
    expect(claudePluginStatus(c)).toMatchObject({ installed: true, key: "engram@engram", version: "0.3.0", scope: "user" });
    const r = await runMcpInstall({ hosts: ["claude"], scope: "user" }, { ctx: c, probe: healthy });
    expect(by(r, "claude").action).toBe("skipped");
    expect(by(r, "claude").notes[0]).toBe("the engram Claude Code plugin is installed (engram@engram 0.3.0, user scope) and already provides the server; a user-scope entry would register it twice");
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(CLAUDE_FIXTURE);
    expect(formatInstallResults(r)[0]).toBe("claude: skipped");
    const forced = await runMcpInstall({ hosts: ["claude"], scope: "user", force: true }, { ctx: c, probe: healthy });
    expect(by(forced, "claude").action).toBe("written");
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.engram.url).toBe("http://127.0.0.1:9907/mcp");
    const project = await runMcpInstall({ hosts: ["claude"], scope: "project" }, { ctx: c, probe: healthy });
    expect(by(project, "claude").action).toBe("written");
  });

  it("only the marketplace being added does not count as installed", () => {
    mkdirSync(join(home, ".claude", "plugins", "marketplaces", "engram"), { recursive: true });
    expect(claudePluginStatus(ctx())).toMatchObject({ installed: false, marketplaceAdded: true });
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "{ broken");
    expect(claudePluginStatus(ctx()).installed).toBe(false);
  });

  it("--all registers only the hosts whose config directory exists", () => {
    const c = ctx();
    expect(HOST_IDS.filter((id) => hostPresent(id, c))).toEqual(["claude", "codex", "cursor"]);
    mkdirSync(join(home, ".hermes"));
    expect(HOST_IDS.filter((id) => hostPresent(id, c))).toEqual(["claude", "codex", "cursor", "hermes"]);
    rmSync(join(home, ".claude.json"));
    rmSync(join(home, ".cursor"), { recursive: true });
    expect(HOST_IDS.filter((id) => hostPresent(id, c))).toEqual(["codex", "hermes"]);
    mkdirSync(join(home, ".claude"));
    expect(hostPresent("claude", c)).toBe(true); // ~/.claude without ~/.claude.json still means Claude Code is here
  });

  it("uninstall removes only engram and keeps a .bak; a second uninstall is a no-op", async () => {
    const c = ctx();
    await runMcpInstall({ hosts: ["claude", "codex", "cursor"], scope: "user" }, { ctx: c, probe: healthy });
    const un = await runMcpUninstall("claude", "user", { ctx: c });
    expect(un.action).toBe("written");
    const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(Object.keys(claude.mcpServers)).toEqual(["MCP_DOCKER", "windows-vm"]);
    expect(claude.projects["/Users/x/git/thing"].hasTrustDialogAccepted).toBe(true);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(CLAUDE_FIXTURE);
    expect(readFileSync(join(home, ".claude.json.bak"), "utf8")).toContain('"engram"');
    expect((await runMcpUninstall("claude", "user", { ctx: c })).action).toBe("unchanged");
    await runMcpUninstall("codex", "user", { ctx: c });
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(CODEX_FIXTURE);
    const dry = await runMcpUninstall("cursor", "user", { ctx: c }, true);
    expect(dry.action).toBe("dry-run");
    expect(dry.diff).toContain('-      "url": "http://127.0.0.1:9907/mcp"');
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.engram).toBeDefined();
  });

  it("a malformed host file is reported, never clobbered", async () => {
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ nope");
    const r = await runMcpInstall({ hosts: ["cursor"], scope: "user" }, { ctx: ctx(), probe: healthy });
    expect(by(r, "cursor").action).toBe("error");
    expect(by(r, "cursor").notes[0]).toMatch(/not valid JSON/);
    expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).toBe("{ nope");
    expect(formatInstallResults(r)[0]).toBe("cursor: ERROR");
  });
});

// ─── hermes ──────────────────────────────────────────────────────────

describe("engram mcp install hermes (plugin deploy)", () => {
  function hermesSource(): string {
    const src = join(pkg, "interfaces", "hermes-plugin");
    mkdirSync(src, { recursive: true });
    for (const f of ["__init__.py", "provider.py", "mcp_client.py", "plugin.yaml", "README.md"]) writeFileSync(join(src, f), `# ${f} v2\n`);
    writeFileSync(join(src, "deploy.sh"), "#!/usr/bin/env bash\necho deployed\n");
    return src;
  }

  it("runs deploy.sh with HERMES_HOME and the profiles that already have the plugin; dry-run only lists", async () => {
    hermesSource();
    const hh = join(home, ".hermes");
    mkdirSync(join(hh, "profiles", "alpha", "plugins", "engram"), { recursive: true });
    mkdirSync(join(hh, "profiles", "beta"), { recursive: true });
    const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
    const exec = async (cmd: string, args: string[], o?: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<ExecResult> => { calls.push({ cmd, args, env: o?.env, cwd: o?.cwd }); return { status: 0, stdout: "deployed: x\ndone: 2 target(s).\n", stderr: "" }; };
    const c = ctx();
    const dry = await runMcpInstall({ hosts: ["hermes"], scope: "user", dryRun: true }, { ctx: c, exec });
    expect(by(dry, "hermes").action).toBe("dry-run");
    expect(by(dry, "hermes").notes[0]).toBe(`would deploy ~/../engram/interfaces/hermes-plugin/deploy.sh → ~/.hermes/plugins/engram, ~/.hermes/profiles/alpha/plugins/engram`.replace("~/../engram", tildify(pkg, home)));
    expect(by(dry, "hermes").notes[1]).toContain("profiles without the plugin");
    expect(by(dry, "hermes").notes[1]).toContain("beta");
    expect(calls).toEqual([]);
    const r = await runMcpInstall({ hosts: ["hermes"], scope: "user" }, { ctx: c, exec });
    expect(by(r, "hermes").action).toBe("deployed");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("bash");
    expect(calls[0].args).toEqual([join(pkg, "interfaces", "hermes-plugin", "deploy.sh")]);
    expect(calls[0].cwd).toBe(pkg);
    expect(calls[0].env?.HERMES_HOME).toBe(hh);
    expect(calls[0].env?.ENGRAM_PLUGIN_PROFILES).toBe("alpha");
    expect(by(r, "hermes").notes.at(-1)).toBe("restart the Hermes gateways so they load the plugin");
    const failing = async (): Promise<ExecResult> => ({ status: 1, stdout: "", stderr: "deploy: missing file" });
    const bad = await runMcpInstall({ hosts: ["hermes"], scope: "user" }, { ctx: c, exec: failing });
    expect(by(bad, "hermes").action).toBe("error");
    expect(by(bad, "hermes").notes[0]).toContain("deploy.sh failed (exit 1): deploy: missing file");
  });

  it("prints the manual step on Windows and when the plugin source is not shipped (npm install)", async () => {
    mkdirSync(join(home, ".hermes"));
    const win = await runMcpInstall({ hosts: ["hermes"], scope: "user" }, { ctx: ctx({ platform: "win32" }) });
    expect(by(win, "hermes").action).toBe("manual");
    expect(by(win, "hermes").notes[0]).toMatch(/deploys with bash .* WSL or Git Bash/);
    const npm = await runMcpInstall({ hosts: ["hermes"], scope: "user" }, { ctx: ctx() });
    expect(by(npm, "hermes").action).toBe("manual");
    expect(by(npm, "hermes").notes[0]).toContain("ships with the source checkout, not the npm package");
  });

  it("uninstall removes only directories holding our plugin.yaml", async () => {
    const hh = join(home, ".hermes");
    for (const d of [join(hh, "plugins", "engram"), join(hh, "profiles", "p1", "plugins", "engram")]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "plugin.yaml"), "name: engram\n"); }
    mkdirSync(join(hh, "profiles", "p2", "plugins", "engram"), { recursive: true }); // not ours: no plugin.yaml
    const r = await runMcpUninstall("hermes", "user", { ctx: ctx() });
    expect(r.action).toBe("written");
    expect(existsSync(join(hh, "plugins", "engram"))).toBe(false);
    expect(existsSync(join(hh, "profiles", "p1", "plugins", "engram"))).toBe(false);
    expect(existsSync(join(hh, "profiles", "p2", "plugins", "engram"))).toBe(true);
    expect((await runMcpUninstall("hermes", "user", { ctx: ctx() })).notes[0]).toMatch(/nothing deployed|nothing/);
  });
});

// ─── status + doctor ─────────────────────────────────────────────────

describe("engram mcp status", () => {
  it("reports registered / current install / daemon / token for every host, with the platform hint when the token does not resolve", async () => {
    writeFileSync(join(home, ".config", "engram", "env"), "ENGRAM_MCP_TOKEN=tok\n");
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".cursor"));
    const c = ctx();
    await runMcpInstall({ hosts: ["claude", "codex", "cursor"], scope: "user" }, { ctx: c, probe: healthy });
    const report = await runMcpStatus({ ctx: c, probe: refused });
    expect(report.daemon).toMatchObject({ port: 9907, healthy: false });
    expect(report.daemon.detail).toContain("not answering /health");
    const claude = report.hosts.find((h) => h.host === "claude")!;
    expect(claude).toMatchObject({ registered: true, transport: "http", target: "http://127.0.0.1:9907/mcp", current: true, daemon: { port: 9907, healthy: false }, token: { envVar: "ENGRAM_MCP_TOKEN", resolves: false, inline: false, missing: false } });
    expect(report.hosts.find((h) => h.host === "codex")!.token).toEqual({ envVar: "ENGRAM_MCP_TOKEN", resolves: false, inline: false, missing: false });
    expect(report.hosts.find((h) => h.host === "hermes")).toMatchObject({ registered: false, present: false });
    expect(report.token).toMatchObject({ source: "env-file" });
    const text = formatStatus(report, c);
    expect(text[1]).toContain("http://127.0.0.1:9907/mcp — not answering /health");
    expect(text.find((l) => l.includes("claude"))).toMatch(/^\[--\]\s+claude\s+http → http:\/\/127\.0\.0\.1:9907\/mcp; current install; daemon :9907 down$/);
    expect(text).toContain("         token: references ENGRAM_MCP_TOKEN — NOT set in this environment");
    expect(text.some((l) => l.includes("launchctl setenv ENGRAM_MCP_TOKEN"))).toBe(true);
    expect(text.some((l) => l.includes("hermes") && l.includes("not installed"))).toBe(true);

    // With the variable set here and the daemon up, everything is [ok] and no hint is printed.
    const ok = await runMcpStatus({ ctx: ctx({ env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ENGRAM_MCP_TOKEN: "tok" } }), probe: healthy });
    const okText = formatStatus(ok, c);
    expect(okText.filter((l) => l.startsWith("[ok]"))).toHaveLength(3);
    expect(okText.some((l) => l.includes("launchctl"))).toBe(false);
    expect(ok.hosts.find((h) => h.host === "claude")!.token?.resolves).toBe(true);
    const linux = formatStatus(await runMcpStatus({ ctx: ctx({ platform: "linux" }), probe: refused }), c);
    expect(linux.some((l) => l.includes("environment.d/engram.conf"))).toBe(true);
    const win = formatStatus(await runMcpStatus({ ctx: ctx({ platform: "win32" }), probe: refused }), c);
    expect(win.some((l) => l.includes("setx ENGRAM_MCP_TOKEN"))).toBe(true);
  });

  it("flags a stale stdio path, another port, a missing token header, an npx entry and the plugin", async () => {
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { engram: { type: "stdio", command: "node", args: ["/old/engram/dist/interfaces/mcp/server.js"], env: {} } } }));
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.engram]\nurl = "http://127.0.0.1:9910/mcp"\n');
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { engram: { command: "npx", args: ["-y", `${PACKAGE_NAME}@0.3.0`, "mcp"] } } }));
    writeFileSync(join(home, ".config", "engram", "env"), "ENGRAM_MCP_TOKEN=tok\n");
    const c = ctx();
    const report = await runMcpStatus({ ctx: c, probe: async (port, t) => (port === 9907 ? healthy(port, t) : refused(port, t)) });
    const claude = report.hosts.find((h) => h.host === "claude")!;
    expect(claude).toMatchObject({ registered: true, transport: "stdio", current: false, daemon: { port: 9907, healthy: true } });
    expect(claude.target).toBe("/old/engram/dist/interfaces/mcp/server.js (missing)");
    const codex = report.hosts.find((h) => h.host === "codex")!;
    expect(codex).toMatchObject({ transport: "http", current: false, daemon: { port: 9910, healthy: false }, token: { envVar: null, missing: true } });
    expect(codex.notes[0]).toBe("points at :9910; this install's daemon port is :9907 (ENGRAM_MCP_PORT)");
    const cursor = report.hosts.find((h) => h.host === "cursor")!;
    expect(cursor).toMatchObject({ transport: "stdio", current: null });
    expect(cursor.target).toContain(`npx ${PACKAGE_NAME}@0.3.0 (published package`);
    const text = formatStatus(report, c);
    expect(text.find((l) => l.includes(" claude "))).toMatch(/^\[--\]\s+claude\s+stdio → \/old\/engram\/dist\/interfaces\/mcp\/server\.js \(missing\); NOT this install; daemon :9907 answering$/);
    expect(text).toContain("         token: the daemon requires ENGRAM_MCP_TOKEN but this entry sends none — re-run engram mcp install codex");

    // the current install's server.js (realpath) counts as current; the Claude plugin counts as registered
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { engram: { type: "stdio", command: "node", args: [join(pkg, "dist", "interfaces", "mcp", "server.js")] } } }));
    expect((await runMcpStatus({ ctx: c, probe: false })).hosts[0]).toMatchObject({ current: true, daemon: { port: 9907, healthy: null } });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "engram@engram": [{ scope: "user", version: "0.3.0" }] } }));
    const withPlugin = await runMcpStatus({ ctx: c, probe: false });
    expect(withPlugin.hosts[0]).toMatchObject({ registered: true, target: "Claude Code plugin", plugin: { installed: true, key: "engram@engram" } });
    expect(formatStatus(withPlugin, c).find((l) => l.includes(" claude "))).toContain("via the Claude Code plugin");
    expect(readRegisteredEntry("claude", join(home, ".claude.json"))).toBeNull();
  });

  it("reports the deployed Hermes plugin: copies, staleness against the checkout, engram.json token", async () => {
    const src = join(pkg, "interfaces", "hermes-plugin");
    mkdirSync(src, { recursive: true });
    const hh = join(home, ".hermes");
    const target = join(hh, "plugins", "engram");
    mkdirSync(target, { recursive: true });
    for (const f of ["__init__.py", "provider.py", "mcp_client.py", "plugin.yaml", "README.md"]) { writeFileSync(join(src, f), `# ${f}\n`); writeFileSync(join(target, f), `# ${f}\n`); }
    writeFileSync(join(hh, "engram.json"), JSON.stringify({ base_url: "http://127.0.0.1:9907", token: "" }));
    writeFileSync(join(home, ".config", "engram", "env"), "ENGRAM_MCP_TOKEN=tok\n");
    const c = ctx();
    let hermes = (await runMcpStatus({ ctx: c, probe: healthy })).hosts.find((h) => h.host === "hermes")!;
    expect(hermes).toMatchObject({ registered: true, current: true, target: "1 plugin copy", daemon: { port: 9907, healthy: true }, token: { inline: false, missing: true } });
    expect(hermes.notes[0]).toContain('has no "token"');
    writeFileSync(join(target, "provider.py"), "# older\n");
    writeFileSync(join(hh, "engram.json"), JSON.stringify({ base_url: "http://127.0.0.1:9907", token: "tok" }));
    hermes = (await runMcpStatus({ ctx: c, probe: healthy })).hosts.find((h) => h.host === "hermes")!;
    expect(hermes.current).toBe(false);
    expect(hermes.notes[0]).toMatch(/differs from this checkout: ~\/\.hermes\/plugins\/engram — engram mcp install hermes/);
    expect(hermes.token).toMatchObject({ inline: true, missing: false });
    expect(formatStatus(await runMcpStatus({ ctx: c, probe: healthy }), c).find((l) => l.includes(" hermes "))).toContain("stale copy (redeploy)");
  });
});

describe("doctor hosts check (#50)", () => {
  it("is [--] with the install hint when nothing is registered, [ok] once a host points at this install, never required", async () => {
    expect(DOCTOR_CHECK_NAMES).toContain("hosts");
    // #61 put `extraction smoke` after it
    expect(DOCTOR_CHECK_NAMES.at(-2)).toBe("hosts");
    expect(DOCTOR_CHECK_NAMES.at(-1)).toBe("extraction smoke");
    const c = ctx();
    const none = await checkHosts(c);
    expect(none).toEqual({ name: "hosts", level: "warn", required: false, detail: "no host registered — engram mcp install claude|codex|cursor|hermes (or --all)" });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { engram: { type: "stdio", command: "node", args: ["/old/dist/interfaces/mcp/server.js"] } } }));
    const stale = await checkHosts(c);
    expect(stale.level).toBe("warn");
    expect(stale.detail).toBe("claude (stdio, not this install) — none points at this install; re-run engram mcp install <host>");
    mkdirSync(join(home, ".codex"));
    await runMcpInstall({ hosts: ["codex"], scope: "user" }, { ctx: c, probe: healthy });
    const ok = await checkHosts(c);
    expect(ok.level).toBe("ok");
    expect(ok.detail).toBe("claude (stdio, not this install), codex (http) — engram mcp status for the rest");
    expect((await summariseHostsForDoctor(c)).ok).toBe(true);
  });
});
