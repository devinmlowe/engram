/**
 * Supervisor adapters for the engram services (`engram update`, #44).
 *
 * One adapter per platform, all behind the same `ServiceStatus` shape:
 *   - macOS   → launchd LaunchAgents (`com.engram.mcp`, `com.engram.dreamstate`,
 *               `com.engram.visualizer`, plus the hand-written 0.1.x label
 *               `ai.hermes.engram-mcp`)
 *   - Linux   → systemd user units (`engram-mcp.service`, `engram-dream.timer`)
 *   - Windows → Task Scheduler tasks under `\Engram\` driven through the
 *               shipped `scripts/install-*.ps1` installers
 *
 * Every shell call goes through an injected `exec`, and every port probe
 * through an injected `probe`, so tests exercise each platform without a
 * supervisor. Nothing here ever kills an arbitrary process: a daemon that
 * answers on its port without a supervisor is reported as `unsupervised` and
 * the caller decides.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { DEFAULT_MCP_PORT, parseMcpPort } from "../mcp/port.js";

export type ServicePlatform = "darwin" | "linux" | "win32";
export type Supervisor = "launchd" | "systemd" | "task-scheduler";
export type ServiceId = "mcp" | "dream" | "visualizer";

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}
export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this many ms (exit status 124, like coreutils `timeout`). Unbounded by default. */
  timeoutMs?: number;
}
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;
/** True when `GET http://127.0.0.1:port<path>` answers 200. */
export type Probe = (port: number, path: string) => Promise<boolean>;

export interface ServiceDeps {
  platform: ServicePlatform;
  exec: Exec;
  probe: Probe;
  /** Home directory (LaunchAgents live under it). */
  home: string;
  /** The engram checkout: where `scripts/install-*.ps1` live for Windows. */
  engramDir: string;
  env: NodeJS.ProcessEnv;
  /** launchd domain uid for `launchctl kickstart gui/<uid>/<label>`. */
  uid?: number;
}

export interface ServiceStatus {
  id: ServiceId;
  supervisor: Supervisor;
  /** launchd label, systemd unit, or Task Scheduler task path. */
  unit: string;
  installed: boolean;
  running: boolean;
  /** For daemons with a port: is something answering there? `null` = no port. */
  listening: boolean | null;
  /** Answers on its port but no supervisor owns it (a hand-started process). */
  unsupervised: boolean;
  /** Human-readable commands the plan prints and `engram update` runs. */
  stopCommand: string;
  startCommand: string;
  restartCommand: string;
  /** Hint when installed is false. */
  installHint: string;
}

export const DEFAULT_VISUALIZER_PORT = 3001;

const LAUNCHD_LABELS: Record<ServiceId, string> = {
  mcp: "com.engram.mcp",
  dream: "com.engram.dreamstate",
  visualizer: "com.engram.visualizer",
};
export const LEGACY_MCP_LABEL = "ai.hermes.engram-mcp";
const SYSTEMD_UNITS: Record<ServiceId, string> = {
  mcp: "engram-mcp.service",
  dream: "engram-dream.timer",
  visualizer: "engram-visualizer.service", // not shipped; honoured if the user made one
};
const TASKS: Record<ServiceId, { task: string; installer: string }> = {
  mcp: { task: "\\Engram\\MCP", installer: "install-mcp-daemon.ps1" },
  dream: { task: "\\Engram\\Dream", installer: "install-daemon.ps1" },
  visualizer: { task: "\\Engram\\Visualizer", installer: "install-visualizer.ps1" },
};
const SH_INSTALLER: Record<ServiceId, string> = {
  mcp: "install-mcp-daemon.sh",
  dream: "install-daemon.sh",
  visualizer: "install-visualizer.sh",
};

/** The order writers must stop in (dream is the heaviest writer) and daemons start in (MCP before anything that talks to it). */
export const STOP_ORDER: ServiceId[] = ["dream", "mcp", "visualizer"];
export const START_ORDER: ServiceId[] = ["mcp", "visualizer"];

export function portFor(id: ServiceId, env: NodeJS.ProcessEnv): { port: number; path: string } | null {
  if (id === "mcp") return { port: parseMcpPort(env.ENGRAM_MCP_PORT, DEFAULT_MCP_PORT), path: "/health" };
  if (id === "visualizer") {
    const p = Number.parseInt(env.PORT ?? "", 10);
    return { port: Number.isInteger(p) && p > 0 ? p : DEFAULT_VISUALIZER_PORT, path: "/api/health" };
  }
  return null;
}

// ─── default deps (real shell + real HTTP) ───────────────────────────

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs }, (err, stdout, stderr) => {
      const killed = Boolean(err && (err as { killed?: boolean }).killed);
      const status = killed ? 124 : err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ status, stdout: String(stdout ?? ""), stderr: killed ? `timed out after ${opts.timeoutMs} ms` : String(stderr ?? "") });
    });
  });

export const realProbe: Probe = (port, path) =>
  new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });

export function defaultServiceDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  const platform = (overrides.platform ?? process.platform) as ServicePlatform;
  return {
    platform: platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "linux",
    exec: realExec,
    probe: realProbe,
    home: overrides.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "",
    engramDir: overrides.engramDir ?? process.cwd(),
    env: overrides.env ?? process.env,
    uid: overrides.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined),
    ...overrides,
  };
}

// ─── launchd ─────────────────────────────────────────────────────────

function launchAgentPath(home: string, label: string): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

async function launchdRunning(exec: Exec, label: string): Promise<{ loaded: boolean; pid: number | null }> {
  const r = await exec("launchctl", ["list", label]);
  if (r.status !== 0) return { loaded: false, pid: null };
  const m = r.stdout.match(/"PID"\s*=\s*(\d+)/);
  return { loaded: true, pid: m ? Number(m[1]) : null };
}

async function launchdStatus(id: ServiceId, deps: ServiceDeps): Promise<ServiceStatus> {
  let label = LAUNCHD_LABELS[id];
  let plist = launchAgentPath(deps.home, label);
  let installed = existsSync(plist);
  let state = await launchdRunning(deps.exec, label);
  if (id === "mcp" && !installed && !state.loaded) {
    // The 0.1.x docs had people hand-write this one for the same port.
    const legacyPlist = launchAgentPath(deps.home, LEGACY_MCP_LABEL);
    const legacyState = await launchdRunning(deps.exec, LEGACY_MCP_LABEL);
    if (existsSync(legacyPlist) || legacyState.loaded) {
      label = LEGACY_MCP_LABEL;
      plist = legacyPlist;
      installed = existsSync(legacyPlist);
      state = legacyState;
    }
  }
  const port = portFor(id, deps.env);
  const listening = port ? await deps.probe(port.port, port.path) : null;
  const running = state.loaded && (state.pid !== null || id === "dream");
  const sh = join(deps.engramDir, "scripts", SH_INSTALLER[id]);
  const uid = deps.uid ?? 501;
  return {
    id, supervisor: "launchd", unit: label, installed, running, listening,
    unsupervised: !running && listening === true,
    stopCommand: installed ? `launchctl unload ${plist}` : `launchctl remove ${label}`,
    startCommand: `launchctl load ${plist}`,
    restartCommand: `launchctl kickstart -k gui/${uid}/${label}`,
    installHint: `${sh} install`,
  };
}

// ─── systemd (user units) ────────────────────────────────────────────

function systemdUserDir(deps: ServiceDeps): string {
  const xdg = deps.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(deps.home, ".config"), "systemd", "user");
}

async function systemdStatus(id: ServiceId, deps: ServiceDeps): Promise<ServiceStatus> {
  const unit = SYSTEMD_UNITS[id];
  const installed = existsSync(join(systemdUserDir(deps), unit));
  const r = await deps.exec("systemctl", ["--user", "is-active", unit]);
  const running = r.stdout.trim() === "active" || r.stdout.trim() === "activating";
  const port = portFor(id, deps.env);
  const listening = port ? await deps.probe(port.port, port.path) : null;
  const sh = join(deps.engramDir, "scripts", SH_INSTALLER[id]);
  return {
    id, supervisor: "systemd", unit, installed, running, listening,
    unsupervised: !running && listening === true,
    stopCommand: `systemctl --user stop ${unit}`,
    startCommand: `systemctl --user start ${unit}`,
    restartCommand: `systemctl --user restart ${unit}`,
    installHint: id === "visualizer" ? "run node dist/interfaces/web/server.js under your own supervisor" : `${sh} install`,
  };
}

// ─── Windows Task Scheduler ──────────────────────────────────────────

function ps1(deps: ServiceDeps, id: ServiceId, verb: string): [string, string[]] {
  const script = join(deps.engramDir, "scripts", TASKS[id].installer);
  return ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, verb]];
}

async function taskStatus(id: ServiceId, deps: ServiceDeps): Promise<ServiceStatus> {
  const { task } = TASKS[id];
  const r = await deps.exec("schtasks.exe", ["/Query", "/TN", task, "/FO", "CSV", "/NH"]);
  const installed = r.status === 0;
  // CSV: "TaskName","Next Run Time","Status"
  const status = installed ? (r.stdout.trim().split(",").at(-1) ?? "").replace(/"/g, "").trim() : "";
  const running = /^running$/i.test(status);
  const port = portFor(id, deps.env);
  const listening = port ? await deps.probe(port.port, port.path) : null;
  const [exe, base] = ps1(deps, id, "status");
  const cmd = (verb: string) => `${exe} ${base.slice(0, -1).join(" ")} ${verb}`;
  return {
    id, supervisor: "task-scheduler", unit: task, installed, running, listening,
    unsupervised: !running && listening === true,
    stopCommand: id === "dream" ? `schtasks.exe /End /TN ${task}` : cmd("stop"),
    startCommand: id === "dream" ? `schtasks.exe /Run /TN ${task}` : cmd("start"),
    restartCommand: id === "dream" ? `schtasks.exe /End /TN ${task}` : cmd("restart"),
    installHint: cmd("install"),
  };
}

// ─── public API ──────────────────────────────────────────────────────

export async function serviceStatus(id: ServiceId, deps: ServiceDeps): Promise<ServiceStatus> {
  if (deps.platform === "darwin") return launchdStatus(id, deps);
  if (deps.platform === "win32") return taskStatus(id, deps);
  return systemdStatus(id, deps);
}

export async function listServices(deps: ServiceDeps): Promise<ServiceStatus[]> {
  const out: ServiceStatus[] = [];
  for (const id of ["mcp", "dream", "visualizer"] as ServiceId[]) out.push(await serviceStatus(id, deps));
  return out;
}

function fail(action: string, svc: ServiceStatus, r: ExecResult): never {
  throw new Error(`${action} ${svc.unit} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
}

export async function stopService(svc: ServiceStatus, deps: ServiceDeps): Promise<void> {
  if (!svc.running && !svc.installed) return;
  if (deps.platform === "darwin") {
    const plist = launchAgentPath(deps.home, svc.unit);
    const r = existsSync(plist)
      ? await deps.exec("launchctl", ["unload", plist])
      : await deps.exec("launchctl", ["remove", svc.unit]);
    if (r.status !== 0 && svc.running) fail("stop", svc, r);
    return;
  }
  if (deps.platform === "win32") {
    if (svc.id === "dream") {
      if (svc.running) await deps.exec("schtasks.exe", ["/End", "/TN", svc.unit]);
      return;
    }
    const [exe, args] = ps1(deps, svc.id, "stop");
    const r = await deps.exec(exe, args);
    if (r.status !== 0) fail("stop", svc, r);
    return;
  }
  const r = await deps.exec("systemctl", ["--user", "stop", svc.unit]);
  if (r.status !== 0 && svc.running) fail("stop", svc, r);
}

export async function startService(svc: ServiceStatus, deps: ServiceDeps): Promise<void> {
  if (!svc.installed) return;
  if (deps.platform === "darwin") {
    const r = await deps.exec("launchctl", ["load", launchAgentPath(deps.home, svc.unit)]);
    if (r.status !== 0) fail("start", svc, r);
    return;
  }
  if (deps.platform === "win32") {
    if (svc.id === "dream") return; // scheduled; nothing to start
    const [exe, args] = ps1(deps, svc.id, "start");
    const r = await deps.exec(exe, args);
    if (r.status !== 0) fail("start", svc, r);
    return;
  }
  const r = await deps.exec("systemctl", ["--user", "start", svc.unit]);
  if (r.status !== 0) fail("start", svc, r);
}

/** Wait until the service's port answers (or, with `up=false`, stops answering). */
export async function waitForPort(svc: ServiceStatus, deps: ServiceDeps, up: boolean, timeoutMs = 30_000, stepMs = 500): Promise<boolean> {
  const port = portFor(svc.id, deps.env);
  if (!port) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const answering = await deps.probe(port.port, port.path);
    if (answering === up) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
