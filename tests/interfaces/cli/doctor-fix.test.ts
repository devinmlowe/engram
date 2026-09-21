/**
 * Issue #61: `engram doctor --fix`. Every remediation runs against a temp
 * HOME / data dir with a fake shell, fake supervisor and fake probes; nothing
 * here touches ~/.config/engram, ~/.claude*, launchd or Ollama.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/_core/config/index.js";
import type { OllamaProbe } from "../../../src/_core/llm/index.js";
import {
  applyDoctorFixes, checkEnvFile, checkHosts, checkMcpDaemon, checkModelCache, checkOllama, formatFixResults, runDoctor,
  type DoctorReport,
} from "../../../src/interfaces/cli/doctor.js";
import { ensureServiceEnvFile, fileMode, serviceEnvTemplate } from "../../../src/interfaces/cli/data-migration.js";
import { defaultHostContext, type HealthProbe, type HostContext } from "../../../src/interfaces/cli/hosts.js";
import type { ExecResult, ServiceDeps } from "../../../src/interfaces/cli/services.js";

const ENV_KEYS = ["ENGRAM_DATA_DIR", "ENGRAM_DB_PATH", "ENGRAM_MODEL_CACHE_DIR", "HF_HOME", "ENGRAM_MCP_PORT", "XDG_CONFIG_HOME", "ENGRAM_ENV_FILE", "OLLAMA_HOST", "ENGRAM_LOCAL_MODEL"];
let root: string;
let home: string;
let pkg: string;

beforeEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, undefined);
  root = mkdtempSync(join(tmpdir(), "engram-doctor-fix-"));
  home = join(root, "home");
  pkg = join(root, "engram");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(pkg, "dist", "interfaces", "cli"), { recursive: true });
  writeFileSync(join(pkg, "dist", "interfaces", "cli", "index.js"), "// cli");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Call = { cmd: string; args: string[] };
function fakeExec(handlers: Array<[RegExp, (args: string[]) => Partial<ExecResult> | void]>, calls: Call[] = []) {
  const exec = async (cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push({ cmd, args });
    const line = `${cmd} ${args.join(" ")}`;
    for (const [re, h] of handlers) if (re.test(line)) return { status: 0, stdout: "", stderr: "", ...(h(args) ?? {}) };
    return { status: 1, stdout: "", stderr: `no fake for: ${line}` };
  };
  return { exec, calls };
}

const refused = async () => { const e = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException; e.code = "ECONNREFUSED"; throw e; };
const healthy: HealthProbe = async () => ({ status: 200, body: JSON.stringify({ status: "ok", workers: { size: 2, ready: 2 } }) });

const envFile = () => join(home, ".config", "engram", "env");
const hostCtx = (overrides: Partial<HostContext> = {}): HostContext =>
  defaultHostContext({ home, cwd: root, env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, platform: "darwin", packageRoot: pkg, node: "/usr/local/bin/node", hermesHome: join(home, ".hermes"), ...overrides });

// ─── env file ────────────────────────────────────────────────────────

describe("env file check + fix", () => {
  it("warns with a create fix when missing; apply creates it (mode 600, dir 700, commented template) and re-checks ok", async () => {
    const file = envFile();
    const c = checkEnvFile(file, join(root, "data"), "darwin");
    expect(c.name).toBe("env file");
    expect(c.level).toBe("warn");
    expect(c.required).toBe(false);
    expect(c.detail).toContain("missing");
    expect(c.fix).toBeDefined();
    expect(c.fix!.needsConfirm).toBeFalsy();
    expect(c.fix!.describe).toContain("umask 077");
    expect(c.fix!.describe).toContain(file);

    const next = await c.fix!.apply();
    expect(next.level).toBe("ok");
    expect(next.detail).toContain("mode 600");
    expect(next.fix).toBeUndefined();
    expect(fileMode(file)).toBe(0o600);
    expect(statSync(join(home, ".config", "engram")).mode & 0o777).toBe(0o700);
    const text = readFileSync(file, "utf8");
    expect(text).toBe(serviceEnvTemplate(join(root, "data")));
    expect(text).toContain(join(root, "data"));
    // every line commented out: creating the file changes nothing
    for (const line of text.split("\n").filter(Boolean)) expect(line.startsWith("#")).toBe(true);
    for (const v of ["ENGRAM_MODEL_CACHE_DIR", "ENGRAM_MCP_TOKEN", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "ENGRAM_OPENAI_BASE_URL", "ENGRAM_LLM_PROVIDERS", "ENGRAM_LOCAL_MODEL"]) expect(text).toContain(`#${v}=`);
  });

  it("never rewrites an existing file: ensureServiceEnvFile only tightens the mode", () => {
    const file = envFile();
    mkdirSync(join(home, ".config", "engram"), { recursive: true });
    writeFileSync(file, "OPENROUTER_API_KEY=secret\n");
    chmodSync(file, 0o644);
    expect(ensureServiceEnvFile(file, root, "darwin")).toBe("chmod");
    expect(readFileSync(file, "utf8")).toBe("OPENROUTER_API_KEY=secret\n");
    expect(fileMode(file)).toBe(0o600);
    expect(ensureServiceEnvFile(file, root, "darwin")).toBe("unchanged");
  });

  it.skipIf(process.platform === "win32")("warns with a chmod fix when group/other can read it, and is ok at 600 (or narrower)", async () => {
    const file = envFile();
    mkdirSync(join(home, ".config", "engram"), { recursive: true });
    writeFileSync(file, "# x\n");
    chmodSync(file, 0o644);
    const wide = checkEnvFile(file, root, "darwin");
    expect(wide.level).toBe("warn");
    expect(wide.detail).toContain("mode 644");
    expect(wide.fix!.describe).toBe(`chmod 600 ${file}`);
    const fixed = await wide.fix!.apply();
    expect(fixed.level).toBe("ok");
    expect(fileMode(file)).toBe(0o600);
    chmodSync(file, 0o400);
    expect(checkEnvFile(file, root, "darwin").level).toBe("ok");
  });

  it("on Windows judges presence only", () => {
    const file = envFile();
    expect(checkEnvFile(file, root, "win32").level).toBe("warn");
    expect(checkEnvFile(file, root, "win32").fix!.describe).toContain("New-Item");
    mkdirSync(join(home, ".config", "engram"), { recursive: true });
    writeFileSync(file, "# x\n");
    expect(checkEnvFile(file, root, "win32")).toMatchObject({ level: "ok", detail: `${file} (present)` });
  });
});

// ─── model cache ─────────────────────────────────────────────────────

describe("model cache fix (#53 + #61)", () => {
  it("writes ENGRAM_MODEL_CACHE_DIR to the env file, moves the node_modules weights, adopts the value in-process and re-checks ok", async () => {
    const legacy = join(pkg, "node_modules", "@xenova", "transformers", ".cache");
    mkdirSync(join(legacy, "model"), { recursive: true });
    writeFileSync(join(legacy, "model", "weights.onnx"), "weights");
    const dataDir = join(root, "data");
    const config = loadConfig({ dataDir, modelCacheDir: legacy });
    const env: NodeJS.ProcessEnv = { ENGRAM_MODEL_CACHE_DIR: legacy, XDG_CONFIG_HOME: join(home, ".config") };
    const fixCtx = { config, env, home, platform: "darwin" as const, packageRoot: pkg };

    const c = checkModelCache({ dir: legacy, source: "ENGRAM_MODEL_CACHE_DIR" }, fixCtx);
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("durable: no");
    expect(c.fix).toBeDefined();
    expect(c.fix!.needsConfirm).toBeFalsy();
    expect(c.fix!.describe).toContain("engram migrate model-cache");
    expect(c.fix!.describe).toContain(envFile());
    expect(c.fix!.describe).toContain(join(dataDir, "models"));

    const next = await c.fix!.apply();
    expect(next.level).toBe("ok");
    expect(next.detail).toContain(join(dataDir, "models"));
    expect(next.detail).toContain("durable: yes");
    expect(next.detail).toContain(`written to ${envFile()}`);
    expect(next.detail).toContain("other shells need: export ENGRAM_MODEL_CACHE_DIR=");
    // the env file was created (mode 600) and carries the line
    expect(fileMode(envFile())).toBe(0o600);
    expect(readFileSync(envFile(), "utf8")).toMatch(new RegExp(`^ENGRAM_MODEL_CACHE_DIR='${join(dataDir, "models").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"));
    // the weights moved, this process now points at the durable dir
    expect(existsSync(join(dataDir, "models", "model", "weights.onnx"))).toBe(true);
    expect(existsSync(join(legacy, "model", "weights.onnx"))).toBe(false);
    expect(env.ENGRAM_MODEL_CACHE_DIR).toBe(join(dataDir, "models"));

    // A new shell still exporting the old path: nothing left for --fix, the line says what to export.
    const again = checkModelCache({ dir: legacy, source: "ENGRAM_MODEL_CACHE_DIR" }, { ...fixCtx, env: { ...env, ENGRAM_MODEL_CACHE_DIR: legacy } });
    expect(again.level).toBe("warn");
    expect(again.fix).toBeUndefined();
    expect(again.detail).toContain("already sets a durable dir");
    expect(again.detail).toContain("export ENGRAM_MODEL_CACHE_DIR=");
  });

  it("attaches no fix to a durable cache", () => {
    const dir = join(root, "data", "models");
    const config = loadConfig({ dataDir: join(root, "data") });
    const c = checkModelCache({ dir, source: "default" }, { config, env: {}, home, platform: "darwin", packageRoot: pkg });
    expect(c.level).toBe("ok");
    expect(c.fix).toBeUndefined();
  });
});

// ─── ollama ──────────────────────────────────────────────────────────

describe("ollama fix (confirm-gated pull)", () => {
  const config = () => loadConfig({ dataDir: join(root, "data") });

  it("offers `ollama pull <model>` only when Ollama is reachable and the model is missing", async () => {
    const { exec, calls } = fakeExec([]);
    const missing: OllamaProbe = { reachable: true, available: ["llama3:8b"], model: undefined };
    const c = await checkOllama(config(), { exec, probe: async () => missing });
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("qwen2.5:7b not found");
    expect(c.fix).toMatchObject({ describe: "ollama pull qwen2.5:7b", needsConfirm: true });
    expect(calls).toEqual([]);

    const down = await checkOllama(config(), { exec, probe: async () => ({ reachable: false, available: [] }) });
    expect(down.level).toBe("warn");
    expect(down.fix).toBeUndefined();
    expect(down.detail).toContain("not reachable");

    const pulled = await checkOllama(config(), { exec, probe: async () => ({ reachable: true, available: ["qwen2.5:7b"], model: "qwen2.5:7b" }) });
    expect(pulled.level).toBe("ok");
    expect(pulled.fix).toBeUndefined();
  });

  it("non-TTY without --yes skips it and prints the manual line; --yes runs the pull through the injected shell and re-checks", async () => {
    let pulledModel: string | null = null;
    const { exec, calls } = fakeExec([[/^ollama pull /, (args) => { pulledModel = args[1]; }]]);
    const probe = async (): Promise<OllamaProbe> => pulledModel ? { reachable: true, available: [pulledModel], model: pulledModel } : { reachable: true, available: [], model: undefined };
    const report = (c: Awaited<ReturnType<typeof checkOllama>>): DoctorReport => ({ node: "v", platform: "p", checks: [c], ok: true });

    const skipped = await applyDoctorFixes(report(await checkOllama(config(), { exec, probe })), {});
    expect(skipped.fixes).toHaveLength(1);
    expect(skipped.fixes![0]).toMatchObject({ name: "ollama", status: "skipped", applied: false, manual: "ollama pull qwen2.5:7b" });
    expect(skipped.fixes![0].detail).toContain("--yes");
    expect(calls).toEqual([]);
    const lines = formatFixResults(skipped.fixes!);
    expect(lines[0]).toMatch(/^\[skipped\] ollama: needs confirmation/);
    expect(lines[1]).toBe("  manual: ollama pull qwen2.5:7b");
    expect(lines.at(-1)).toBe("Doctor --fix: 1 skipped");

    // a terminal that answers no
    const declined = await applyDoctorFixes(report(await checkOllama(config(), { exec, probe })), { confirm: async () => false });
    expect(declined.fixes![0]).toMatchObject({ status: "skipped", detail: "declined" });
    expect(calls).toEqual([]);

    const applied = await applyDoctorFixes(report(await checkOllama(config(), { exec, probe })), { yes: true });
    expect(calls).toEqual([{ cmd: "ollama", args: ["pull", "qwen2.5:7b"] }]);
    expect(applied.fixes![0]).toMatchObject({ name: "ollama", status: "fixed", applied: true, level: "ok" });
    expect(applied.checks[0].level).toBe("ok");
    expect(formatFixResults(applied.fixes!)[0]).toMatch(/^\[fixed\] ollama: qwen2.5:7b at /);
  });

  it("reports a failed pull as [failed] with the manual line, leaving the check as it was", async () => {
    const { exec } = fakeExec([[/^ollama pull /, () => ({ status: 1, stderr: "Error: pull model manifest: file does not exist" })]]);
    const c = await checkOllama(config(), { exec, probe: async () => ({ reachable: true, available: [], model: undefined }) });
    const r = await applyDoctorFixes({ node: "v", platform: "p", checks: [c], ok: true }, { yes: true });
    expect(r.fixes![0]).toMatchObject({ status: "failed", applied: false, level: "warn" });
    expect(r.fixes![0].detail).toContain("pull model manifest");
    expect(r.checks[0]).toBe(c);
  });
});

// ─── mcp daemon ──────────────────────────────────────────────────────

describe("mcp daemon fix (start an installed, stopped service)", () => {
  function services(exec: ServiceDeps["exec"], probe: ServiceDeps["probe"]): ServiceDeps {
    return { platform: "darwin", exec, probe, home, engramDir: pkg, env: {}, uid: 501 };
  }

  it("starts through the supervisor adapter, waits for /health and re-checks", async () => {
    const plist = join(home, "Library", "LaunchAgents", "com.engram.mcp.plist");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, "<plist/>");
    let loaded = false;
    const { exec, calls } = fakeExec([
      [/^launchctl list/, () => (loaded ? { status: 0, stdout: '{ "PID" = 42; }' } : { status: 1 })],
      [/^launchctl load/, () => { loaded = true; }],
    ]);
    const probe = async () => loaded;
    const mcpProbe = async (_port: number) => { if (!loaded) return refused(); return { status: 200, body: JSON.stringify({ status: "ok", workers: { size: 1 } }) }; };

    const c = await checkMcpDaemon(9907, mcpProbe, { services: services(exec, probe), startWaitMs: 200 });
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("installed but not running");
    expect(c.fix).toMatchObject({ describe: `launchctl load ${plist}` });
    expect(c.fix!.needsConfirm).toBeFalsy();

    const next = await c.fix!.apply();
    expect(calls.some((x) => x.cmd === "launchctl" && x.args[0] === "load" && x.args[1] === plist)).toBe(true);
    expect(next.level).toBe("ok");
    expect(next.detail).toContain("answering at http://127.0.0.1:9907/health");
  });

  it("offers no fix when the daemon is not installed (that is setup's job) but keeps the installer hint", async () => {
    const { exec } = fakeExec([[/^launchctl list/, () => ({ status: 1 })]]);
    const c = await checkMcpDaemon(9907, refused, { services: services(exec, async () => false) });
    expect(c.level).toBe("warn");
    expect(c.fix).toBeUndefined();
    expect(c.detail).toContain("install-mcp-daemon.sh");
  });

  it("fails the fix (and says so) when the port never answers after the start", async () => {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.engram.mcp.plist"), "<plist/>");
    const { exec } = fakeExec([[/^launchctl list/, () => ({ status: 1 })], [/^launchctl load/, () => ({})]]);
    const c = await checkMcpDaemon(9907, refused, { services: services(exec, async () => false), startWaitMs: 20 });
    const r = await applyDoctorFixes({ node: "v", platform: "p", checks: [c], ok: true }, {});
    expect(r.fixes![0].status).toBe("failed");
    expect(r.fixes![0].detail).toMatch(/did not answer within/);
  });
});

// ─── hosts ───────────────────────────────────────────────────────────

describe("hosts fix (register the first host present)", () => {
  it("runs `engram mcp install claude` with the injected HostContext when ~/.claude exists and nothing is registered", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const ctx = hostCtx();
    const { exec } = fakeExec([]);
    const c = await checkHosts(ctx, { probe: healthy, exec });
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("no host registered");
    expect(c.fix).toMatchObject({ describe: "engram mcp install claude" });

    const next = await c.fix!.apply();
    expect(next.level).toBe("ok");
    expect(next.detail).toContain("claude (http)");
    const written = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
    expect(written.mcpServers.engram.url).toBe("http://127.0.0.1:9907/mcp");
  });

  it("prefers claude, else the first host whose dir exists (codex here)", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    const c = await checkHosts(hostCtx(), { probe: healthy });
    expect(c.fix!.describe).toBe("engram mcp install codex");
  });

  it("offers no fix on a machine without any host config dir", async () => {
    const c = await checkHosts(hostCtx(), { probe: healthy });
    expect(c.level).toBe("warn");
    expect(c.fix).toBeUndefined();
    expect(c.detail).toContain("no host config dir found");
  });

  it("is already ok (no fix) when the Claude Code plugin is installed (#60)", async () => {
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "engram@engram": [{ version: "0.3.0", scope: "user" }] } }));
    const c = await checkHosts(hostCtx(), { probe: healthy });
    expect(c.level).toBe("ok");
    expect(c.detail).toContain("claude (plugin)");
    expect(c.fix).toBeUndefined();
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
  });

  it("offers no fix when a host is registered but points at another install (the hint stands)", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { engram: { type: "http", url: "http://127.0.0.1:9999/mcp" } } }));
    const c = await checkHosts(hostCtx(), { probe: healthy });
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("none points at this install");
    expect(c.fix).toBeUndefined();
  });
});

// ─── doctor --fix as a whole ─────────────────────────────────────────

describe("doctor --fix end to end (temp home, fakes)", () => {
  function ctx() {
    const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: "" };
    const { exec } = fakeExec([[/^launchctl list/, () => ({ status: 1 })]]);
    const services: ServiceDeps = { platform: "darwin", exec, probe: async () => false, home, engramDir: pkg, env, uid: 501 };
    return {
      env, home, platform: "darwin" as const, packageRoot: pkg, exec, services,
      hosts: hostCtx({ env }),
      hostProbe: healthy,
      mcpProbe: refused,
      ollamaProbe: async (): Promise<OllamaProbe> => ({ reachable: true, available: ["qwen2.5:7b"], model: "qwen2.5:7b" }),
      installPath: { path: "", platform: "darwin" as const },
    };
  }

  it("applies every non-ok check's fix, then a second run reports nothing to fix; --json carries fixes[]", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const config = loadConfig({ dataDir: join(root, "data") });

    const first = await runDoctor(config, { noSmoke: true, ctx: ctx() });
    const before = Object.fromEntries(first.checks.map((c) => [c.name, c.level]));
    expect(before["env file"]).toBe("warn");
    expect(before["hosts"]).toBe("warn");
    expect(before["mcp daemon"]).toBe("warn"); // not installed: no fix, hint only
    expect(first.checks.find((c) => c.name === "mcp daemon")!.fix).toBeUndefined();
    expect(first.checks.find((c) => c.name === "extraction smoke")!.detail).toBe("skipped (--no-smoke)");

    const fixed = await applyDoctorFixes(first, {});
    expect(fixed.fixes!.map((f) => [f.name, f.status])).toEqual([["env file", "fixed"], ["hosts", "fixed"]]);
    for (const f of fixed.fixes!) { expect(f.applied).toBe(true); expect(f.manual.length).toBeGreaterThan(0); }
    expect(fixed.checks.find((c) => c.name === "env file")!.level).toBe("ok");
    expect(fixed.checks.find((c) => c.name === "hosts")!.level).toBe("ok");
    expect(fileMode(envFile())).toBe(0o600);
    expect(existsSync(join(home, ".claude.json"))).toBe(true);
    const lines = formatFixResults(fixed.fixes!);
    expect(lines[0]).toMatch(/^\[fixed\] env file: .*mode 600/);
    expect(lines[1]).toMatch(/^  manual: mkdir -p /);
    expect(lines[2]).toMatch(/^\[fixed\] hosts: claude \(http\)/);
    expect(lines[3]).toBe("  manual: engram mcp install claude");
    expect(lines.at(-1)).toBe("Doctor --fix: 2 fixed");

    // idempotent: the second run has no candidate left
    const second = await applyDoctorFixes(await runDoctor(config, { noSmoke: true, ctx: ctx() }), {});
    expect(second.fixes).toEqual([]);
    expect(formatFixResults(second.fixes!)).toEqual(["Doctor --fix: nothing to fix"]);
    // ~/.claude.json unchanged by the second install (byte-identical, no .bak churn)
    expect(existsSync(join(home, ".claude.json.bak"))).toBe(false);

    // --json shape
    const json = JSON.parse(JSON.stringify(fixed)) as DoctorReport & { fixes: Array<Record<string, unknown>> };
    expect(json.fixes[0]).toMatchObject({ name: "env file", applied: true, status: "fixed" });
    expect(typeof json.fixes[0].detail).toBe("string");
    expect(typeof json.fixes[0].manual).toBe("string");
    expect(json.smoke!.status).toBe("skipped");
  });
});
