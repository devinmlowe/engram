/**
 * Which `engram` does the shell run, and is it the install `engram update`
 * upgrades? (#65) Two global trees — Homebrew's node and nvm's node each with
 * a `bin/engram` — are the classic failure: `npm i -g` upgrades one tree while
 * PATH keeps resolving `engram` to the other, and the user reports "I updated
 * but `engram --version` is old". Pure: PATH, the filesystem probes and the
 * running script are injected so tests stage any layout in a temp dir.
 */
import { existsSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { PACKAGE_NAME, PACKAGE_ROOT } from "../../_core/version/index.js";

export interface InstallPathContext {
  /** The script this process runs (`process.argv[1]`). */
  argv1: string;
  /** The install root `engram update` upgrades (`PACKAGE_ROOT`, what `detectInstall` resolves). */
  packageRoot: string;
  path: string;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
  /** Resolve symlinks; may throw for a dangling one (treated as unresolvable). */
  realpath: (p: string) => string;
  /** First bytes of a file, for shim scripts (`exec node …/dist/interfaces/cli/index.js`, npm's `.cmd` shims). */
  readHead?: (p: string) => string;
  packageName?: string;
}

export interface EngramBinary {
  /** The PATH entry joined with the binary name, as the shell would find it. */
  path: string;
  /** Symlinks resolved, or the CLI script a shim runs; equal to `path` when resolution fails. */
  real: string;
  /** Sits inside `packageRoot` (this install). */
  thisInstall: boolean;
}

export interface InstallPathReport {
  /** Every `engram` on PATH, in PATH order, one entry per distinct real path. */
  binaries: EngramBinary[];
  /** realpath of the running script. */
  running: string;
  packageRoot: string;
  /** `ok` when at most one distinct engram is on PATH and it (if any) is this install. */
  ok: boolean;
  detail: string;
  fix: string | null;
}

function readHeadSync(p: string): string {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function defaultInstallPathContext(overrides: Partial<InstallPathContext> = {}): InstallPathContext {
  return {
    argv1: process.argv[1] ?? "",
    packageRoot: PACKAGE_ROOT,
    path: process.env.PATH ?? "",
    platform: process.platform,
    exists: existsSync,
    realpath: realpathSync,
    readHead: readHeadSync,
    packageName: PACKAGE_NAME,
    ...overrides,
  };
}

function safeReal(ctx: InstallPathContext, p: string): string {
  try { return ctx.realpath(p); } catch { return resolve(p); }
}

const CLI_SCRIPT_RE = /([^\s"'`]*dist[\\/]interfaces[\\/]cli[\\/]index\.js)/;

/**
 * A wrapper script instead of a symlink: a hand-written `exec node
 * <checkout>/dist/interfaces/cli/index.js "$@"`, or npm's `engram.cmd` /
 * `engram` sh shim on Windows (`%~dp0\node_modules\<pkg>\dist\…`). The CLI
 * script it names is what really runs, so that is what gets compared.
 */
function shimTarget(ctx: InstallPathContext, shim: string): string | null {
  if (!ctx.readHead) return null;
  let head: string;
  try { head = ctx.readHead(shim); } catch { return null; }
  if (head.includes("\0")) return null; // a binary, not a script
  const m = head.match(CLI_SCRIPT_RE);
  if (!m) return null;
  const dir = dirname(shim);
  let target = m[1].replace(/^%~dp0[\\/]?/i, `${dir}${sep}`).replace(/^\$basedir[\\/]?/, `${dir}${sep}`);
  if (!isAbsolute(target)) target = resolve(dir, target);
  return ctx.exists(target) ? safeReal(ctx, target) : target;
}

function isInside(file: string, root: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return file === root || file.startsWith(r);
}

/** Every `engram` (and `engram.cmd` / `engram.ps1` on Windows) on PATH, in PATH order, deduplicated by real path. */
export function findEngramBinaries(ctx: InstallPathContext): EngramBinary[] {
  const names = ctx.platform === "win32" ? ["engram.cmd", "engram.ps1", "engram"] : ["engram"];
  const root = safeReal(ctx, ctx.packageRoot);
  const seen = new Set<string>();
  const out: EngramBinary[] = [];
  for (const dir of ctx.path.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = join(dir, name);
      if (!ctx.exists(p)) continue;
      const linked = safeReal(ctx, p);
      const real = (linked === resolve(p) ? shimTarget(ctx, p) : null) ?? linked;
      // A Windows shim (`engram.cmd`) is not a symlink: it sits in the global
      // prefix next to `node_modules/<package>`, so judge by that tree instead.
      const shimRoot = ctx.platform === "win32" ? join(dir, "node_modules", ...(ctx.packageName ?? "").split("/")) : null;
      const thisInstall = isInside(real, root) || (shimRoot !== null && safeReal(ctx, shimRoot) === root);
      const key = ctx.platform === "win32" ? real.toLowerCase() : real;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: p, real, thisInstall });
    }
  }
  return out;
}

export function installPathReport(ctx: InstallPathContext = defaultInstallPathContext()): InstallPathReport {
  const binaries = findEngramBinaries(ctx);
  const running = safeReal(ctx, ctx.argv1);
  const packageRoot = safeReal(ctx, ctx.packageRoot);
  const pkg = ctx.packageName ?? PACKAGE_NAME;
  const list = binaries.map((b) => `${b.path}${b.real !== b.path ? ` -> ${b.real}` : ""}${b.thisInstall ? " (this install)" : ""}`);
  if (binaries.length === 0) {
    return { binaries, running, packageRoot, ok: true, detail: `no engram on PATH; running ${running} (install: ${packageRoot})`, fix: null };
  }
  const first = binaries[0];
  if (binaries.length === 1 && first.thisInstall) {
    return { binaries, running, packageRoot, ok: true, detail: `${first.path}${first.real !== first.path ? ` -> ${first.real}` : ""} is this install (${packageRoot})`, fix: null };
  }
  const others = binaries.filter((b) => !b.thisInstall);
  const otherTrees = others.map((b) => b.real.replace(/[\\/]dist[\\/].*$/, "").replace(/[\\/]bin[\\/]engram(\.cmd|\.ps1)?$/, ""));
  const fixes: string[] = [];
  if (others.length) fixes.push(`remove the other tree (${otherTrees.map((t) => `npm uninstall -g ${pkg} with the npm that owns ${t}`).join("; ")})`);
  fixes.push("or put this install's bin dir first on PATH");
  const fix = fixes.join(", ");
  const detail = first.thisInstall
    ? `${binaries.length} engram binaries on PATH: ${list.join(", ")} — \`engram\` runs this install, but the other tree keeps its own version; ${fix}`
    : `\`engram\` on PATH is not this install: ${list.join(", ")} (running ${running}; \`engram update\` upgrades ${packageRoot}, which \`engram\` will not run); ${fix}`;
  return { binaries, running, packageRoot, ok: false, detail, fix };
}
