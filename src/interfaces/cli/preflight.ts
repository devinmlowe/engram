/**
 * Typed bridge to `scripts/preflight.cjs`, the dependency-free install
 * preflight (#63). The script is the single source of truth for the native
 * prebuild matrix and the probe heuristics; `engram preflight` and `engram
 * doctor` load it here instead of re-implementing them. It ships in the npm
 * package (`files` in package.json), so PACKAGE_ROOT resolves it from both a
 * checkout and a global install.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../../_core/version/index.js";

export type PrebuildStatus = "prebuilt" | "compiled" | "will-compile" | "unsupported" | "unknown";
export type PreflightLevel = "ok" | "warn" | "fail" | "skip";

export interface PreflightTarget {
  platform: string;
  arch: string;
  /** `glibc` | `musl` on Linux, empty elsewhere. */
  libc: string;
  /** NODE_MODULE_VERSION (`process.versions.modules`); printed, never decisive — every native dependency is N-API. */
  abi: number;
  /** prebuild-install target string, e.g. `linuxmusl-x64`. */
  key: string;
}

export interface PrebuildProbe {
  dep: string;
  status: PrebuildStatus;
  /** Human form of `status`: `prebuilt`, `compiled locally`, `will compile (…)`, `unsupported`, `unknown`. */
  label: string;
  level: PreflightLevel;
  /** `installed` when node_modules/<dep> was inspected, `static` when the table answered. */
  source: "installed" | "static";
  target?: string;
  abi?: number;
  detail: string;
  /** `fix: ...` / `or: ...` lines for warn/fail verdicts. */
  fix: string[];
  location?: string;
}

export interface PreflightResult {
  node: string;
  minNodeMajor: number;
  target: PreflightTarget;
  deps: PrebuildProbe[];
  loads: Array<{ dep: string; ok: boolean; error?: string }>;
  failed: number;
  warned: number;
  ok: boolean;
  lines: string[];
}

export interface NativeDepSpec {
  name: string;
  via: string;
  /** prebuild-install target strings the pinned range publishes a binary for. */
  targets: string[];
  /** Whether a node-gyp source build is a fallback (better-sqlite3) or the target is simply unsupported. */
  compiles: boolean;
}

export interface ProbeOptions {
  root?: string;
  platform?: string;
  arch?: string;
  libc?: string;
  abi?: number;
  env?: Record<string, string | undefined>;
}

export interface PreflightModule {
  preflight(opts?: ProbeOptions): PreflightResult;
  toJson(result: PreflightResult): Omit<PreflightResult, "lines">;
  /** `dep` is a NATIVE_DEPS name. */
  probePrebuild(dep: string, opts?: ProbeOptions): PrebuildProbe;
  resolveTarget(opts?: ProbeOptions): PreflightTarget;
  describeStatus(status: PrebuildStatus): string;
  checkExpectations(result: PreflightResult, spec: string): string[];
  NATIVE_DEPS: NativeDepSpec[];
  PREBUILT_TARGETS: string[];
  MIN_NODE_MAJOR: number;
}

/** Absolute path of the CommonJS preflight script. */
export const PREFLIGHT_SCRIPT: string = join(PACKAGE_ROOT, "scripts", "preflight.cjs");

const require = createRequire(import.meta.url);

/** Load (and cache, via the CJS module cache) the preflight script. */
export function loadPreflight(): PreflightModule {
  return require(PREFLIGHT_SCRIPT) as PreflightModule;
}

const script = loadPreflight();

/** Re-exported from the script so doctor, tests and docs share one matrix. */
export const PREBUILT_TARGETS: readonly string[] = script.PREBUILT_TARGETS;
export const MIN_NODE_MAJOR: number = script.MIN_NODE_MAJOR;

/**
 * `prebuilt — …` / `compiled locally — …` / `unknown — …` suffix for a doctor
 * line, with the probe's fix hints when it has any.
 */
export function describePrebuild(probe: PrebuildProbe): string {
  const hints = probe.fix.length > 0 ? `; ${probe.fix.join("; ")}` : "";
  return `${probe.label} — ${probe.detail}${hints}`;
}
