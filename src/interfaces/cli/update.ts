/**
 * `engram update` (#44): the controlled upgrade, modelled on `hermes update`.
 *
 *   --check   current vs available (git tag or npm dist-tag), nothing else
 *   --plan    read-only: install kind, versions, every directory holding an
 *             engram.db, model-cache location, every service and how it will
 *             be restarted, Hermes plugin deploy targets
 *   (run)     backup -> stop services -> pull/npm install -> build -> migrate
 *             -> restart services (MCP before the plugin redeploy) -> verify
 *             (doctor, /health, stats counts equal the pre-update snapshot)
 *
 * The process running this command is the OLD build. Everything after the
 * code swap (schema migrations, doctor, stats) therefore runs the NEW build in
 * a child process, never via a lazy import of a module that just changed.
 *
 * Before anything changes the run persists a rollback plan (#65) at
 * `<data dir>/updates/<stamp>.json` and advances its `progress` marker at
 * every step; `engram update --rollback` (rollback.ts) replays it. When a
 * step after the code swap fails, the run offers the rollback (`--yes`
 * performs it; a terminal is asked; otherwise the command is printed).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_VERSION } from "../../_core/db/schema.js";
import type { EngramConfig } from "../../_core/types/index.js";
import { compareSemver, detectInstall, latestAvailable, type AvailableVersion, type InstallInfo } from "./install-kind.js";
import {
  applyDataDirPlan, applyModelCachePlan, modelCacheSourceLabel, planDataDir, planModelCache, type DataDirPlan, type ModelCachePlan,
} from "./data-migration.js";
import { defaultInstallPathContext, installPathReport, type InstallPathContext } from "./install-path.js";
import {
  MODEL_CACHE_BACKUP_NOTE, backupDataDir, checkpointWal, manualRollbackSteps, planStamp, pruneRollbackPlans, readDbSchemaVersion,
  restartAfterFailure, rollbackUpdate, startServicesInOrder, stopServicesInOrder, verifyBuild, writeRollbackPlan,
  type RollbackPlan, type RollbackResult, type UpdateProgress,
} from "./rollback.js";
import { listServices, START_ORDER, STOP_ORDER, type ServiceDeps, type ServiceStatus } from "./services.js";
import { snapshotCounts, formatSnapshot, type CountSnapshot } from "./snapshot.js";

// The backup allowlist, the cold-start budgets and the #54 note moved to
// rollback.ts (the rollback shares them); re-exported so callers keep importing them from here.
export { MODEL_CACHE_BACKUP_NOTE, START_WAIT_MS, backupDataDir, checkpointWal } from "./rollback.js";

export interface UpdateDeps {
  config: EngramConfig;
  services: ServiceDeps;
  /** Where the running CLI lives (git checkout root or installed package dir). */
  packageRoot: string;
  /** Hermes home to look for plugin deploy targets in (`HERMES_HOME`, default ~/.hermes). */
  hermesHome: string;
  now: () => Date;
  log: (line: string) => void;
  /** Node binary + CLI script used for post-swap child runs. */
  node: string;
  cliScript: (install: InstallInfo) => string;
  /** Ask a yes/no question on a terminal; absent when stdin is not a TTY (then `--yes` decides). */
  confirm?: (question: string) => Promise<boolean>;
  /** Overrides for the install-path check (tests); defaults to the running process. */
  installPath?: Partial<InstallPathContext>;
}

export interface UpdatePlan {
  install: InstallInfo;
  available: AvailableVersion;
  target: string | null;
  dataDir: DataDirPlan;
  modelCache: ModelCachePlan;
  services: ServiceStatus[];
  pluginTargets: string[];
  pluginProfiles: string[];
  backupDir: string | null;
  /** Conditions the operator must resolve by hand before `engram update` will run. */
  blockers: string[];
  /** Things worth knowing that do not stop the run (#65: the `engram` on PATH is not this install). */
  warnings: string[];
  /** Ordered description of what the run does. */
  steps: string[];
}

export function pluginDeployTargets(hermesHome: string): { targets: string[]; profiles: string[] } {
  const targets: string[] = [];
  const profiles: string[] = [];
  const base = join(hermesHome, "plugins", "engram");
  if (existsSync(base)) targets.push(base);
  const profilesDir = join(hermesHome, "profiles");
  if (existsSync(profilesDir)) {
    for (const name of readdirSync(profilesDir)) {
      const dir = join(profilesDir, name, "plugins", "engram");
      if (existsSync(dir)) { targets.push(dir); profiles.push(name); }
    }
  }
  return { targets, profiles };
}

export function backupDirFor(dataDir: string, now: Date): string {
  return `${dataDir}.backup-${planStamp(now)}`;
}

export async function buildUpdatePlan(deps: UpdateDeps, opts: { noBackup?: boolean; to?: string } = {}): Promise<UpdatePlan> {
  const { services: sdeps, config } = deps;
  const install = await detectInstall({ exec: sdeps.exec, packageRoot: deps.packageRoot });
  const available = await latestAvailable(install, sdeps.exec);
  const target = opts.to ?? available.version;
  const penv = { config, env: sdeps.env, platform: sdeps.platform, home: sdeps.home };
  const dataDir = planDataDir(penv);
  const modelCache = planModelCache(penv, deps.packageRoot);
  const services = await listServices(sdeps);
  const { targets: pluginTargets, profiles: pluginProfiles } = sdeps.platform === "win32" ? { targets: [], profiles: [] } : pluginDeployTargets(deps.hermesHome);
  const backupDir = opts.noBackup ? null : backupDirFor(dataDir.action.kind === "move" ? dataDir.action.from : dataDir.effective, deps.now());

  const blockers: string[] = [];
  if (install.kind === "git" && install.dirty) blockers.push(`uncommitted changes in ${install.root}: commit or stash them (git status --short)`);
  if (dataDir.action.kind === "refuse") blockers.push(`data dir: ${dataDir.action.reason}: ${dataDir.action.populated.join(", ")}`);
  for (const s of services) {
    if (s.unsupervised) blockers.push(`${s.id} answers on its port but no supervisor owns it: stop that process by hand, or install the supervisor (${s.installHint})`);
  }
  // #65: the same check as doctor's `install path`. A warning, never a
  // blocker — the run still upgrades this install; it just says that the
  // `engram` the shell finds is a different one.
  const warnings: string[] = [];
  const ip = installPathReport(defaultInstallPathContext({ packageRoot: deps.packageRoot, path: sdeps.env.PATH ?? "", platform: sdeps.platform, ...deps.installPath }));
  if (!ip.ok) warnings.push(`install path: ${ip.detail}`);

  const steps: string[] = [];
  if (backupDir) steps.push(`back up ${dataDir.action.kind === "move" ? dataDir.action.from : dataDir.effective} (engram.db + wal/shm + archive) to ${backupDir}`);
  else steps.push("skip the backup (--no-backup)");
  const running = STOP_ORDER.map((id) => services.find((s) => s.id === id)!).filter((s) => s.running);
  steps.push(running.length ? `stop ${running.map((s) => `${s.id} (${s.stopCommand})`).join(", ")}` : "no running services to stop");
  steps.push("snapshot row counts (exchanges, conversations, memories, entities, relationships, commitments)");
  if (modelCache.hasModels) steps.push(`move the downloaded models from ${modelCache.durable ? modelCache.legacy : modelCache.current} to ${modelCache.proposed} before npm touches node_modules`);
  if (!modelCache.durable) steps.push(`give the embedding model a durable cache at ${modelCache.proposed} before npm touches node_modules`);
  if (install.kind === "git") steps.push(`git pull --ff-only in ${install.root}${install.branch ? ` (${install.branch})` : ""}, then npm ci (builds dist/)`);
  else steps.push(`npm install -g ${install.packageName}@${target ?? "latest"}`);
  if (dataDir.action.kind === "move") steps.push(`move ${dataDir.action.items.join(", ")} from ${dataDir.action.from} to ${dataDir.action.to}`);
  steps.push("open the database once with the new build so schema migrations run (engram migrate schema)");
  const toStart = START_ORDER.map((id) => services.find((s) => s.id === id)!).filter((s) => running.includes(s));
  steps.push(toStart.length ? `start ${toStart.map((s) => `${s.id} (${s.startCommand})`).join(", then ")} and wait for /health` : "no services to start");
  if (pluginTargets.length && install.kind === "git") steps.push(`redeploy the Hermes plugin to ${pluginTargets.length} target(s) (interfaces/hermes-plugin/deploy.sh), then you restart the gateways`);
  steps.push("verify: engram doctor, /health, engram stats counts >= the snapshot; on failure offer `engram update --rollback` (auto-restores the backup only when counts dropped)");
  return { install, available, target, dataDir, modelCache, services, pluginTargets, pluginProfiles, backupDir, blockers, warnings, steps };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatPlan(plan: UpdatePlan): string[] {
  const { install, available, dataDir, modelCache, services } = plan;
  const lines: string[] = [];
  lines.push(`Install:    ${install.kind === "git" ? `git checkout ${install.root}${install.branch ? ` (${install.branch}${install.headSha ? ` @ ${install.headSha}` : ""})` : ""}` : `npm global ${install.packageName} at ${install.root}`}`);
  lines.push(`Version:    ${install.version} -> ${plan.target ?? "unknown"}${available.version ? ` (${available.source})` : available.error ? ` (${available.source} failed: ${available.error})` : ""}${plan.target && compareSemver(plan.target, install.version) <= 0 ? "  [already up to date; the run still migrates and verifies]" : ""}`);
  lines.push("");
  lines.push(`Data dir:   ${dataDir.effective}  (db: ${dataDir.effectiveDb}; from ${dataDir.source})`);
  for (const c of dataDir.candidates) {
    const tag = c.reasons.join("+");
    lines.push(`  ${c.populated ? "[db] " : c.exists ? "[dir]" : "[--] "} ${c.dir}  (${tag}${c.populated ? `, ${mb(c.sizeBytes)}` : c.exists ? ", no database" : ", absent"})`);
  }
  if (dataDir.action.kind === "move") lines.push(`  -> will move ${dataDir.action.items.join(", ")} from ${dataDir.action.from} to ${dataDir.action.to}`);
  else if (dataDir.action.kind === "refuse") lines.push(`  !! ${dataDir.action.reason}`);
  else lines.push(`  -> ${dataDir.action.reason}`);
  lines.push("");
  lines.push(`Model cache: ${modelCache.current} (${modelCache.durable ? "durable" : "inside node_modules: wiped by npm ci"}; ${modelCacheSourceLabel(modelCache.source)})`);
  if (!modelCache.durable) lines.push(`  -> will use ${modelCache.proposed}; unset ENGRAM_MODEL_CACHE_DIR or set ${modelCache.envLine}`);
  if (modelCache.hasModels) lines.push(`  -> will move the downloaded models from ${modelCache.durable ? modelCache.legacy : modelCache.current} to ${modelCache.proposed}`);
  lines.push(`  ${MODEL_CACHE_BACKUP_NOTE}`);
  lines.push("");
  lines.push("Services:");
  for (const s of services) {
    const state = s.unsupervised ? "UNSUPERVISED (answers on its port, no supervisor)" : !s.installed ? "not installed" : s.running ? "running" : "installed, stopped";
    lines.push(`  ${s.id.padEnd(10)} ${s.supervisor} ${s.unit}: ${state}${s.listening === true ? " [port answering]" : s.listening === false && s.running ? " [port NOT answering]" : ""}`);
    if (s.installed || s.running) lines.push(`             restart: ${s.restartCommand}`);
  }
  lines.push("");
  lines.push(plan.pluginTargets.length ? `Hermes plugin: ${plan.pluginTargets.length} deploy target(s)${plan.pluginProfiles.length ? ` (profiles: ${plan.pluginProfiles.join(", ")})` : ""}` : "Hermes plugin: not deployed here");
  lines.push(`Backup:     ${plan.backupDir ?? "skipped (--no-backup)"}`);
  lines.push(`Rollback:   plan recorded in ${join(dataDir.effective, "updates")} before anything changes; engram update --rollback [<stamp>] [--restore-data]`);
  lines.push("");
  if (plan.warnings.length) {
    lines.push("Warnings:");
    for (const w of plan.warnings) lines.push(`  -- ${w}`);
    lines.push("");
  }
  if (plan.blockers.length) {
    lines.push("BLOCKED — resolve before running `engram update`:");
    for (const b of plan.blockers) lines.push(`  !! ${b}`);
    lines.push("");
  }
  lines.push("Steps:");
  plan.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  return lines;
}

// ─── execution ───────────────────────────────────────────────────────

export interface RunResult {
  ok: boolean;
  lines: string[];
  /** The persisted rollback plan (`<data dir>/updates/<stamp>.json`), once written. */
  planFile?: string;
  /** Present when the run performed the automatic rollback after a failed step. */
  rollback?: RollbackResult;
}

function openReadonly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

export interface RunOptions {
  dryRun?: boolean;
  /** `--yes`: no confirmation for the update, and perform the rollback without asking when a post-swap step fails. */
  yes?: boolean;
}

export async function runUpdate(plan: UpdatePlan, deps: UpdateDeps, opts: RunOptions = {}): Promise<RunResult> {
  const lines: string[] = [];
  const say = (l: string) => { lines.push(l); deps.log(l); };
  const { services: sdeps } = deps;
  const exec = sdeps.exec;
  if (plan.blockers.length) {
    say("Refusing to update:");
    for (const b of plan.blockers) say(`  !! ${b}`);
    return { ok: false, lines };
  }
  if (opts.dryRun) {
    for (const l of formatPlan(plan)) say(l);
    return { ok: true, lines };
  }
  const srcDataDir = plan.dataDir.action.kind === "move" ? plan.dataDir.action.from : plan.dataDir.effective;
  const srcDb = join(srcDataDir, "engram.db");
  const running = STOP_ORDER.map((id) => plan.services.find((s) => s.id === id)!).filter((s) => s.running);
  const inst = plan.install;

  // 0. persist the rollback plan before anything changes (#65). Everything
  //    the rollback needs is known now except the snapshot, filled in at step 3.
  const now = deps.now();
  let applied: string[] = [];
  try { applied = readDbSchemaVersion(srcDb).applied; } catch (err) { say(`  !! could not read the schema version of ${srcDb}: ${err instanceof Error ? err.message : String(err)}`); }
  const rb: RollbackPlan = {
    v: 1,
    stamp: planStamp(now),
    at: now.toISOString(),
    install: { kind: inst.kind, root: inst.root, packageName: inst.packageName, version: inst.version, branch: inst.branch, headSha: inst.headSha },
    target: plan.target,
    dataDir: plan.dataDir.effective,
    dataDirFrom: plan.dataDir.action.kind === "move" ? plan.dataDir.action.from : null,
    modelCacheDir: plan.modelCache.durable ? null : plan.modelCache.proposed,
    backupDir: plan.backupDir,
    services: running,
    pluginTargets: plan.pluginTargets,
    pluginProfiles: plan.pluginProfiles,
    schema: { version: SCHEMA_VERSION, applied },
    snapshot: null,
    progress: "planned",
  };
  const planFile = writeRollbackPlan(plan.dataDir.effective, rb);
  say(`rollback plan: ${planFile}`);
  const progress = (p: UpdateProgress) => { rb.progress = p; try { writeRollbackPlan(plan.dataDir.effective, rb); } catch { /* the run continues; the file is best effort from here */ } };
  for (const gone of pruneRollbackPlans(plan.dataDir.effective)) say(`  pruned old plan ${gone}`);

  // 1. stop writers
  let stopped: Awaited<ReturnType<typeof stopServicesInOrder>>;
  try {
    stopped = await stopServicesInOrder(running, sdeps, say);
  } catch (err) {
    say(`  !! ${err instanceof Error ? err.message : String(err)}`);
    stopped = { ok: false, failed: null };
  }
  if (!stopped.ok) { say("  aborting before anything changed"); progress("failed:stop"); return { ok: false, lines, planFile }; }
  progress("stopped");

  // 2. backup
  if (plan.backupDir) {
    say(`backing up ${srcDataDir} -> ${plan.backupDir}`);
    checkpointWal(srcDb);
    for (const l of backupDataDir(srcDataDir, plan.backupDir)) say(l);
    progress("backup");
  }

  // 3. snapshot
  let before: CountSnapshot | null = null;
  if (existsSync(srcDb)) {
    const db = openReadonly(srcDb);
    try { before = snapshotCounts(db); } finally { db.close(); }
    say(`snapshot: ${formatSnapshot(before)}`);
  } else {
    say("snapshot: no database yet");
  }
  rb.snapshot = before;
  progress("snapshot");

  // 4. durable model cache, before npm touches node_modules: move a legacy
  //    node_modules cache into the resolved dir and/or relocate an explicit
  //    setting that still points inside node_modules (#53)
  const npmEnv: NodeJS.ProcessEnv = { ...sdeps.env };
  if (!plan.modelCache.durable || plan.modelCache.hasModels) {
    for (const l of applyModelCachePlan(plan.modelCache, { dryRun: false })) say(`model-cache: ${l}`);
    if (!plan.modelCache.durable) npmEnv.ENGRAM_MODEL_CACHE_DIR = plan.modelCache.proposed;
  }

  // 5. code
  if (inst.kind === "git") {
    // Name the remote and branch explicitly: a checkout whose branch has no
    // upstream (common after `git checkout -b main origin/main` variants)
    // makes a bare `git pull` fail with "no tracking information".
    const pullArgs = ["-C", inst.root, "pull", "--ff-only"];
    if (inst.branch && inst.branch !== "HEAD") pullArgs.push("origin", inst.branch);
    say(`git ${pullArgs.slice(2).join(" ")} (${inst.root})`);
    const pull = await exec("git", pullArgs);
    if (pull.status !== 0) { say(`  !! git pull failed: ${(pull.stderr || pull.stdout).trim()}`); return finish("pull"); }
    say("npm ci (rebuilds dist/)");
    const ci = await exec("npm", ["ci"], { cwd: inst.root, env: npmEnv });
    if (ci.status !== 0) { say(`  !! npm ci failed: ${(ci.stderr || ci.stdout).trim().split("\n").slice(-10).join("\n")}`); return finish("npm ci"); }
  } else {
    const spec = `${inst.packageName}@${plan.target ?? "latest"}`;
    say(`npm install -g ${spec}`);
    const r = await exec("npm", ["install", "-g", spec], { env: npmEnv });
    if (r.status !== 0) { say(`  !! npm install failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-10).join("\n")}`); return finish("npm install"); }
  }
  progress("code");

  // 6. data dir move (old code, pure file moves) + schema migrations (new build)
  if (plan.dataDir.action.kind === "move") {
    for (const l of applyDataDirPlan(plan.dataDir, { dryRun: false })) say(`data-dir: ${l}`);
  }
  const cli = deps.cliScript(inst);
  const childEnv: NodeJS.ProcessEnv = { ...npmEnv };
  say("engram migrate schema (new build)");
  const mig = await exec(deps.node, [cli, "migrate", "schema"], { env: childEnv });
  if (mig.status !== 0) { say(`  !! migrate failed: ${(mig.stderr || mig.stdout).trim()}`); return finish("migrate"); }
  for (const l of mig.stdout.trim().split("\n")) say(`  ${l}`);
  progress("migrated");

  // 7. restart services in order, MCP first. Cold starts are slow: the MCP
  // daemon loads the embedding model, the visualizer pre-renders every page
  // over the whole graph (a 15k-entity store takes ~40 s), so each gets its
  // own budget rather than the 30 s poll default (#46).
  const started = await startServicesInOrder(running, sdeps, say);
  if (!started.ok) return finish(`start ${started.failed}`);
  progress("restarted");

  // 8. plugin redeploy (after the MCP server is back)
  if (inst.kind === "git" && plan.pluginTargets.length && sdeps.platform !== "win32") {
    const script = join(inst.root, "interfaces", "hermes-plugin", "deploy.sh");
    if (existsSync(script)) {
      say(`redeploying the Hermes plugin (${plan.pluginTargets.length} target(s))`);
      const r = await exec("bash", [script], { cwd: inst.root, env: { ...childEnv, ENGRAM_PLUGIN_PROFILES: plan.pluginProfiles.join(" ") } });
      if (r.status !== 0) say(`  !! deploy.sh failed: ${(r.stderr || r.stdout).trim()}`);
      else say("  restart the Hermes gateways so they load the new plugin code");
    }
  }

  // 9. verify
  const v = await verifyBuild({ cli, env: childEnv, running, before }, deps, say);
  if (!v.ok) return finish("verify", v.regressions);
  progress("verified");
  say(`updated to ${plan.target ?? "the latest build"}; verification passed${plan.backupDir ? ` (backup kept at ${plan.backupDir})` : ""}`);
  progress("done");
  return { ok: true, lines, planFile };

  /**
   * A step failed. A failed `git pull` changed nothing: bring the services
   * back and say so. Anything later may have touched the code on disk (a
   * failed `npm ci` follows a pull that already moved HEAD), so offer the
   * rollback (#65): `--yes` performs it, a terminal is asked, otherwise the
   * command is printed. The backup is restored only when verification proved
   * counts dropped (decision #66).
   */
  async function finish(step: string, regressions: string[] = []): Promise<RunResult> {
    say("");
    say("UPDATE FAILED.");
    progress(`failed:${step}`);
    if (step === "pull") {
      // Never leave the machine without its services: bring back whatever
      // was running, on whatever code is on disk now, and say so.
      for (const l of await restartAfterFailure(running, sdeps)) say(l);
      say(`Nothing to roll back: the code on disk is unchanged (plan kept at ${planFile}).`);
      return { ok: false, lines, planFile };
    }
    const restoreData = regressions.length > 0 && rb.backupDir !== null;
    if (regressions.length && !rb.backupDir) say("  counts dropped but this run had --no-backup: there is no backup to restore, so a rollback is code-only");
    const reason = regressions.length ? `counts dropped: ${regressions.join("; ")}` : `${step} failed`;
    const command = `engram update --rollback ${rb.stamp}${restoreData ? " --restore-data" : ""}`;
    const question = `Roll back to ${inst.version}${restoreData ? " and restore the backup (counts dropped)" : " (code-only)"}? [y/N] `;
    let go = false;
    if (opts.yes) go = true;
    else if (deps.confirm) go = await deps.confirm(question);
    else say(`Not a terminal: run \`${command}\` to roll back (or re-run the update with --yes to roll back automatically).`);
    if (!go) {
      for (const l of await restartAfterFailure(running, sdeps)) say(l);
      say(`Rollback: ${command}`);
      say("Manual steps, in order (services were restarted on the code currently on disk):");
      for (const l of manualRollbackSteps(rb)) say(`  ${l}`);
      return { ok: false, lines, planFile };
    }
    say("");
    say(`rolling back to ${inst.version} (${restoreData ? "code + data: verification proved data loss" : "code-only"})`);
    const rollback = await rollbackUpdate(rb, planFile, deps, { restoreData, reason });
    lines.push(...rollback.lines);
    return { ok: false, lines, planFile, rollback };
  }
}
