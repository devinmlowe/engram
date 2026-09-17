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
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { EngramConfig } from "../../_core/types/index.js";
import { compareSemver, detectInstall, latestAvailable, type AvailableVersion, type InstallInfo } from "./install-kind.js";
import {
  applyDataDirPlan, applyModelCachePlan, planDataDir, planModelCache, type DataDirPlan, type ModelCachePlan,
} from "./data-migration.js";
import {
  listServices, portFor, startService, stopService, waitForPort, START_ORDER, STOP_ORDER,
  type ServiceDeps, type ServiceStatus,
} from "./services.js";
import { snapshotCounts, snapshotRegressions, formatSnapshot, type CountSnapshot } from "./snapshot.js";

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

/** How long a cold start may take before the update gives up on a service. */
export const START_WAIT_MS: Record<"mcp" | "visualizer" | "dream", number> = { mcp: 90_000, visualizer: 180_000, dream: 30_000 };

export function backupDirFor(dataDir: string, now: Date): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  return `${dataDir}.backup-${ts}`;
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

  const steps: string[] = [];
  if (backupDir) steps.push(`back up ${dataDir.action.kind === "move" ? dataDir.action.from : dataDir.effective} (engram.db + wal/shm + archive) to ${backupDir}`);
  else steps.push("skip the backup (--no-backup)");
  const running = STOP_ORDER.map((id) => services.find((s) => s.id === id)!).filter((s) => s.running);
  steps.push(running.length ? `stop ${running.map((s) => `${s.id} (${s.stopCommand})`).join(", ")}` : "no running services to stop");
  steps.push("snapshot row counts (exchanges, conversations, memories, entities, relationships, commitments)");
  if (!modelCache.durable) steps.push(`give the embedding model a durable cache at ${modelCache.proposed} before npm touches node_modules`);
  if (install.kind === "git") steps.push(`git pull --ff-only in ${install.root}${install.branch ? ` (${install.branch})` : ""}, then npm ci (builds dist/)`);
  else steps.push(`npm install -g ${install.packageName}@${target ?? "latest"}`);
  if (dataDir.action.kind === "move") steps.push(`move ${dataDir.action.items.join(", ")} from ${dataDir.action.from} to ${dataDir.action.to}`);
  steps.push("open the database once with the new build so schema migrations run (engram migrate schema)");
  const toStart = START_ORDER.map((id) => services.find((s) => s.id === id)!).filter((s) => running.includes(s));
  steps.push(toStart.length ? `start ${toStart.map((s) => `${s.id} (${s.startCommand})`).join(", then ")} and wait for /health` : "no services to start");
  if (pluginTargets.length && install.kind === "git") steps.push(`redeploy the Hermes plugin to ${pluginTargets.length} target(s) (interfaces/hermes-plugin/deploy.sh), then you restart the gateways`);
  steps.push("verify: engram doctor, /health, engram stats counts >= the snapshot; on any drop print the rollback steps");
  return { install, available, target, dataDir, modelCache, services, pluginTargets, pluginProfiles, backupDir, blockers, steps };
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
  lines.push(`Model cache: ${modelCache.current}${modelCache.durable ? " (durable, ENGRAM_MODEL_CACHE_DIR)" : " (inside node_modules: wiped by npm ci)"}`);
  if (!modelCache.durable) lines.push(`  -> will use ${modelCache.proposed}${modelCache.hasModels ? " and copy the downloaded models there" : ""}; set ${modelCache.envLine}`);
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
  lines.push("");
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
}

function openReadonly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/** Quiesce the WAL into the main file so a file copy is a complete backup. Services are stopped by now. */
export function checkpointWal(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath);
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
}

export function backupDataDir(from: string, to: string): string[] {
  const lines: string[] = [];
  mkdirSync(to, { recursive: true });
  for (const item of ["engram.db", "engram.db-wal", "engram.db-shm", "archive"]) {
    const src = join(from, item);
    if (!existsSync(src)) continue;
    cpSync(src, join(to, item), { recursive: true });
    const st = statSync(src);
    lines.push(`  ${item}${st.isFile() ? ` (${mb(st.size)})` : "/"}`);
  }
  return lines;
}

export async function runUpdate(plan: UpdatePlan, deps: UpdateDeps, opts: { dryRun?: boolean } = {}): Promise<RunResult> {
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
  const rollback: string[] = [];
  const running = STOP_ORDER.map((id) => plan.services.find((s) => s.id === id)!).filter((s) => s.running);

  // 1. stop writers
  for (const s of running) {
    say(`stopping ${s.id} (${s.stopCommand})`);
    await stopService(s, sdeps);
    if (!(await waitForPort(s, sdeps, false))) { say(`  !! ${s.id} still answers on its port after 30s; aborting before anything changed`); return { ok: false, lines }; }
  }
  rollback.push(...running.map((s) => `start ${s.id}: ${s.startCommand}`));

  // 2. backup
  if (plan.backupDir) {
    say(`backing up ${srcDataDir} -> ${plan.backupDir}`);
    checkpointWal(srcDb);
    for (const l of backupDataDir(srcDataDir, plan.backupDir)) say(l);
    rollback.unshift(`restore: copy ${plan.backupDir}/* back into ${srcDataDir} (stop services first)`);
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

  // 4. durable model cache, before npm touches node_modules
  const npmEnv: NodeJS.ProcessEnv = { ...sdeps.env };
  if (!plan.modelCache.durable) {
    for (const l of applyModelCachePlan(plan.modelCache, { dryRun: false })) say(`model-cache: ${l}`);
    npmEnv.ENGRAM_MODEL_CACHE_DIR = plan.modelCache.proposed;
  }

  // 5. code
  const inst = plan.install;
  if (inst.kind === "git") {
    // Name the remote and branch explicitly: a checkout whose branch has no
    // upstream (common after `git checkout -b main origin/main` variants)
    // makes a bare `git pull` fail with "no tracking information".
    const pullArgs = ["-C", inst.root, "pull", "--ff-only"];
    if (inst.branch && inst.branch !== "HEAD") pullArgs.push("origin", inst.branch);
    say(`git ${pullArgs.slice(2).join(" ")} (${inst.root})`);
    const pull = await exec("git", pullArgs);
    if (pull.status !== 0) { say(`  !! git pull failed: ${(pull.stderr || pull.stdout).trim()}`); return finish(false); }
    rollback.push(`code: git -C ${inst.root} checkout ${inst.headSha ?? "<previous sha>"} && npm ci`);
    say("npm ci (rebuilds dist/)");
    const ci = await exec("npm", ["ci"], { cwd: inst.root, env: npmEnv });
    if (ci.status !== 0) { say(`  !! npm ci failed: ${(ci.stderr || ci.stdout).trim().split("\n").slice(-10).join("\n")}`); return finish(false); }
  } else {
    const spec = `${inst.packageName}@${plan.target ?? "latest"}`;
    say(`npm install -g ${spec}`);
    const r = await exec("npm", ["install", "-g", spec], { env: npmEnv });
    if (r.status !== 0) { say(`  !! npm install failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-10).join("\n")}`); return finish(false); }
    rollback.push(`code: npm install -g ${inst.packageName}@${inst.version}`);
  }

  // 6. data dir move (old code, pure file moves) + schema migrations (new build)
  if (plan.dataDir.action.kind === "move") {
    for (const l of applyDataDirPlan(plan.dataDir, { dryRun: false })) say(`data-dir: ${l}`);
    rollback.push(`data: move the items back from ${plan.dataDir.action.to} to ${plan.dataDir.action.from}`);
  }
  const cli = deps.cliScript(inst);
  const childEnv: NodeJS.ProcessEnv = { ...npmEnv };
  say("engram migrate schema (new build)");
  const mig = await exec(deps.node, [cli, "migrate", "schema"], { env: childEnv });
  if (mig.status !== 0) { say(`  !! migrate failed: ${(mig.stderr || mig.stdout).trim()}`); return finish(false); }
  for (const l of mig.stdout.trim().split("\n")) say(`  ${l}`);

  // 7. restart services in order, MCP first. Cold starts are slow: the MCP
  // daemon loads the embedding model, the visualizer pre-renders every page
  // over the whole graph (a 15k-entity store takes ~40 s), so each gets its
  // own budget rather than the 30 s poll default (#46).
  for (const id of START_ORDER) {
    const s = running.find((r) => r.id === id);
    if (!s) continue;
    say(`starting ${s.id} (${s.startCommand})`);
    await startService(s, sdeps);
    const budget = START_WAIT_MS[s.id];
    if (!(await waitForPort(s, sdeps, true, budget))) { say(`  !! ${s.id} did not answer on its port within ${budget / 1000}s`); return finish(false); }
  }
  // dream is a timer/scheduled job: nothing to start, but on launchd the agent must be loaded again
  const dream = running.find((r) => r.id === "dream");
  if (dream) { say(`re-enabling ${dream.id} (${dream.startCommand})`); await startService(dream, sdeps); }

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
  const doc = await exec(deps.node, [cli, "doctor", "--json"], { env: childEnv });
  let doctorOk = doc.status === 0;
  try { doctorOk = doctorOk && JSON.parse(doc.stdout).ok === true; } catch { doctorOk = false; }
  say(`doctor: ${doctorOk ? "ok" : "FAILED"}`);
  const mcp = running.find((r) => r.id === "mcp");
  if (mcp) {
    const port = portFor("mcp", sdeps.env)!;
    say(`health: ${(await sdeps.probe(port.port, port.path)) ? "ok" : "NOT answering"} (http://127.0.0.1:${port.port}${port.path})`);
  }
  const st = await exec(deps.node, [cli, "stats", "--json"], { env: childEnv });
  let after: CountSnapshot | null = null;
  try { after = JSON.parse(st.stdout).counts as CountSnapshot; } catch { /* handled below */ }
  if (!after) { say(`  !! could not read stats from the new build: ${(st.stderr || st.stdout).trim()}`); return finish(false); }
  say(`counts:   ${formatSnapshot(after)}`);
  const regressions = before ? snapshotRegressions(before, after) : [];
  if (regressions.length) {
    say(`  !! counts DROPPED after the update: ${regressions.join("; ")}`);
    return finish(false);
  }
  if (!doctorOk) return finish(false);
  say(`updated to ${plan.target ?? "the latest build"}; verification passed${plan.backupDir ? ` (backup kept at ${plan.backupDir})` : ""}`);
  return { ok: true, lines };

  async function finish(ok: boolean): Promise<RunResult> {
    if (!ok) {
      say("");
      say("UPDATE FAILED.");
      // Never leave the machine without its services: bring back whatever
      // was running, on whatever code is on disk now, and say so.
      for (const l of await restartAfterFailure()) say(l);
      say("Rollback steps, in order (services were restarted on the code currently on disk):");
      for (const s of STOP_ORDER) { const r = running.find((x) => x.id === s); if (r) say(`  stop ${r.id}: ${r.stopCommand}`); }
      for (const r of rollback) say(`  ${r}`);
      say("  then: engram doctor && engram stats");
    }
    return { ok, lines };
  }

  async function restartAfterFailure(): Promise<string[]> {
    const out: string[] = [];
    for (const id of [...START_ORDER, "dream" as const]) {
      const s = running.find((r) => r.id === id);
      if (!s) continue;
      try {
        await startService(s, sdeps);
        const up = await waitForPort(s, sdeps, true, START_WAIT_MS[s.id]);
        out.push(`  restarted ${s.id}${up ? "" : " (port not answering yet)"}`);
      } catch (err) {
        out.push(`  !! could not restart ${s.id}: ${err instanceof Error ? err.message : String(err)} — run: ${s.startCommand}`);
      }
    }
    return out;
  }
}
