/**
 * Daily cached version check (#65, the "Should"): the answer `engram update
 * --check` computes (git tag / npm dist-tag) is cached for 24 h at
 * `<data dir>/cache/update-check.json` and surfaced as ONE stderr line by a
 * few user-facing CLI commands and as `update: {current, available}` in the
 * MCP daemon's `/health`. Nothing here ever applies an update.
 *
 *   - `updateNotice(...)` is pure: it reads the cache and never touches the
 *     network, so `/health` and JSON outputs can call it freely.
 *   - `refreshUpdateCheck(...)` performs the network call only when the cache
 *     is missing or stale; a failed lookup is cached too (as `available: null`)
 *     so an offline machine retries once a day, not once a command.
 *   - `ENGRAM_NO_UPDATE_CHECK=1` disables the network call and the notice.
 *     An explicit `engram update --check` still asks (that is the user
 *     asking), but reuses a fresh cache entry.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGRAM_VERSION, PACKAGE_ROOT } from "../../_core/version/index.js";
import { compareSemver, detectInstall, latestAvailable, type AvailableVersion, type InstallInfo, type InstallKind } from "./install-kind.js";
import type { Exec } from "./services.js";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
/** The lookup is a `git ls-remote` / `npm view`; never let it hold a CLI command longer than this. */
export const UPDATE_CHECK_TIMEOUT_MS = 6_000;
export const NO_UPDATE_CHECK_ENV = "ENGRAM_NO_UPDATE_CHECK";

export interface UpdateCheckCache {
  checkedAt: string;
  current: string;
  /** null when the lookup failed (see `error`). */
  available: string | null;
  kind: InstallKind;
  source: string;
  error?: string;
}

export function updateCheckCachePath(dataDir: string): string {
  return join(dataDir, "cache", "update-check.json");
}

/** True when the env var opts out (`1`, `true`, `yes`, anything but empty/`0`/`false`). */
export function updateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env[NO_UPDATE_CHECK_ENV]?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false" && v !== "no";
}

export function isFresh(entry: UpdateCheckCache, now: Date, ttlMs: number = UPDATE_CHECK_TTL_MS): boolean {
  const t = Date.parse(entry.checkedAt);
  return Number.isFinite(t) && now.getTime() - t >= 0 && now.getTime() - t < ttlMs;
}

/** The cached entry, or null when missing / unreadable / stale / recorded by another version. */
export function readUpdateCheckCache(dataDir: string, now: Date = new Date(), current: string = ENGRAM_VERSION): UpdateCheckCache | null {
  const file = updateCheckCachePath(dataDir);
  if (!existsSync(file)) return null;
  try {
    const entry = JSON.parse(readFileSync(file, "utf-8")) as UpdateCheckCache;
    if (typeof entry.checkedAt !== "string" || typeof entry.current !== "string") return null;
    if (entry.current !== current) return null; // an upgrade happened since; the answer is about another version
    return isFresh(entry, now) ? entry : null;
  } catch {
    return null;
  }
}

export function writeUpdateCheckCache(dataDir: string, entry: UpdateCheckCache): string {
  const file = updateCheckCachePath(dataDir);
  mkdirSync(join(dataDir, "cache"), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

export interface RefreshDeps {
  dataDir: string;
  exec: Exec;
  packageRoot?: string;
  version?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Per-call timeout for the network lookup (`UPDATE_CHECK_TIMEOUT_MS`). */
  timeoutMs?: number;
}

export interface RefreshResult {
  install: InstallInfo;
  available: AvailableVersion;
  entry: UpdateCheckCache;
  /** True when the answer came from the cache and no network call was made. */
  cached: boolean;
}

/**
 * The answer to "is there a newer engram?", from the cache when it is fresh,
 * from the network otherwise (then cached). With `force`, a cached FAILURE
 * (`available: null`) is retried — what an explicit `--check` wants — while a
 * cached success is still reused. Never throws: a failed lookup is an entry
 * with `available: null` and `error`.
 */
export async function refreshUpdateCheck(deps: RefreshDeps, opts: { force?: boolean } = {}): Promise<RefreshResult> {
  const now = deps.now ?? (() => new Date());
  const version = deps.version ?? ENGRAM_VERSION;
  const install = await detectInstall({ exec: deps.exec, packageRoot: deps.packageRoot ?? PACKAGE_ROOT, version });
  const cached = readUpdateCheckCache(deps.dataDir, now(), version);
  if (cached && (cached.available !== null || !opts.force)) {
    return { install, available: { version: cached.available, source: cached.source, error: cached.error }, entry: cached, cached: true };
  }
  const timeoutMs = deps.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const exec: Exec = (cmd, args, o) => deps.exec(cmd, args, { ...o, timeoutMs });
  const available = await latestAvailable(install, exec);
  const entry: UpdateCheckCache = {
    checkedAt: now().toISOString(),
    current: version,
    available: available.version,
    kind: install.kind,
    source: available.source,
    ...(available.error ? { error: available.error } : {}),
  };
  try { writeUpdateCheckCache(deps.dataDir, entry); } catch { /* a read-only data dir just means no caching */ }
  return { install, available, entry, cached: false };
}

/** The one-line notice, or null when nothing newer is known or the check is disabled. Pure: cache only. */
export function updateNoticeFor(entry: UpdateCheckCache | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!entry || !entry.available || updateCheckDisabled(env)) return null;
  if (compareSemver(entry.available, entry.current) <= 0) return null;
  return `engram ${entry.available} available (you have ${entry.current}) — engram update`;
}

/** `updateNoticeFor` over the cache at `dataDir`. */
export function updateNotice(config: { dataDir: string }, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string | null {
  if (updateCheckDisabled(env)) return null;
  return updateNoticeFor(readUpdateCheckCache(config.dataDir, now), env);
}

/**
 * What the CLI's user-facing commands call once, at the end: refresh the
 * cache if stale (bounded by the exec timeout; disabled by the env var) and
 * return the notice to print. Never throws.
 */
export async function maybeUpdateNotice(deps: RefreshDeps): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (updateCheckDisabled(env)) return null;
  try {
    const r = await refreshUpdateCheck(deps);
    return updateNoticeFor(r.entry, env);
  } catch {
    return null;
  }
}

/** The `update` field of the daemon's `/health` JSON: cache only, never the network. */
export function updateHealthField(dataDir: string, now: Date = new Date(), current: string = ENGRAM_VERSION): { current: string; available: string | null; checkedAt: string | null } {
  const entry = readUpdateCheckCache(dataDir, now, current);
  return { current, available: entry?.available ?? null, checkedAt: entry?.checkedAt ?? null };
}
