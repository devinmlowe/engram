/**
 * How engram is installed on this machine (#44): a git checkout (updated with
 * `git pull` + `npm ci`) or a global npm install of `@devinmlowe/engram`
 * (updated with `npm install -g`). Also answers `engram update --check`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENGRAM_VERSION, PACKAGE_NAME, PACKAGE_ROOT } from "../../_core/version/index.js";
import type { Exec } from "./services.js";

export type InstallKind = "git" | "npm";

export interface InstallInfo {
  kind: InstallKind;
  /** Checkout root (git) or the installed package directory (npm). */
  root: string;
  version: string;
  packageName: string;
  /** git only */
  branch?: string;
  remote?: string;
  dirty?: boolean;
  headSha?: string;
}

export interface InstallDeps {
  exec: Exec;
  packageRoot?: string;
  version?: string;
}

export async function detectInstall({ exec, packageRoot = PACKAGE_ROOT, version = ENGRAM_VERSION }: InstallDeps): Promise<InstallInfo> {
  const base: InstallInfo = { kind: "npm", root: packageRoot, version, packageName: PACKAGE_NAME };
  if (!existsSync(join(packageRoot, ".git"))) return base;
  const branch = (await exec("git", ["-C", packageRoot, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || undefined;
  const remote = (await exec("git", ["-C", packageRoot, "remote", "get-url", "origin"])).stdout.trim() || undefined;
  const status = await exec("git", ["-C", packageRoot, "status", "--porcelain"]);
  const head = (await exec("git", ["-C", packageRoot, "rev-parse", "--short", "HEAD"])).stdout.trim() || undefined;
  return { ...base, kind: "git", branch, remote, dirty: status.stdout.trim().length > 0, headSha: head };
}

/** Numeric compare of `a` vs `b` (`1.10.0` > `1.9.0`); pre-release suffixes sort below the plain version. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre ?? "" };
  };
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export interface AvailableVersion {
  version: string | null;
  /** Where the answer came from, for the plan output. */
  source: string;
  error?: string;
}

/** Highest `vX.Y.Z` tag on origin (git) or `dist-tags.latest` on the registry (npm). */
export async function latestAvailable(info: InstallInfo, exec: Exec): Promise<AvailableVersion> {
  if (info.kind === "git") {
    const r = await exec("git", ["-C", info.root, "ls-remote", "--tags", "--refs", "origin"]);
    if (r.status !== 0) return { version: null, source: "git ls-remote --tags origin", error: (r.stderr || r.stdout).trim() };
    const tags = [...r.stdout.matchAll(/refs\/tags\/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/gm)].map((m) => m[1]);
    if (tags.length === 0) return { version: null, source: "git ls-remote --tags origin", error: "no version tags on origin" };
    tags.sort(compareSemver);
    return { version: tags.at(-1)!, source: "git ls-remote --tags origin" };
  }
  const r = await exec("npm", ["view", info.packageName, "dist-tags.latest"]);
  if (r.status !== 0) return { version: null, source: `npm view ${info.packageName} dist-tags.latest`, error: (r.stderr || r.stdout).trim() };
  const v = r.stdout.trim().split(/\s+/).at(-1) ?? "";
  return v ? { version: v, source: `npm view ${info.packageName} dist-tags.latest` } : { version: null, source: "npm view", error: "empty answer" };
}

export function formatCheck(info: InstallInfo, avail: AvailableVersion): string[] {
  const lines = [
    `engram ${info.version} (${info.kind === "git" ? `git checkout ${info.root}${info.branch ? ` on ${info.branch}` : ""}${info.dirty ? ", uncommitted changes" : ""}` : `npm install of ${info.packageName} at ${info.root}`})`,
  ];
  if (avail.version === null) {
    lines.push(`available: unknown — ${avail.source} failed: ${avail.error ?? "no answer"}`);
    return lines;
  }
  const cmp = compareSemver(avail.version, info.version);
  lines.push(`available: ${avail.version} (${avail.source})`);
  lines.push(cmp > 0 ? `update available: ${info.version} -> ${avail.version}. Run: engram update --plan` : cmp === 0 ? "up to date" : `installed version is ahead of ${avail.source}`);
  return lines;
}
