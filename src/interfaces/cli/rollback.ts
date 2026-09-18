/**
 * `engram update --rollback` (#65, decision #66) and the steps `engram update`
 * shares with it.
 *
 * Before `runUpdate` changes anything it persists a rollback plan at
 * `<data dir>/updates/<stamp>.json`: the prior version and git sha, the
 * install kind and root, the backup dir, the services that were running (with
 * their start commands), the plugin deploy targets, the target version, the
 * schema version of the database, the pre-update row-count snapshot, and a
 * `progress` marker advanced at every step — so a rollback knows how far the
 * update got even when the process died half-way.
 *
 * The rollback is CODE-ONLY by default: stop services → `git checkout <sha>
 * && npm ci` or `npm install -g <pkg>@<prev>` → `engram migrate schema` with
 * the RESTORED build in a child process → restart what was running → the same
 * verify step (doctor, /health, counts vs the snapshot), again via the
 * restored build. `engram.db` keeps everything written since the update;
 * migrations are additive, so the previous build reads the newer schema.
 * `--restore-data` (or the auto-restore `runUpdate` triggers only when its
 * verification proved counts dropped) additionally copies the backup back.
 * A code-only rollback across a `BREAKING_MIGRATIONS` checkpoint is refused.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BREAKING_MIGRATIONS, SCHEMA_VERSION, schemaVersion, type SchemaVersion } from "../../_core/db/schema.js";
import type { InstallInfo, InstallKind } from "./install-kind.js";
import {
  listServices, portFor, startService, stopService, waitForPort, START_ORDER, STOP_ORDER,
  type ServiceDeps, type ServiceId, type ServiceStatus,
} from "./services.js";
import { snapshotRegressions, formatSnapshot, type CountSnapshot } from "./snapshot.js";
import type { UpdateDeps } from "./update.js";

// ─── constants shared with runUpdate ─────────────────────────────────

/** How long a cold start may take before the update (or its rollback) gives up on a service. */
export const START_WAIT_MS: Record<ServiceId, number> = { mcp: 90_000, visualizer: 180_000, dream: 30_000 };

/** Decision #54: the backup is an allowlist (engram.db + wal/shm + archive/); model weights are re-downloadable and never enter it. */
export const MODEL_CACHE_BACKUP_NOTE = "models/ is not backed up (re-downloadable); rollback re-downloads if the cache is missing";

/** What `backupDataDir` copies and `restoreDataDir` puts back, in this order. */
export const DATA_BACKUP_ITEMS = ["engram.db", "engram.db-wal", "engram.db-shm", "archive"] as const;

/** Plan files kept under `<data dir>/updates/`; older ones are pruned after each update. */
export const ROLLBACK_PLANS_KEPT = 10;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── backup / restore ────────────────────────────────────────────────

/** Quiesce the WAL into the main file so a file copy is a complete backup. Services are stopped by now. */
export function checkpointWal(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath);
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
}

export function backupDataDir(from: string, to: string): string[] {
  const lines: string[] = [];
  mkdirSync(to, { recursive: true });
  for (const item of DATA_BACKUP_ITEMS) {
    const src = join(from, item);
    if (!existsSync(src)) continue;
    cpSync(src, join(to, item), { recursive: true });
    const st = statSync(src);
    lines.push(`  ${item}${st.isFile() ? ` (${mb(st.size)})` : "/"}`);
  }
  return lines;
}

/**
 * `backupDataDir` in reverse. The database files are replaced exactly (a
 * stale `-wal`/`-shm` next to a restored main file would be replayed into it,
 * so they are removed when the backup has none); `archive/` is merged with the
 * backup winning on same-named files, so conversations archived after the
 * update are kept. Ends with a WAL checkpoint. Services must be stopped.
 */
export function restoreDataDir(from: string, to: string): string[] {
  if (!existsSync(from)) throw new Error(`backup dir ${from} does not exist`);
  const lines: string[] = [];
  mkdirSync(to, { recursive: true });
  for (const item of DATA_BACKUP_ITEMS) {
    const src = join(from, item);
    const dst = join(to, item);
    if (item === "archive") {
      if (!existsSync(src)) continue;
      cpSync(src, dst, { recursive: true, force: true });
      lines.push(`  ${item}/ (merged, backup wins)`);
      continue;
    }
    if (existsSync(dst)) rmSync(dst, { force: true });
    if (!existsSync(src)) continue;
    cpSync(src, dst);
    lines.push(`  ${item} (${mb(statSync(src).size)})`);
  }
  checkpointWal(join(to, "engram.db"));
  return lines;
}

// ─── the persisted plan ──────────────────────────────────────────────

export type UpdateProgress =
  | "planned" | "stopped" | "backup" | "snapshot" | "code" | "migrated" | "restarted" | "verified" | "done"
  | `failed:${string}`;

export type RollbackMode = "code-only" | "code + data";

export interface RollbackPlan {
  /** Plan-file format version. */
  v: 1;
  /** File stamp (`YYYYMMDD-HHMMSSZ`, the file is `<stamp>.json`) and the same instant as ISO-8601. */
  stamp: string;
  at: string;
  /** What was installed before the update: the code the rollback restores. */
  install: {
    kind: InstallKind;
    root: string;
    packageName: string;
    version: string;
    branch?: string;
    headSha?: string;
  };
  /** Version the update installs (null when the available version is unknown). */
  target: string | null;
  /** Effective data dir (after a data-dir move) and, when the update moved it, where it came from. */
  dataDir: string;
  dataDirFrom: string | null;
  /** `ENGRAM_MODEL_CACHE_DIR` the update exported to npm and its child runs, when it had to. */
  modelCacheDir: string | null;
  backupDir: string | null;
  /** Services that were running when the update started, with their supervisor commands. */
  services: ServiceStatus[];
  pluginTargets: string[];
  pluginProfiles: string[];
  /** `SCHEMA_VERSION` of the build that ran the update and the checkpoints the database had recorded. */
  schema: { version: number; applied: string[] };
  /** Row counts before the update (null until the snapshot step, or when there is no database yet). */
  snapshot: CountSnapshot | null;
  progress: UpdateProgress;
  /** Set once `engram update --rollback` (or the auto-rollback) has run against this plan. */
  rolledBack?: { at: string; mode: RollbackMode; ok: boolean; reason?: string };
}

export function rollbackPlansDir(dataDir: string): string {
  return join(dataDir, "updates");
}

/** `YYYYMMDD-HHMMSSZ` — the same stamp `backupDirFor` uses, and legal on every filesystem. */
export function planStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
}

export function rollbackPlanPath(dataDir: string, stamp: string): string {
  return join(rollbackPlansDir(dataDir), `${stamp}.json`);
}

/** Write (or overwrite) the plan file atomically. Returns its path. */
export function writeRollbackPlan(dataDir: string, plan: RollbackPlan): string {
  const dir = rollbackPlansDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const file = rollbackPlanPath(dataDir, plan.stamp);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

export function readRollbackPlan(file: string): RollbackPlan {
  const plan = JSON.parse(readFileSync(file, "utf-8")) as RollbackPlan;
  if (plan.v !== 1 || typeof plan.stamp !== "string" || !plan.install?.kind) throw new Error(`${file} is not an engram update plan`);
  return plan;
}

/** Every plan file, newest first. */
export function listRollbackPlans(dataDir: string): Array<{ file: string; stamp: string; plan: RollbackPlan }> {
  const dir = rollbackPlansDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: Array<{ file: string; stamp: string; plan: RollbackPlan }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try { out.push({ file, stamp: name.slice(0, -5), plan: readRollbackPlan(file) }); } catch { /* not ours; leave it alone */ }
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

/** Keep the newest `keep` plan files, delete the rest. Returns the deleted paths. */
export function pruneRollbackPlans(dataDir: string, keep: number = ROLLBACK_PLANS_KEPT): string[] {
  const gone: string[] = [];
  for (const { file } of listRollbackPlans(dataDir).slice(keep)) {
    rmSync(file, { force: true });
    gone.push(file);
  }
  return gone;
}

/** The plan `--rollback [<stamp>]` names: the newest, or the one whose stamp starts with `stamp`. */
export function selectRollbackPlan(
  plans: Array<{ file: string; stamp: string; plan: RollbackPlan }>,
  stamp?: string,
): { file: string; stamp: string; plan: RollbackPlan } | null {
  if (!stamp) return plans[0] ?? null;
  const wanted = stamp.replace(/\.json$/, "");
  return plans.find((p) => p.stamp === wanted) ?? plans.find((p) => p.stamp.startsWith(wanted)) ?? null;
}

export function formatRollbackPlans(plans: Array<{ file: string; stamp: string; plan: RollbackPlan }>): string[] {
  if (plans.length === 0) return ["no update plans recorded yet"];
  return plans.map(({ stamp, plan }) => {
    const rb = plan.rolledBack ? `; rolled back ${plan.rolledBack.ok ? "ok" : "FAILED"} (${plan.rolledBack.mode}) at ${plan.rolledBack.at}` : "";
    return `  ${stamp}  ${plan.install.version} -> ${plan.target ?? "?"}  ${plan.progress}  (${plan.install.kind}${plan.install.headSha ? ` @ ${plan.install.headSha}` : ""}; backup: ${plan.backupDir ?? "none"}${rb})`;
  });
}

/** Read the checkpoints a database file has recorded without running a migration. */
export function readDbSchemaVersion(dbPath: string): SchemaVersion {
  if (!existsSync(dbPath)) return { version: 0, applied: [] };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return schemaVersion(db); } finally { db.close(); }
}

/**
 * Decision #66: a code-only rollback is refused when the update applied a
 * checkpoint the previous build cannot read past. Pure; `breaking` is
 * injectable for tests (the real set is `BREAKING_MIGRATIONS`, empty today).
 */
export function schemaRollbackCheck(
  persisted: RollbackPlan["schema"],
  current: SchemaVersion,
  breaking: ReadonlySet<string> = BREAKING_MIGRATIONS,
): { ok: boolean; added: string[]; breaking: string[]; line: string } {
  const before = new Set(persisted.applied);
  const added = current.applied.filter((n) => !before.has(n));
  const crossed = added.filter((n) => breaking.has(n));
  if (crossed.length) {
    return {
      ok: false, added, breaking: crossed,
      line: `schema: the update applied breaking migration(s) ${crossed.join(", ")} (schema version ${persisted.version} -> ${current.version}); the previous build cannot read this database`,
    };
  }
  if (added.length) {
    return {
      ok: true, added, breaking: [],
      line: `schema: ${added.length} additive migration(s) applied by the update stay in place (${added.join(", ")}; version ${persisted.version} -> ${current.version}); the restored build ignores the columns/tables it does not know`,
    };
  }
  return { ok: true, added: [], breaking: [], line: `schema: unchanged since the update (version ${current.version})` };
}

// ─── steps shared with runUpdate ─────────────────────────────────────

export interface VerifyResult {
  ok: boolean;
  doctorOk: boolean;
  healthOk: boolean | null;
  after: CountSnapshot | null;
  regressions: string[];
}

/**
 * The post-swap verification: `doctor --json` and `stats --json` through the
 * build now on disk (a child process, never a lazy import), `/health` when
 * the MCP daemon was running, and no count below `before`.
 */
export async function verifyBuild(
  args: { cli: string; env: NodeJS.ProcessEnv; running: ServiceStatus[]; before: CountSnapshot | null },
  deps: UpdateDeps,
  say: (line: string) => void,
): Promise<VerifyResult> {
  const { services: sdeps } = deps;
  const exec = sdeps.exec;
  // --no-smoke: verification checks the build, not the LLM tiers (no extraction, nothing written, no 60 s budget).
  const doc = await exec(deps.node, [args.cli, "doctor", "--json", "--no-smoke"], { env: args.env });
  let doctorOk = doc.status === 0;
  try { doctorOk = doctorOk && JSON.parse(doc.stdout).ok === true; } catch { doctorOk = false; }
  say(`doctor: ${doctorOk ? "ok" : "FAILED"}`);
  let healthOk: boolean | null = null;
  if (args.running.some((r) => r.id === "mcp")) {
    const port = portFor("mcp", sdeps.env)!;
    healthOk = await sdeps.probe(port.port, port.path);
    say(`health: ${healthOk ? "ok" : "NOT answering"} (http://127.0.0.1:${port.port}${port.path})`);
  }
  const st = await exec(deps.node, [args.cli, "stats", "--json"], { env: args.env });
  let after: CountSnapshot | null = null;
  try { after = JSON.parse(st.stdout).counts as CountSnapshot; } catch { /* handled below */ }
  if (!after) {
    say(`  !! could not read stats from the build on disk: ${(st.stderr || st.stdout).trim()}`);
    return { ok: false, doctorOk, healthOk, after: null, regressions: [] };
  }
  say(`counts:   ${formatSnapshot(after)}`);
  const regressions = args.before ? snapshotRegressions(args.before, after) : [];
  if (regressions.length) say(`  !! counts DROPPED: ${regressions.join("; ")}`);
  return { ok: doctorOk && healthOk !== false && regressions.length === 0, doctorOk, healthOk, after, regressions };
}

/** Start the daemons in order (MCP first), each with its own cold-start budget, then re-enable the dream schedule. */
export async function startServicesInOrder(
  running: ServiceStatus[],
  sdeps: ServiceDeps,
  say: (line: string) => void,
): Promise<{ ok: boolean; failed: ServiceId | null }> {
  for (const id of START_ORDER) {
    const s = running.find((r) => r.id === id);
    if (!s) continue;
    say(`starting ${s.id} (${s.startCommand})`);
    await startService(s, sdeps);
    const budget = START_WAIT_MS[s.id];
    if (!(await waitForPort(s, sdeps, true, budget))) {
      say(`  !! ${s.id} did not answer on its port within ${budget / 1000}s`);
      return { ok: false, failed: s.id };
    }
  }
  const dream = running.find((r) => r.id === "dream");
  if (dream) { say(`re-enabling ${dream.id} (${dream.startCommand})`); await startService(dream, sdeps); }
  return { ok: true, failed: null };
}

/** Stop the writers in order (dream, MCP, visualizer) and wait for each port to go quiet. */
export async function stopServicesInOrder(
  running: ServiceStatus[],
  sdeps: ServiceDeps,
  say: (line: string) => void,
): Promise<{ ok: boolean; failed: ServiceId | null }> {
  for (const id of STOP_ORDER) {
    const s = running.find((r) => r.id === id);
    if (!s) continue;
    say(`stopping ${s.id} (${s.stopCommand})`);
    await stopService(s, sdeps);
    if (!(await waitForPort(s, sdeps, false))) {
      say(`  !! ${s.id} still answers on its port after 30s`);
      return { ok: false, failed: s.id };
    }
  }
  return { ok: true, failed: null };
}

/** Bring back whatever was running, on whatever code is on disk now, and say so. Never throws. */
export async function restartAfterFailure(running: ServiceStatus[], sdeps: ServiceDeps): Promise<string[]> {
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

/** The manual recipe, printed whenever the automatic path is not taken. */
export function manualRollbackSteps(plan: RollbackPlan): string[] {
  const out: string[] = [];
  for (const id of STOP_ORDER) { const r = plan.services.find((x) => x.id === id); if (r) out.push(`stop ${r.id}: ${r.stopCommand}`); }
  if (plan.backupDir) out.push(`data (only if counts dropped): copy ${plan.backupDir}/{engram.db,engram.db-wal,engram.db-shm,archive} back into ${plan.dataDir}`);
  if (plan.install.kind === "git") out.push(`code: git -C ${plan.install.root} checkout ${plan.install.headSha ?? "<previous sha>"} && npm ci`);
  else out.push(`code: npm install -g ${plan.install.packageName}@${plan.install.version}`);
  if (plan.dataDirFrom) out.push(`data dir: the update moved it from ${plan.dataDirFrom} to ${plan.dataDir}; it stays there (set ENGRAM_DATA_DIR=${plan.dataDir} if the restored build looks elsewhere)`);
  out.push("then: engram migrate schema");
  for (const id of [...START_ORDER, "dream" as const]) { const r = plan.services.find((x) => x.id === id); if (r) out.push(`start ${r.id}: ${r.startCommand}`); }
  out.push(MODEL_CACHE_BACKUP_NOTE);
  out.push("then: engram doctor && engram stats");
  return out;
}

// ─── the rollback ────────────────────────────────────────────────────

export interface RollbackOptions {
  /** Also restore the backup dir (`--restore-data`, or the auto-restore after verified data loss). */
  restoreData?: boolean;
  /** Why this rollback runs (recorded in the plan file), e.g. the failed verification's summary. */
  reason?: string;
  /** Injectable for tests; the real set is `BREAKING_MIGRATIONS`. */
  breaking?: ReadonlySet<string>;
}

export interface RollbackResult {
  ok: boolean;
  mode: RollbackMode;
  lines: string[];
  /** Why nothing was done, when the rollback was refused before touching anything. */
  refused?: string;
}

/**
 * Roll the install described by `plan` back. Services are read live (what is
 * running NOW is stopped; what WAS running before the update is started
 * again); the code step is the recipe the plan recorded; migrate and verify
 * run the restored build in a child process. Updates the plan file with
 * `rolledBack` on every outcome but a refusal.
 */
export async function rollbackUpdate(plan: RollbackPlan, file: string, deps: UpdateDeps, opts: RollbackOptions = {}): Promise<RollbackResult> {
  const lines: string[] = [];
  const say = (l: string) => { lines.push(l); deps.log(l); };
  const { services: sdeps } = deps;
  const exec = sdeps.exec;
  const mode: RollbackMode = opts.restoreData ? "code + data" : "code-only";
  const dbPath = join(plan.dataDir, "engram.db");
  const inst = plan.install;

  // 0. refusals, before anything is touched
  if (opts.restoreData && !plan.backupDir) {
    const refused = `no backup to restore: the update ran with --no-backup (plan ${plan.stamp}); drop --restore-data for a code-only rollback`;
    say(`Refusing to roll back: ${refused}`);
    return { ok: false, mode, lines, refused };
  }
  if (opts.restoreData && !existsSync(plan.backupDir!)) {
    const refused = `backup dir ${plan.backupDir} is gone; drop --restore-data for a code-only rollback`;
    say(`Refusing to roll back: ${refused}`);
    return { ok: false, mode, lines, refused };
  }
  if (!opts.restoreData) {
    const check = schemaRollbackCheck(plan.schema, readDbSchemaVersion(dbPath), opts.breaking);
    if (!check.ok) {
      say(`Refusing a code-only rollback: ${check.line}`);
      say(`  restore the pre-update backup instead: engram update --rollback ${plan.stamp} --restore-data${plan.backupDir ? ` (backup: ${plan.backupDir})` : " — but this update ran with --no-backup, so stay on the current version"}`);
      return { ok: false, mode, lines, refused: check.line };
    }
    say(check.line);
  }

  say(`rollback mode: ${mode} — ${opts.restoreData ? `restoring ${plan.backupDir}; everything written to the database since the update is discarded` : "engram.db keeps everything written since the update"}${opts.reason ? ` (reason: ${opts.reason})` : ""}`);
  say(`  ${MODEL_CACHE_BACKUP_NOTE}`);
  say(`target: ${inst.kind === "git" ? `git checkout ${inst.headSha ?? "<previous sha>"} in ${inst.root}` : `${inst.packageName}@${inst.version}`} (from ${plan.target ?? "the updated build"})`);
  const record = (ok: boolean) => {
    try { writeRollbackPlan(plan.dataDir, { ...plan, rolledBack: { at: deps.now().toISOString(), mode, ok, reason: opts.reason } }); } catch (err) { say(`  !! could not update ${file}: ${err instanceof Error ? err.message : String(err)}`); }
  };
  const wasRunning = plan.services;

  // 1. stop whatever runs now
  const live = await listServices(sdeps);
  const runningNow = live.filter((s) => s.running);
  const stopped = await stopServicesInOrder(runningNow, sdeps, say);
  if (!stopped.ok) { say(`  !! aborting before anything changed (${stopped.failed} is still up)`); record(false); return { ok: false, mode, lines }; }
  if (runningNow.length === 0) say("no running services to stop");

  const fail = async (what: string): Promise<RollbackResult> => {
    say("");
    say(`ROLLBACK FAILED at ${what}.`);
    for (const l of await restartAfterFailure(wasRunning, sdeps)) say(l);
    say("Manual steps:");
    for (const l of manualRollbackSteps(plan)) say(`  ${l}`);
    record(false);
    return { ok: false, mode, lines };
  };

  // 2. data (only with --restore-data / verified loss)
  if (opts.restoreData) {
    say(`restoring ${plan.backupDir} -> ${plan.dataDir}`);
    try { for (const l of restoreDataDir(plan.backupDir!, plan.dataDir)) say(l); } catch (err) { say(`  !! restore failed: ${err instanceof Error ? err.message : String(err)}`); return fail("data restore"); }
  }

  // 3. code
  const env: NodeJS.ProcessEnv = { ...sdeps.env };
  if (plan.modelCacheDir) env.ENGRAM_MODEL_CACHE_DIR = plan.modelCacheDir;
  if (inst.kind === "git") {
    if (!inst.headSha) { say("  !! the plan recorded no git sha to check out"); return fail("code"); }
    say(`git -C ${inst.root} checkout ${inst.headSha}`);
    const co = await exec("git", ["-C", inst.root, "checkout", inst.headSha]);
    if (co.status !== 0) { say(`  !! git checkout failed: ${(co.stderr || co.stdout).trim()}`); return fail("git checkout"); }
    say("npm ci (rebuilds dist/)");
    const ci = await exec("npm", ["ci"], { cwd: inst.root, env });
    if (ci.status !== 0) { say(`  !! npm ci failed: ${(ci.stderr || ci.stdout).trim().split("\n").slice(-10).join("\n")}`); return fail("npm ci"); }
    say(`  the checkout is detached at ${inst.headSha}${inst.branch && inst.branch !== "HEAD" ? `; \`git -C ${inst.root} checkout ${inst.branch}\` returns to the branch (and to the updated code)` : ""}`);
  } else {
    const spec = `${inst.packageName}@${inst.version}`;
    say(`npm install -g ${spec}`);
    const r = await exec("npm", ["install", "-g", spec], { env });
    if (r.status !== 0) { say(`  !! npm install failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-10).join("\n")}`); return fail("npm install"); }
  }

  // 4. migrate with the restored build (a child process, never a lazy import)
  const installInfo: InstallInfo = { kind: inst.kind, root: inst.root, version: inst.version, packageName: inst.packageName, branch: inst.branch, headSha: inst.headSha };
  const cli = deps.cliScript(installInfo);
  say("engram migrate schema (restored build)");
  const mig = await exec(deps.node, [cli, "migrate", "schema"], { env });
  if (mig.status !== 0) { say(`  !! migrate failed: ${(mig.stderr || mig.stdout).trim()}`); return fail("migrate"); }
  for (const l of mig.stdout.trim().split("\n").filter(Boolean)) say(`  ${l}`);

  // 5. restart what was running before the update — and anything that was
  //    running just now (a supervisor may have started something since), so
  //    the machine never ends up with fewer services than it had
  const ids = [...new Set([...wasRunning, ...runningNow].map((s) => s.id))];
  const toStart = ids.map((id) => live.find((s) => s.id === id) ?? wasRunning.find((s) => s.id === id)!);
  const started = await startServicesInOrder(toStart, sdeps, say);
  if (!started.ok) return fail(`start ${started.failed}`);
  if (toStart.length === 0) say("no services to start");

  // 6. verify with the restored build
  const ver = await exec(deps.node, [cli, "--version"], { env });
  const version = ver.stdout.trim().split(/\s+/).at(-1) ?? "";
  const versionOk = ver.status === 0 && version === inst.version;
  say(`version: ${version || "(unreadable)"}${versionOk ? "" : ` — expected ${inst.version}`}`);
  const v = await verifyBuild({ cli, env, running: toStart, before: plan.snapshot }, deps, say);
  const ok = v.ok && versionOk;
  say("");
  if (ok) say(`rolled back to ${inst.version} (${mode}); verification passed`);
  else {
    say(`ROLLBACK VERIFICATION FAILED (${mode}): ${[!versionOk && "version", !v.doctorOk && "doctor", v.healthOk === false && "health", v.regressions.length && "counts", !v.after && "stats"].filter(Boolean).join(", ")}`);
    say("Manual steps:");
    for (const l of manualRollbackSteps(plan)) say(`  ${l}`);
  }
  record(ok);
  return { ok, mode, lines };
}
