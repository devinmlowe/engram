/**
 * `engram setup` (#61, decision #62): from a bare install to running, in one
 * command — orchestration only. Every step is an existing command's body:
 *
 *   1. doctor            runDoctor (no smoke yet); aborts only on a required [FAIL]
 *   2. init              runInit — database + model download, idempotent
 *   3. sync              runSync — asked on a terminal, --yes/--sync/--no-sync decide otherwise
 *   4. hosts             runMcpInstall for every host whose config dir exists
 *                        (--host restricts; Claude is skipped by hosts.ts when the plugin is installed, #60;
 *                        the Hermes plugin deploy is offered when profiles exist)
 *   5. daemons           the shipped installers through services.ts — ALL THREE by default (#62),
 *                        --no-daemons / --daemons=<ids> override, --yes keeps the default;
 *                        Linux `loginctl enable-linger` stays confirm-gated (--yes does not imply it)
 *   6. doctor --fix      applyDoctorFixes with the same --yes semantics
 *   7. extraction smoke  checkSmoke (unless --no-smoke)
 *   8. summary           one line per step, next steps, and the loud warning when the dream
 *                        timer is installed but no LLM tier answered
 *
 * Every step prints what it did and the manual equivalent. Exit 1 only when a
 * required doctor check failed or `init` itself failed (no database / model);
 * everything else — an unreachable LLM tier included — is a warning and exit 0.
 * All collaborators are injected (`SetupDeps`) so tests run against a temp home
 * with a fake shell; `defaultSetupDeps()` is the real machine.
 */
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { loadConfig } from "../../_core/config/index.js";
import type { EngramConfig } from "../../_core/types/index.js";
import { PACKAGE_ROOT } from "../../_core/version/index.js";
import type { SyncResult } from "../../episodic/sync.js";
import {
  applyDoctorFixes, checkSmoke, defaultDoctorContext, formatDoctorReport, formatFixResults, runDoctor,
  type DoctorContext, type DoctorReport, type FixOutcome,
} from "./doctor.js";
import { runInit, runSync, type InitSummary } from "./first-run.js";
import {
  HOST_IDS, defaultHostContext, formatInstallResults, hostPresent, runMcpInstall,
  type HealthProbe, type HostContext, type HostId, type InstallResult,
} from "./hosts.js";
import {
  DEFAULT_VISUALIZER_PORT, defaultServiceDeps, installCommand, installService, portFor, serviceStatus,
  type ExecResult, type ServiceDeps, type ServiceId, type ServiceStatus,
} from "./services.js";
import { serviceEnvFile } from "./data-migration.js";
import { LLM_PROVIDER_HINT, type SmokeOutcome } from "./smoke.js";
import { pluginDeployTargets } from "./update.js";

export const ALL_DAEMONS: ServiceId[] = ["mcp", "dream", "visualizer"];

export interface SetupOptions {
  /** `--yes`: every yes/no question answered yes — except Linux linger (#62). */
  yes?: boolean;
  /** `--sync` (true) / `--no-sync` (false); undefined asks on a terminal, else skips. */
  sync?: boolean;
  /** `--daemons=<ids>`; null = `--no-daemons`; undefined = all three (#62). */
  daemons?: ServiceId[] | null;
  /** `--host <id>...`: only these hosts (default: every host present). */
  hosts?: HostId[];
  noSmoke?: boolean;
  json?: boolean;
}

/** Everything the steps touch, so tests inject a temp home and fakes. */
export interface SetupDeps {
  config: EngramConfig;
  services: ServiceDeps;
  hosts: HostContext;
  /** Overrides for the doctor context (probes, smoke seams). */
  doctor: Partial<DoctorContext>;
  hermesHome: string;
  /** Account name for `loginctl enable-linger`. */
  user: string;
  log: (line: string) => void;
  /** Ask a yes/no question on a terminal; absent when stdin is not a TTY. */
  confirm?: (question: string) => Promise<boolean>;
  /** `/health` probe `mcp install` uses for the transport decision (default: real). */
  hostProbe?: HealthProbe;
  // The command bodies, injectable so tests never download a model or index ~/.claude.
  init: (config: EngramConfig, log: (l: string) => void) => Promise<InitSummary>;
  sync: (config: EngramConfig, log: (l: string) => void) => Promise<SyncResult>;
  installHosts: (hosts: HostId[]) => Promise<InstallResult[]>;
  serviceStatus: (id: ServiceId) => Promise<ServiceStatus>;
  installService: (id: ServiceId) => Promise<ExecResult>;
  enableLinger: () => Promise<ExecResult>;
}

export type StepStatus = "ok" | "warn" | "skipped" | "fail";

export interface SetupStep {
  n: number;
  name: string;
  status: StepStatus;
  /** One line for the summary table. */
  summary: string;
  /** The command a user would run by hand. */
  manual: string;
}

export interface DaemonOutcome {
  id: ServiceId;
  action: "installed" | "already running" | "skipped" | "unavailable" | "failed";
  detail: string;
  manual: string;
}

export interface SetupResult {
  ok: boolean;
  exitCode: 0 | 1;
  steps: SetupStep[];
  warnings: string[];
  nextSteps: string[];
  doctor: DoctorReport | null;
  fixes: FixOutcome[];
  smoke: SmokeOutcome | null;
  hosts: InstallResult[];
  daemons: DaemonOutcome[];
}

export function defaultSetupDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  const config = overrides.config ?? loadConfig();
  const home = homedir();
  const env = process.env;
  const services = overrides.services ?? defaultServiceDeps({ engramDir: PACKAGE_ROOT, home });
  const hosts = overrides.hosts ?? defaultHostContext();
  const user = overrides.user ?? env.USER ?? (() => { try { return userInfo().username; } catch { return ""; } })();
  return {
    config,
    services,
    hosts,
    doctor: overrides.doctor ?? { services, hosts },
    hermesHome: overrides.hermesHome ?? hosts.hermesHome,
    user,
    log: overrides.log ?? ((l) => console.log(l)),
    confirm: overrides.confirm,
    hostProbe: overrides.hostProbe,
    init: overrides.init ?? runInit,
    sync: overrides.sync ?? ((cfg, log) => runSync(cfg, {}, log)),
    installHosts: overrides.installHosts ?? ((ids) => runMcpInstall({ hosts: ids, scope: "user" }, { ctx: hosts, probe: overrides.hostProbe, exec: services.exec })),
    serviceStatus: overrides.serviceStatus ?? ((id) => serviceStatus(id, services)),
    installService: overrides.installService ?? ((id) => installService(id, services)),
    enableLinger: overrides.enableLinger ?? (() => services.exec("loginctl", ["enable-linger", user])),
    ...overrides,
  };
}

/** `--daemons=mcp,dream` → ids; throws on an unknown name. */
export function parseDaemonList(raw: string): ServiceId[] {
  const ids = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: ServiceId[] = [];
  for (const id of ids) {
    if (!(ALL_DAEMONS as string[]).includes(id)) throw new Error(`--daemons: unknown service "${id}" (expected ${ALL_DAEMONS.join(", ")})`);
    if (!out.includes(id as ServiceId)) out.push(id as ServiceId);
  }
  if (out.length === 0) throw new Error(`--daemons: expected a comma-separated list of ${ALL_DAEMONS.join(", ")} (or --no-daemons)`);
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tail(text: string, n: number): string[] {
  return text.trim().split("\n").filter(Boolean).slice(-n);
}

export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<SetupResult> {
  const { config, log } = deps;
  const steps: SetupStep[] = [];
  const warnings: string[] = [];
  const nextSteps: string[] = [];
  const ask = async (question: string, fallback: boolean): Promise<boolean> => {
    if (opts.yes) return true;
    if (deps.confirm) return deps.confirm(question);
    return fallback;
  };
  const header = (n: number, name: string, manual: string) => {
    log("");
    log(`── ${n}. ${name}   (manual: ${manual})`);
  };
  const step = (n: number, name: string, status: StepStatus, summary: string, manual: string) => {
    steps.push({ n, name, status, summary, manual });
    log(`   → ${status}: ${summary}`);
  };
  const dctx = defaultDoctorContext({ ...deps.doctor, services: deps.doctor.services ?? deps.services, hosts: deps.doctor.hosts ?? deps.hosts, hostProbe: deps.doctor.hostProbe ?? deps.hostProbe });
  // Declared up front: `finish` reads them on the early abort path too.
  let init: InitSummary | null = null;
  let hostResults: InstallResult[] = [];
  const daemons: DaemonOutcome[] = [];
  let dreamInstalled = false;
  let fixes: FixOutcome[] = [];
  let smoke: SmokeOutcome | null = null;

  // 1. doctor ────────────────────────────────────────────────────────
  header(1, "doctor", "engram doctor");
  let report = await runDoctor(config, { noSmoke: true, ctx: dctx });
  for (const l of formatDoctorReport(report)) log(`   ${l}`);
  const okCount = report.checks.filter((c) => c.level === "ok").length;
  if (!report.ok) {
    const failed = report.checks.filter((c) => c.required && c.level === "fail").map((c) => c.name);
    step(1, "doctor", "fail", `required check(s) failed: ${failed.join(", ")} — fix these first (engram preflight names the toolchain per OS)`, "engram doctor");
    return finish(1);
  }
  step(1, "doctor", okCount === report.checks.length - 1 ? "ok" : "warn", `${okCount}/${report.checks.length - 1} checks ok (smoke runs at step 7)`, "engram doctor");

  // 2. init ──────────────────────────────────────────────────────────
  header(2, "init", "engram init");
  try {
    init = await deps.init(config, (l) => log(`   ${l}`));
    step(2, "init", "ok", `database ${init.created ? "created" : "already present"} at ${init.dbPath}; model ${init.model} cached at ${init.modelCacheDir}`, "engram init");
  } catch (err) {
    step(2, "init", "fail", `init failed: ${errMsg(err)}`, "engram init");
  }

  // 3. sync ──────────────────────────────────────────────────────────
  header(3, "sync", "engram sync");
  if (!init) {
    step(3, "sync", "skipped", "init failed", "engram sync");
  } else if (opts.sync === false) {
    step(3, "sync", "skipped", "--no-sync", "engram sync");
  } else if (!existsSync(config.claudeProjectsDir)) {
    step(3, "sync", "skipped", `${config.claudeProjectsDir} does not exist (no Claude Code conversations to index here)`, "engram sync");
  } else {
    let go = opts.sync === true;
    if (!go) {
      go = await ask(`Index conversations from ${config.claudeProjectsDir} now? [Y/n] `, false);
      if (!go && !deps.confirm && !opts.yes) log("   not a terminal: skipping (pass --sync or --yes to index)");
    }
    if (!go) {
      step(3, "sync", "skipped", opts.sync === undefined && !deps.confirm && !opts.yes ? "not a terminal (pass --sync or --yes)" : "declined", "engram sync");
    } else {
      try {
        const r = await deps.sync(config, (l) => log(`   ${l}`));
        step(3, "sync", r.errors.length ? "warn" : "ok", `${r.indexed} indexed, ${r.skipped} skipped of ${r.discovered} discovered${r.errors.length ? `, ${r.errors.length} errors` : ""}`, "engram sync");
      } catch (err) {
        step(3, "sync", "warn", `sync failed: ${errMsg(err)}`, "engram sync");
      }
    }
  }

  // 4. hosts ─────────────────────────────────────────────────────────
  const present = HOST_IDS.filter((id) => hostPresent(id, deps.hosts));
  let targets: HostId[] = opts.hosts ?? present;
  header(4, "hosts", `engram mcp install ${targets.length ? targets.join(" ") : "<claude|codex|cursor|hermes>"}`);
  if (targets.length === 0) {
    step(4, "hosts", "skipped", "no host config dir found (~/.claude, ~/.codex, ~/.cursor, ~/.hermes) — register one later", "engram mcp install <host>");
  } else {
    // The Hermes deploy copies the plugin into every profile that has it: offered, not silent.
    if (targets.includes("hermes") && !opts.hosts) {
      const { profiles, targets: deployTargets } = pluginDeployTargets(deps.hermesHome);
      if (deployTargets.length > 0) {
        const go = await ask(`Deploy the Hermes plugin to ${profiles.length ? `profiles ${profiles.join(", ")}` : deps.hermesHome}? [Y/n] `, false);
        if (!go) {
          log(`   hermes: skipped (${deps.confirm || opts.yes ? "declined" : "not a terminal"}) — engram mcp install hermes`);
          targets = targets.filter((h) => h !== "hermes");
        }
      }
    }
    try {
      hostResults = targets.length ? await deps.installHosts(targets) : [];
      for (const l of formatInstallResults(hostResults)) log(`   ${l}`);
      const summary = hostResults.map((r) => `${r.host}: ${r.action}${r.transport ? ` (${r.transport})` : ""}`).join(", ");
      const errors = hostResults.filter((r) => r.action === "error").length;
      step(4, "hosts", errors ? "warn" : targets.length ? "ok" : "skipped", summary || "nothing to register", `engram mcp install ${targets.join(" ") || "<host>"}`);
      for (const r of hostResults) {
        const restart = r.notes.find((n) => /^restart /.test(n));
        if (restart && (r.action === "written" || r.action === "deployed")) nextSteps.push(restart);
      }
    } catch (err) {
      step(4, "hosts", "warn", `mcp install failed: ${errMsg(err)}`, `engram mcp install ${targets.join(" ")}`);
    }
  }

  // 5. daemons ───────────────────────────────────────────────────────
  const daemonIds = opts.daemons === null ? [] : (opts.daemons ?? ALL_DAEMONS);
  header(5, "daemons", daemonIds.length ? daemonIds.map((id) => installCommand(id, deps.services)?.display ?? `(${id}: no installer on ${deps.services.platform})`).join("; ") : "scripts/install-mcp-daemon.sh install; scripts/install-daemon.sh install; scripts/install-visualizer.sh install");
  if (daemonIds.length === 0) {
    step(5, "daemons", "skipped", "--no-daemons (install later with the scripts above, or re-run setup)", "scripts/install-*.sh install");
  } else {
    let installedAny = false;
    for (const id of ALL_DAEMONS.filter((d) => daemonIds.includes(d))) {
      // Order: MCP first (the others talk to it), then the dream timer, then the visualizer.
      const cmd = installCommand(id, deps.services);
      let status: ServiceStatus | null = null;
      try { status = await deps.serviceStatus(id); } catch (err) { log(`   ${id}: could not read supervisor state: ${errMsg(err)}`); }
      const manual = cmd?.display ?? status?.installHint ?? `scripts/install-${id}.sh install`;
      if (status?.installed && status.running) {
        daemons.push({ id, action: "already running", detail: `${status.unit} is installed and running — left alone`, manual });
        log(`   ${id}: already installed and running (${status.unit})`);
        if (id === "dream") dreamInstalled = true;
        continue;
      }
      if (!cmd) {
        daemons.push({ id, action: "unavailable", detail: status?.installHint ?? `no installer for ${id} on ${deps.services.platform}`, manual });
        log(`   ${id}: no installer on ${deps.services.platform} — ${status?.installHint ?? ""}`);
        continue;
      }
      log(`   ${id}: ${cmd.display}`);
      try {
        const r = await deps.installService(id);
        if (r.status !== 0) {
          daemons.push({ id, action: "failed", detail: `installer exited ${r.status}: ${tail(r.stderr || r.stdout, 3).join(" | ")}`, manual });
          for (const l of tail(r.stderr || r.stdout, 8)) log(`     ${l}`);
          log(`   ${id}: FAILED (exit ${r.status}) — run ${cmd.display} by hand to see the full output`);
          continue;
        }
        installedAny = true;
        if (id === "dream") dreamInstalled = true;
        const port = portFor(id, deps.services.env);
        let detail = `installed (${status?.unit ?? id})`;
        if (id === "visualizer") {
          detail = `visualizer installed on port ${port?.port ?? DEFAULT_VISUALIZER_PORT} — http://127.0.0.1:${port?.port ?? DEFAULT_VISUALIZER_PORT}/graph (binds 127.0.0.1 unless ENGRAM_BIND is set, which requires ENGRAM_WEB_TOKEN)`;
        } else if (id === "mcp") {
          detail = `MCP daemon installed — http://127.0.0.1:${port?.port ?? 9907}/mcp (health: /health)`;
        } else {
          detail = "dream timer installed — nightly `engram dream` (scripts/install-daemon.sh status; run-now to trigger one)";
        }
        daemons.push({ id, action: "installed", detail, manual });
        log(`   ${id}: ${detail}`);
      } catch (err) {
        daemons.push({ id, action: "failed", detail: errMsg(err), manual });
        log(`   ${id}: FAILED — ${errMsg(err)}`);
      }
    }
    // Linux user units stop with the login session: lingering keeps them
    // up, but it is a per-account policy change — always confirm-gated,
    // never implied by --yes (#62).
    if (deps.services.platform === "linux" && installedAny) {
      const cmd = `loginctl enable-linger ${deps.user}`;
      const go = deps.confirm ? await deps.confirm(`Keep the services running without a login session? (${cmd}) [y/N] `) : false;
      if (go) {
        const r = await deps.enableLinger();
        log(r.status === 0 ? `   linger: enabled (${cmd})` : `   linger: ${cmd} failed (exit ${r.status}): ${tail(r.stderr || r.stdout, 1).join("")}`);
      } else {
        log(`   linger: not enabled — the user services only run while you are logged in; to change that: ${cmd}`);
        nextSteps.push(`${cmd}   # keep the daemons running without a login session (Linux)`);
      }
    }
    const failed = daemons.filter((d) => d.action === "failed").length;
    const summary = daemons.map((d) => `${d.id}: ${d.action}`).join(", ");
    step(5, "daemons", failed ? "warn" : "ok", summary, daemonIds.map((id) => installCommand(id, deps.services)?.display ?? id).join("; "));
  }

  // 6. doctor --fix ──────────────────────────────────────────────────
  header(6, "doctor --fix", "engram doctor --fix");
  try {
    report = await runDoctor(config, { noSmoke: true, ctx: dctx });
    report = await applyDoctorFixes(report, { yes: opts.yes, confirm: deps.confirm });
    fixes = report.fixes ?? [];
    for (const l of formatFixResults(fixes)) log(`   ${l}`);
    const notOk = report.checks.filter((c) => c.level !== "ok" && c.name !== "extraction smoke").map((c) => c.name);
    step(6, "doctor --fix", fixes.some((f) => f.status === "failed") ? "warn" : "ok", fixes.length ? formatFixResults(fixes).at(-1)!.replace(/^Doctor --fix: /, "") : "nothing to fix", "engram doctor --fix");
    if (notOk.length) log(`   still not ok: ${notOk.join(", ")} (see the lines above)`);
  } catch (err) {
    step(6, "doctor --fix", "warn", `doctor --fix failed: ${errMsg(err)}`, "engram doctor --fix");
  }

  // 7. extraction smoke ──────────────────────────────────────────────
  header(7, "extraction smoke", "engram doctor   (the `extraction smoke` line)");
  try {
    const r = await checkSmoke(config, dctx.smoke, Boolean(opts.noSmoke));
    smoke = r.outcome;
    log(`   ${r.check.level === "ok" ? "[ok]  " : "[--]  "} extraction smoke: ${r.check.detail}`);
    step(7, "extraction smoke", smoke.status === "ok" ? "ok" : smoke.status === "skipped" ? "skipped" : "warn", smoke.message, "engram doctor");
  } catch (err) {
    step(7, "extraction smoke", "warn", `smoke failed: ${errMsg(err)}`, "engram doctor");
  }

  // 8. summary ───────────────────────────────────────────────────────
  return finish(init ? 0 : 1);

  function finish(exitCode: 0 | 1): SetupResult {
    log("");
    log("Setup summary:");
    for (const s of steps) log(`  ${String(s.n).padStart(2)}. ${s.name.padEnd(17)} ${s.status.padEnd(8)} ${s.summary}`);

    if (exitCode === 0) {
      if (smoke?.status === "ok") nextSteps.push('engram search "<something you discussed>"   # or recall through your MCP host');
      if (smoke?.status === "no-tier" || smoke?.status === "timeout") nextSteps.push(`configure an LLM tier (${LLM_PROVIDER_HINT}) in ${serviceEnvFile(dctx.env, dctx.home)} and re-run engram doctor`);
      if (hostResults.length === 0) nextSteps.push("engram mcp install <claude|codex|cursor|hermes>   # register a host");
      if (opts.daemons === null) nextSteps.push("scripts/install-mcp-daemon.sh install; scripts/install-daemon.sh install; scripts/install-visualizer.sh install   # or engram setup --daemons=…");
      nextSteps.push("engram doctor   # every line [ok]?");
    } else {
      nextSteps.push("engram preflight   # native modules for this node/platform/arch; then re-run engram setup");
    }
    if (nextSteps.length) {
      log("");
      log("Next steps:");
      for (const n of nextSteps) log(`  - ${n}`);
    }

    // #62: the dream timer is installed regardless — but say loudly that it will not extract.
    if (dreamInstalled && smoke && (smoke.status === "no-tier" || smoke.status === "timeout")) {
      warnings.push(`dream timer installed but no LLM tier is reachable — nightly runs will not extract until a provider is configured (${LLM_PROVIDER_HINT})`);
    }
    if (exitCode !== 0) warnings.push(steps.find((s) => s.status === "fail")?.summary ?? "setup aborted");
    for (const w of warnings) log(`[warn] ${w}`);
    return { ok: exitCode === 0, exitCode, steps, warnings, nextSteps, doctor: report, fixes, smoke, hosts: hostResults, daemons };
  }
}
