/**
 * Issue #61 / decision #62: `engram setup`. Every collaborator is a fake —
 * init, sync, host registration, the supervisor and its installers, the
 * doctor run, the smoke — against a temp home, so nothing here downloads a
 * model, indexes ~/.claude, runs an installer or touches launchd.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/_core/config/index.js";
import type { EngramConfig } from "../../../src/_core/types/index.js";
import type { DoctorCheck, DoctorReport } from "../../../src/interfaces/cli/doctor.js";
import { defaultHostContext, type HealthProbe, type HostContext, type HostId, type InstallResult } from "../../../src/interfaces/cli/hosts.js";
import { installCommand, type ExecResult, type ServiceDeps, type ServiceId } from "../../../src/interfaces/cli/services.js";
import { ALL_DAEMONS, defaultSetupDeps, parseDaemonList, runSetup, type SetupDeps, type SetupOptions } from "../../../src/interfaces/cli/setup.js";
import type { SmokeOutcome } from "../../../src/interfaces/cli/smoke.js";

const ENV_KEYS = ["ENGRAM_DATA_DIR", "ENGRAM_DB_PATH", "ENGRAM_MODEL_CACHE_DIR", "HF_HOME", "ENGRAM_MCP_PORT", "XDG_CONFIG_HOME", "ENGRAM_ENV_FILE", "PORT", "ENGRAM_CLAUDE_PROJECTS_DIR"];
let saved: Record<string, string | undefined>;
let root: string;
let home: string;
let pkg: string;
let config: EngramConfig;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  root = mkdtempSync(join(tmpdir(), "engram-setup-"));
  home = join(root, "home");
  pkg = join(root, "engram");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(pkg, "scripts"), { recursive: true });
  mkdirSync(join(pkg, "dist", "interfaces", "cli"), { recursive: true });
  writeFileSync(join(pkg, "dist", "interfaces", "cli", "index.js"), "// cli");
  config = loadConfig({ dataDir: join(root, "data"), claudeProjectsDir: join(root, "projects") });
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
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

const healthy: HealthProbe = async () => ({ status: 200, body: JSON.stringify({ status: "ok", workers: { size: 2, ready: 2 } }) });

function check(name: DoctorCheck["name"], level: DoctorCheck["level"] = "ok", required = false): DoctorCheck {
  return { name, level, required, detail: `${name} detail` };
}
function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  const checks = overrides.checks ?? [check("node", "ok", true), check("better-sqlite3", "ok", true), check("env file", "warn"), check("hosts", "warn"), check("extraction smoke", "warn")];
  return { node: "v22", platform: "darwin-arm64", checks, ok: checks.every((c) => !(c.required && c.level === "fail")), ...overrides };
}
const smokeOk = (): SmokeOutcome => ({ status: "ok", source: "conversation", conversationId: "c1", exchanges: 3, provider: "ollama", model: "qwen2.5:7b", memories: 2, written: { inserted: 2, merged: 0, conflicts: 0, skipped: 0, errors: 0 }, tiers: [], message: "tier=ollama memories=2 (qwen2.5:7b)", durationMs: 5 });
const smokeNoTier = (): SmokeOutcome => ({ status: "no-tier", source: "fixture", conversationId: "smoke-fixture", exchanges: 3, provider: null, model: null, memories: 0, written: null, tiers: [{ tier: "ollama", errorClass: "config", reason: "skipped: Ollama not reachable" }], message: "no LLM tier reachable — ollama: skipped: Ollama not reachable", durationMs: 5 });

interface Harness {
  deps: SetupDeps;
  lines: string[];
  installed: ServiceId[];
  hostsInstalled: HostId[][];
  calls: Call[];
  syncCalls: number;
  initCalls: number;
  lingerCalls: number;
}

function harness(o: {
  platform?: ServiceDeps["platform"];
  running?: ServiceId[];
  smoke?: SmokeOutcome;
  doctor?: DoctorReport;
  confirm?: (q: string) => Promise<boolean>;
  installHosts?: SetupDeps["installHosts"];
  installService?: SetupDeps["installService"];
  hostCtx?: Partial<HostContext>;
} = {}): Harness {
  const platform = o.platform ?? "darwin";
  const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: "" };
  const lines: string[] = [];
  const installed: ServiceId[] = [];
  const hostsInstalled: HostId[][] = [];
  const { exec, calls } = fakeExec([[/launchctl list|systemctl --user is-active|schtasks/, () => ({ status: 1 })]]);
  const services: ServiceDeps = { platform, exec, probe: async () => false, home, engramDir: pkg, env, uid: 501 };
  const hosts = defaultHostContext({ home, cwd: root, env, platform: platform === "win32" ? "win32" : "darwin", packageRoot: pkg, node: "/usr/local/bin/node", hermesHome: join(home, ".hermes"), ...o.hostCtx });
  const smoke = o.smoke ?? smokeOk();
  const h: Harness = { lines, installed, hostsInstalled, calls, syncCalls: 0, initCalls: 0, lingerCalls: 0, deps: null as unknown as SetupDeps };
  h.deps = defaultSetupDeps({
    config, services, hosts, hermesHome: join(home, ".hermes"), user: "dev",
    log: (l) => lines.push(l),
    confirm: o.confirm,
    hostProbe: healthy,
    doctor: { env, home, platform, packageRoot: pkg, exec, services, hosts, hostProbe: healthy, installPath: { path: "", platform }, smoke: { extract: async (id) => ({ conversationId: id, facts: smoke.status === "ok" ? [{ type: "fact", content: "x", importance: 0.5, sourceExchangeIds: [] }] : [], model: "m", tier: "local", provider: "ollama", confidence: 1, durationMs: 1 }) } },
    init: async (cfg) => { h.initCalls++; return { dbPath: cfg.dbPath, created: true, modelCacheDir: cfg.modelCacheDir, model: "nomic" }; },
    sync: async () => { h.syncCalls++; return { discovered: 4, copied: 4, skipped: 1, indexed: 3, conversations: 3, errors: [] }; },
    installHosts: o.installHosts ?? (async (ids) => { hostsInstalled.push(ids); return ids.map<InstallResult>((id) => ({ host: id, label: id, scope: "user", path: `~/.${id}`, transport: "http", reason: "daemon answering", auth: "none", action: "written", backup: null, diff: "", notes: [`wrote ~/.${id}`, `restart ${id}; check`] })); }),
    serviceStatus: async (id) => ({ id, supervisor: platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : "task-scheduler", unit: `unit-${id}`, installed: (o.running ?? []).includes(id), running: (o.running ?? []).includes(id), listening: null, unsupervised: false, stopCommand: "", startCommand: "", restartCommand: "", installHint: `hint-${id}` }),
    installService: o.installService ?? (async (id) => { installed.push(id); return { status: 0, stdout: `installed ${id}\n`, stderr: "" }; }),
    enableLinger: async () => { h.lingerCalls++; return { status: 0, stdout: "", stderr: "" }; },
    // The doctor is a fake report so the run needs no native modules or network; the
    // smoke seam above still drives step 7 through the real checkSmoke.
    runDoctor: async () => ({ ...(o.doctor ?? report()), smoke: undefined }),
  });
  // step 7 uses the real checkSmoke: hand it the outcome we want via the extract seam,
  // or make the extractor throw a cascade for the no-tier case
  if (smoke.status === "no-tier") {
    h.deps.doctor.smoke = { extract: async () => { const { CascadeError } = await import("../../../src/_core/llm/index.js"); throw new CascadeError([{ tier: "ollama", errorClass: "config", message: "skipped: Ollama not reachable" }]); } };
  }
  return h;
}

const run = (h: Harness, opts: SetupOptions = {}) => runSetup(opts, h.deps);
const step = (r: Awaited<ReturnType<typeof runSetup>>, name: string) => r.steps.find((s) => s.name === name)!;

describe("engram setup — full run with fakes", () => {
  it("--yes: doctor, init, sync, hosts for the present host, ALL THREE daemons (#62), doctor --fix, smoke, summary; exit 0", async () => {
    const h = harness();
    const r = await run(h, { yes: true });
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => [s.n, s.name, s.status])).toEqual([
      [1, "doctor", "warn"], [2, "init", "ok"], [3, "sync", "ok"], [4, "hosts", "ok"], [5, "daemons", "ok"], [6, "doctor --fix", "ok"], [7, "extraction smoke", "ok"],
    ]);
    expect(h.initCalls).toBe(1);
    expect(h.syncCalls).toBe(1);
    expect(h.hostsInstalled).toEqual([["claude"]]);
    // decision #62: every service, MCP first
    expect(h.installed).toEqual(["mcp", "dream", "visualizer"]);
    expect(r.daemons.map((d) => [d.id, d.action])).toEqual([["mcp", "installed"], ["dream", "installed"], ["visualizer", "installed"]]);
    expect(h.lingerCalls).toBe(0); // macOS: no linger prompt at all
    // every step names its manual equivalent
    for (const s of r.steps) expect(s.manual.length, s.name).toBeGreaterThan(0);
    expect(h.lines).toContainEqual(expect.stringMatching(/^── 1\. doctor\s+\(manual: engram doctor\)$/));
    expect(h.lines).toContainEqual(expect.stringMatching(/^── 5\. daemons\s+\(manual: .*install-mcp-daemon\.sh install; .*install-daemon\.sh install; .*install-visualizer\.sh install\)$/));
    // the visualizer line: port + bind
    const viz = h.lines.find((l) => /visualizer installed on port 3001/.test(l))!;
    expect(viz).toContain("binds 127.0.0.1");
    expect(viz).toContain("ENGRAM_WEB_TOKEN");
    expect(viz).toContain("http://127.0.0.1:3001/graph");
    // summary table + next steps, no LLM warning (smoke ok)
    expect(h.lines).toContain("Setup summary:");
    expect(h.lines.some((l) => /^\s+5\. daemons\s+ok\s+mcp: installed, dream: installed, visualizer: installed$/.test(l))).toBe(true);
    expect(h.lines).toContain("Next steps:");
    expect(h.lines.some((l) => l.includes("restart claude"))).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(h.lines.some((l) => l.startsWith("[warn]"))).toBe(false);
    expect(r.smoke?.status).toBe("ok");
    expect(h.lines).toContainEqual(expect.stringMatching(/^\s+\[ok\]\s+extraction smoke: tier=ollama memories=1/));
  });

  it("--no-daemons installs nothing; --daemons=mcp installs only the MCP daemon", async () => {
    const a = harness();
    const ra = await run(a, { yes: true, daemons: null });
    expect(a.installed).toEqual([]);
    expect(step(ra, "daemons")).toMatchObject({ status: "skipped" });
    expect(step(ra, "daemons").summary).toContain("--no-daemons");
    expect(ra.nextSteps.some((n) => n.includes("install-mcp-daemon.sh install"))).toBe(true);

    const b = harness();
    const rb = await run(b, { yes: true, daemons: ["mcp"] });
    expect(b.installed).toEqual(["mcp"]);
    expect(rb.daemons.map((d) => d.id)).toEqual(["mcp"]);
    expect(parseDaemonList("dream, MCP")).toEqual(["dream", "mcp"]);
    expect(() => parseDaemonList("mcp,web")).toThrow(/unknown service "web"/);
    expect(ALL_DAEMONS).toEqual(["mcp", "dream", "visualizer"]);
  });

  it("leaves a daemon that is already installed and running alone", async () => {
    const h = harness({ running: ["mcp"] });
    const r = await run(h, { yes: true });
    expect(h.installed).toEqual(["dream", "visualizer"]);
    expect(r.daemons[0]).toMatchObject({ id: "mcp", action: "already running" });
    expect(h.lines.some((l) => l.includes("mcp: already installed and running (unit-mcp)"))).toBe(true);
  });

  it("reports a failed installer as warn with its last output lines and the manual command, and continues", async () => {
    const h = harness({ installService: async (id) => (id === "dream" ? { status: 1, stdout: "", stderr: "Error: plist template not found\nsecond line" } : { status: 0, stdout: "", stderr: "" }) });
    const r = await run(h, { yes: true });
    expect(r.exitCode).toBe(0);
    expect(step(r, "daemons").status).toBe("warn");
    expect(r.daemons.find((d) => d.id === "dream")).toMatchObject({ action: "failed" });
    expect(r.daemons.find((d) => d.id === "dream")!.detail).toContain("plist template not found");
    expect(r.daemons.find((d) => d.id === "visualizer")!.action).toBe("installed");
    expect(h.lines.some((l) => /dream: FAILED \(exit 1\) — run .*install-daemon\.sh install by hand/.test(l))).toBe(true);
  });
});

describe("Linux linger stays confirm-gated (#62)", () => {
  it("--yes does not imply loginctl enable-linger; the command is printed as a next step", async () => {
    const h = harness({ platform: "linux" });
    const r = await run(h, { yes: true });
    expect(h.installed).toEqual(["mcp", "dream"]); // no visualizer installer on Linux
    expect(r.daemons.find((d) => d.id === "visualizer")).toMatchObject({ action: "unavailable" });
    expect(h.lingerCalls).toBe(0);
    expect(h.lines.some((l) => l.includes("linger: not enabled") && l.includes("loginctl enable-linger dev"))).toBe(true);
    expect(r.nextSteps.some((n) => n.startsWith("loginctl enable-linger dev"))).toBe(true);
  });

  it("a terminal that answers yes enables it; one that answers no gets the command", async () => {
    const yes = harness({ platform: "linux", confirm: async (q) => /enable-linger/.test(q) });
    await run(yes, { sync: false });
    expect(yes.lingerCalls).toBe(1);
    expect(yes.lines.some((l) => l.includes("linger: enabled (loginctl enable-linger dev)"))).toBe(true);

    const no = harness({ platform: "linux", confirm: async () => false });
    const r = await run(no, { sync: false });
    expect(no.lingerCalls).toBe(0);
    expect(r.nextSteps.some((n) => n.startsWith("loginctl enable-linger dev"))).toBe(true);
  });

  it("is never asked when no daemon was installed", async () => {
    const h = harness({ platform: "linux", confirm: async () => true });
    await run(h, { sync: false, daemons: null });
    expect(h.lingerCalls).toBe(0);
    expect(h.lines.some((l) => l.includes("linger"))).toBe(false);
  });
});

describe("the LLM-unreachable warning (#62)", () => {
  it("appears only when the smoke found no tier AND the dream timer was installed — exit 0", async () => {
    const withDream = harness({ smoke: smokeNoTier() });
    const r1 = await run(withDream, { yes: true });
    expect(r1.exitCode).toBe(0);
    expect(r1.smoke?.status).toBe("no-tier");
    expect(r1.warnings).toHaveLength(1);
    expect(r1.warnings[0]).toMatch(/^dream timer installed but no LLM tier is reachable — nightly runs will not extract until a provider is configured \(OLLAMA_HOST \/ ENGRAM_LOCAL_MODEL, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ENGRAM_OPENAI_BASE_URL/);
    expect(withDream.lines.at(-1)).toMatch(/^\[warn\] dream timer installed but no LLM tier is reachable/);
    expect(r1.nextSteps.some((n) => n.startsWith("configure an LLM tier"))).toBe(true);

    const mcpOnly = harness({ smoke: smokeNoTier() });
    const r2 = await run(mcpOnly, { yes: true, daemons: ["mcp"] });
    expect(r2.warnings).toEqual([]);
    expect(mcpOnly.lines.some((l) => l.startsWith("[warn]"))).toBe(false);

    const noDaemons = harness({ smoke: smokeNoTier() });
    expect((await run(noDaemons, { yes: true, daemons: null })).warnings).toEqual([]);
  });

  it("also fires when the dream timer was already installed and running before setup", async () => {
    const h = harness({ smoke: smokeNoTier(), running: ["dream"] });
    const r = await run(h, { yes: true, daemons: ["dream"] });
    expect(h.installed).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});

describe("hosts step", () => {
  it("registers every host whose config dir exists, in HOST_IDS order; --host restricts", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const all = harness();
    await run(all, { yes: true, daemons: null, sync: false });
    expect(all.hostsInstalled).toEqual([["claude", "codex", "cursor"]]);

    const some = harness();
    await run(some, { yes: true, daemons: null, sync: false, hosts: ["cursor"] });
    expect(some.hostsInstalled).toEqual([["cursor"]]);
  });

  it("skips the step (with the command as a next step) when no host config dir exists", async () => {
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    const h = harness();
    const r = await run(h, { yes: true, daemons: null, sync: false });
    expect(h.hostsInstalled).toEqual([]);
    expect(step(r, "hosts").status).toBe("skipped");
    expect(r.nextSteps.some((n) => n.includes("engram mcp install <claude|codex|cursor|hermes>"))).toBe(true);
  });

  it("with the real installer: Claude is skipped when the plugin is installed (#60), other hosts are written", async () => {
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "engram@engram": [{ version: "0.3.0", scope: "user" }] } }));
    mkdirSync(join(home, ".codex"), { recursive: true });
    const h = harness({ installHosts: undefined });
    // undefined → defaultSetupDeps wires the real runMcpInstall over the temp HostContext
    h.deps.installHosts = (ids) => import("../../../src/interfaces/cli/hosts.js").then((m) => m.runMcpInstall({ hosts: ids, scope: "user" }, { ctx: h.deps.hosts, probe: healthy, exec: h.deps.services.exec }));
    const r = await run(h, { yes: true, daemons: null, sync: false });
    expect(r.hosts.map((x) => [x.host, x.action])).toEqual([["claude", "skipped"], ["codex", "written"]]);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.engram]");
    expect(step(r, "hosts").summary).toBe("claude: skipped (http), codex: written (http)");
  });

  it("offers the Hermes plugin deploy when profiles carry it: --yes deploys, a script without --yes gets the command", async () => {
    mkdirSync(join(home, ".hermes", "profiles", "work", "plugins", "engram"), { recursive: true });
    const script = harness();
    await run(script, { daemons: null, sync: false });
    expect(script.hostsInstalled).toEqual([["claude"]]);
    expect(script.lines.some((l) => l.includes("hermes: skipped (not a terminal) — engram mcp install hermes"))).toBe(true);

    const yes = harness();
    await run(yes, { yes: true, daemons: null, sync: false });
    expect(yes.hostsInstalled).toEqual([["claude", "hermes"]]);

    const asked: string[] = [];
    const tty = harness({ confirm: async (q) => { asked.push(q); return false; } });
    await run(tty, { daemons: null, sync: false });
    expect(asked.some((q) => q.includes("Deploy the Hermes plugin to profiles work?"))).toBe(true);
    expect(tty.hostsInstalled).toEqual([["claude"]]);
  });
});

describe("sync step", () => {
  it("--sync runs it, --no-sync skips it, a script without --yes skips it and says how, a terminal is asked", async () => {
    const forced = harness();
    await run(forced, { sync: true, daemons: null });
    expect(forced.syncCalls).toBe(1);

    const off = harness();
    const r = await run(off, { yes: true, sync: false, daemons: null });
    expect(off.syncCalls).toBe(0);
    expect(step(r, "sync")).toMatchObject({ status: "skipped", summary: "--no-sync" });

    const script = harness();
    const rs = await run(script, { daemons: null });
    expect(script.syncCalls).toBe(0);
    expect(step(rs, "sync").summary).toContain("not a terminal");
    expect(script.lines.some((l) => l.includes("pass --sync or --yes"))).toBe(true);

    const asked: string[] = [];
    const tty = harness({ confirm: async (q) => { asked.push(q); return q.startsWith("Index conversations"); } });
    await run(tty, { daemons: null });
    expect(asked[0]).toMatch(/^Index conversations from .*projects now\? \[Y\/n\] $/);
    expect(tty.syncCalls).toBe(1);
  });

  it("skips when ~/.claude/projects does not exist", async () => {
    rmSync(join(root, "projects"), { recursive: true, force: true });
    const h = harness();
    const r = await run(h, { yes: true, daemons: null });
    expect(h.syncCalls).toBe(0);
    expect(step(r, "sync").summary).toContain("does not exist");
  });
});

describe("doctor gates and exit codes", () => {
  it("a required [FAIL] aborts after step 1 with exit 1; nothing else runs", async () => {
    const h = harness({ doctor: report({ checks: [check("node", "fail", true), check("sqlite-vec", "ok", true)] }) });
    const r = await run(h, { yes: true });
    expect(r.exitCode).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ n: 1, name: "doctor", status: "fail" });
    expect(r.steps[0].summary).toContain("node");
    expect(h.initCalls).toBe(0);
    expect(h.installed).toEqual([]);
    expect(h.lines.some((l) => l.startsWith("[warn] required check(s) failed: node"))).toBe(true);
    expect(r.nextSteps[0]).toContain("engram preflight");
  });

  it("warnings (an unreachable Ollama, no host) never abort: exit 0", async () => {
    const h = harness({ doctor: report({ checks: [check("node", "ok", true), check("ollama", "warn"), check("hosts", "warn")] }) });
    const r = await run(h, { yes: true, daemons: null, sync: false });
    expect(r.exitCode).toBe(0);
    expect(step(r, "doctor").status).toBe("warn");
  });

  it("a failed init is exit 1 (no database, no model), sync is skipped, the rest still reports", async () => {
    const h = harness();
    h.deps.init = async () => { throw new Error("model download failed: ENOTFOUND huggingface.co"); };
    const r = await run(h, { yes: true, daemons: null });
    expect(r.exitCode).toBe(1);
    expect(step(r, "init")).toMatchObject({ status: "fail" });
    expect(step(r, "sync")).toMatchObject({ status: "skipped", summary: "init failed" });
    expect(step(r, "hosts").status).toBe("ok");
    expect(h.lines.at(-1)).toMatch(/^\[warn\] init failed: model download failed/);
  });

  it("step 6 applies the doctor fixes with the same --yes semantics and reports the tally", async () => {
    const applied: string[] = [];
    const fixable = (name: DoctorCheck["name"], needsConfirm = false): DoctorCheck => ({ ...check(name, "warn"), fix: { describe: `fix ${name}`, needsConfirm, apply: async () => { applied.push(name); return check(name, "ok"); } } });
    const h = harness({ doctor: report({ checks: [check("node", "ok", true), fixable("env file"), fixable("ollama", true)] }) });
    const r = await run(h, { daemons: null, sync: false });
    expect(applied).toEqual(["env file"]); // step 1 only reports; step 6 applies (once)
    expect(r.fixes.map((f) => [f.name, f.status])).toEqual([["env file", "fixed"], ["ollama", "skipped"]]);
    expect(step(r, "doctor --fix").summary).toBe("1 fixed, 1 skipped");
    expect(h.lines.some((l) => l.trim() === "manual: fix ollama")).toBe(true);

    applied.length = 0;
    const y = harness({ doctor: report({ checks: [check("node", "ok", true), fixable("env file"), fixable("ollama", true)] }) });
    const ry = await run(y, { yes: true, daemons: null, sync: false });
    expect(ry.fixes.map((f) => f.status)).toEqual(["fixed", "fixed"]);
  });

  it("--no-smoke skips step 7 and suppresses the LLM warning", async () => {
    const h = harness({ smoke: smokeNoTier() });
    const r = await run(h, { yes: true, noSmoke: true });
    expect(step(r, "extraction smoke")).toMatchObject({ status: "skipped", summary: "skipped (--no-smoke)" });
    expect(r.warnings).toEqual([]);
  });
});

describe("--json and platforms", () => {
  it("the result serialises with steps, daemons, hosts, fixes, smoke and the final doctor report", async () => {
    const h = harness();
    const r = await run(h, { yes: true, json: true });
    const j = JSON.parse(JSON.stringify(r)) as typeof r;
    expect(j.ok).toBe(true);
    expect(j.steps.map((s) => s.name)).toEqual(["doctor", "init", "sync", "hosts", "daemons", "doctor --fix", "extraction smoke"]);
    expect(j.daemons.map((d) => d.action)).toEqual(["installed", "installed", "installed"]);
    expect(j.hosts[0].host).toBe("claude");
    expect(j.smoke?.provider).toBe("ollama");
    expect(j.doctor?.checks.length).toBeGreaterThan(0);
    expect(Array.isArray(j.fixes)).toBe(true);
  });

  it("Windows: the installers are the .ps1 twins through PowerShell (never executed here — a fake exec records them)", async () => {
    const h = harness({ platform: "win32", installService: undefined });
    const calls: Call[] = [];
    h.deps.services = { ...h.deps.services, exec: async (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: "", stderr: "" }; } };
    h.deps.installService = (id) => import("../../../src/interfaces/cli/services.js").then((m) => m.installService(id, h.deps.services));
    const r = await run(h, { yes: true, sync: false });
    expect(r.daemons.map((d) => d.action)).toEqual(["installed", "installed", "installed"]);
    const ps = calls.filter((c) => c.cmd === "powershell.exe");
    expect(ps.map((c) => c.args)).toEqual([
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(pkg, "scripts", "install-mcp-daemon.ps1"), "install"],
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(pkg, "scripts", "install-daemon.ps1"), "install"],
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(pkg, "scripts", "install-visualizer.ps1"), "install"],
    ]);
    expect(installCommand("dream", h.deps.services)!.display).toContain("install-daemon.ps1 install");
  });

  it("installCommand: bash + the shipped script on macOS/Linux, none for the visualizer on Linux", () => {
    const base: ServiceDeps = { platform: "darwin", exec: async () => ({ status: 0, stdout: "", stderr: "" }), probe: async () => false, home, engramDir: pkg, env: {} };
    expect(installCommand("mcp", base)).toEqual({ cmd: "bash", args: [join(pkg, "scripts", "install-mcp-daemon.sh"), "install"], display: `${join(pkg, "scripts", "install-mcp-daemon.sh")} install` });
    expect(installCommand("visualizer", { ...base, platform: "linux" })).toBeNull();
    expect(installCommand("dream", { ...base, platform: "linux" })!.args[0]).toContain("install-daemon.sh");
  });
});
