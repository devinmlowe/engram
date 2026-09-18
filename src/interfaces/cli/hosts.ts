/**
 * `engram mcp install|uninstall|status` (#50; decisions #51, #52): register
 * this engram install with the MCP hosts on the machine instead of asking the
 * user to hand-edit `~/.claude.json`.
 *
 *   claude  — user scope `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json`),
 *             project scope `.mcp.json`; `mcpServers.engram`
 *   codex   — `~/.codex/config.toml`, project `.codex/config.toml`;
 *             `[mcp_servers.engram]`
 *   cursor  — `~/.cursor/mcp.json`, project `.cursor/mcp.json`; `mcpServers.engram`
 *   hermes  — the Hermes memory-provider plugin, deployed with
 *             `interfaces/hermes-plugin/deploy.sh` to the same targets
 *             `engram update` redeploys to (no MCP JSON)
 *
 * Transport (#51): HTTP (`http://127.0.0.1:<port>/mcp`) when the daemon
 * answers `GET /health`, else stdio (`node <install>/dist/interfaces/cli/index.js
 * mcp`, which bridges to the daemon itself once one appears). `--transport`
 * overrides the probe.
 *
 * Token (#52): configs never carry the literal `ENGRAM_MCP_TOKEN`. When the
 * daemon runs with a token (the variable is set here, or in the service env
 * file the daemon sources) the entry references the variable with each host's
 * documented mechanism — Claude `${ENGRAM_MCP_TOKEN}` in `headers`, Codex
 * `bearer_token_env_var`, Cursor `${env:ENGRAM_MCP_TOKEN}` — and `mcp status`
 * reports whether the variable resolves where the host runs. `--inline-token`
 * writes the literal, with a warning and mode 600.
 *
 * Every file write is atomic (temp file + rename, mode preserved) with the
 * previous content kept at `<file>.bak`; unrelated keys, other servers and
 * formatting survive byte-for-byte (JSON is re-serialised with the file's own
 * indent and trailing-newline state; TOML is edited line-wise, replacing only
 * the `[mcp_servers.engram]` table and its sub-tables). Re-running is a no-op:
 * identical bytes, no `.bak` churn.
 *
 * Host config formats verified 2026-09-17 against code.claude.com/docs/en/mcp
 * (scopes, `${VAR}` expansion in `headers`; custom names outside the fixed
 * credential set expand), developers.openai.com/codex/mcp (+ config-reference:
 * `command`/`args`, `url`, `bearer_token_env_var`, `http_headers`) and
 * cursor.com/docs/mcp (`~/.cursor/mcp.json`, `${env:NAME}` in `headers`).
 */
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PACKAGE_NAME, PACKAGE_ROOT } from "../../_core/version/index.js";
import { MCP_TOKEN_ENV, resolveMcpToken } from "../mcp/auth.js";
import { DEFAULT_MCP_PORT, isEngramDaemonHealth, parseMcpPort, probeMcpHealth, type McpHealthProbe } from "../mcp/port.js";
import { serviceEnvFile } from "./data-migration.js";
import { realExec, type Exec } from "./services.js";
import { pluginDeployTargets } from "./update.js";

export const HOST_IDS = ["claude", "codex", "cursor", "hermes"] as const;
export type HostId = (typeof HOST_IDS)[number];
export type Transport = "http" | "stdio";
export type HostScope = "user" | "project";
/** The server name every host registers engram under. */
export const SERVER_NAME = "engram";

export const HOST_LABELS: Record<HostId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor",
  hermes: "Hermes Agent",
};

export interface HostContext {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Where this engram lives: git checkout root or the installed package dir. */
  packageRoot: string;
  /** The node binary stdio entries run (`process.execPath`). */
  node: string;
  /** `HERMES_HOME` (default `~/.hermes`). */
  hermesHome: string;
}

export function defaultHostContext(overrides: Partial<HostContext> = {}): HostContext {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? homedir();
  return {
    home,
    cwd: overrides.cwd ?? process.cwd(),
    env,
    platform: overrides.platform ?? process.platform,
    packageRoot: overrides.packageRoot ?? PACKAGE_ROOT,
    node: overrides.node ?? process.execPath,
    hermesHome: overrides.hermesHome ?? (env.HERMES_HOME?.trim() || env.HERMES_ROOT?.trim() || join(home, ".hermes")),
  };
}

function isHostId(s: string): s is HostId {
  return (HOST_IDS as readonly string[]).includes(s);
}

/** Validate a `<host>` argument; throws with the list of known hosts. */
export function parseHostId(raw: string): HostId {
  const id = raw.trim().toLowerCase();
  if (isHostId(id)) return id;
  throw new Error(`unknown host "${raw}": expected one of ${HOST_IDS.join(", ")}`);
}

// ─── paths ───────────────────────────────────────────────────────────

/** `~/.claude`, or `CLAUDE_CONFIG_DIR` when set (plugins live under it). */
export function claudeConfigDir(ctx: HostContext): string {
  return ctx.env.CLAUDE_CONFIG_DIR?.trim() || join(ctx.home, ".claude");
}

/** The stdio entry point every host config points at: the installed CLI + `mcp`. */
export function installedCliScript(ctx: HostContext): string {
  return join(ctx.packageRoot, "dist", "interfaces", "cli", "index.js");
}

export function hostConfigPath(id: HostId, ctx: HostContext, scope: HostScope): string {
  if (scope === "project") {
    switch (id) {
      case "claude": return join(ctx.cwd, ".mcp.json");
      case "codex": return join(ctx.cwd, ".codex", "config.toml");
      case "cursor": return join(ctx.cwd, ".cursor", "mcp.json");
      case "hermes": throw new Error("hermes has no project scope: the plugin is deployed per Hermes home/profile");
    }
  }
  switch (id) {
    case "claude": return ctx.env.CLAUDE_CONFIG_DIR?.trim() ? join(ctx.env.CLAUDE_CONFIG_DIR.trim(), ".claude.json") : join(ctx.home, ".claude.json");
    case "codex": return join(ctx.home, ".codex", "config.toml");
    case "cursor": return join(ctx.home, ".cursor", "mcp.json");
    case "hermes": return join(ctx.hermesHome, "plugins", SERVER_NAME);
  }
}

/** The directory whose presence means the host is installed on this machine (`--all`). */
export function hostConfigDir(id: HostId, ctx: HostContext): string {
  switch (id) {
    case "claude": return claudeConfigDir(ctx);
    case "codex": return join(ctx.home, ".codex");
    case "cursor": return join(ctx.home, ".cursor");
    case "hermes": return ctx.hermesHome;
  }
}

export function hostPresent(id: HostId, ctx: HostContext): boolean {
  if (existsSync(hostConfigDir(id, ctx))) return true;
  return id === "claude" && existsSync(hostConfigPath("claude", ctx, "user"));
}

/** Print paths under the home directory as `~/...`. */
export function tildify(path: string, home: string): string {
  if (!home) return path;
  const h = home.replace(/[\\/]+$/, "");
  if (path === h) return "~";
  if (path.startsWith(h + "/") || path.startsWith(h + "\\")) return "~" + path.slice(h.length);
  return path;
}

// ─── transport decision (#51) ─────────────────────────────────────────

export type HealthProbe = (port: number, timeoutMs: number) => Promise<McpHealthProbe>;

export interface TransportDecision {
  transport: Transport;
  port: number;
  url: string;
  /** Human sentence: why this transport. */
  reason: string;
  /** null when the probe was skipped (`--transport stdio`). */
  daemonHealthy: boolean | null;
}

function errShort(err: unknown): string {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  if (typeof code === "string" && code) return code;
  return err instanceof Error ? err.message : String(err);
}

export const DAEMON_INSTALL_HINT = "scripts/install-mcp-daemon.sh install (Windows: scripts\\install-mcp-daemon.ps1 install)";

export async function decideTransport(opts: {
  env: NodeJS.ProcessEnv;
  override?: Transport;
  probe?: HealthProbe;
  timeoutMs?: number;
}): Promise<TransportDecision> {
  const { env, override, probe = probeMcpHealth, timeoutMs = 1500 } = opts;
  const port = parseMcpPort(env.ENGRAM_MCP_PORT, DEFAULT_MCP_PORT);
  const url = `http://127.0.0.1:${port}/mcp`;
  if (override === "stdio") {
    return { transport: "stdio", port, url, reason: "--transport stdio (engram mcp bridges to the daemon when one is healthy)", daemonHealthy: null };
  }
  let healthy = false;
  let why: string;
  try {
    const health = await probe(port, timeoutMs);
    healthy = isEngramDaemonHealth(health);
    why = healthy ? `daemon answered /health on :${port}` : `something answers on :${port} but not like the engram daemon (HTTP ${health.status})`;
  } catch (err) {
    why = `no daemon on :${port} (${errShort(err)})`;
  }
  if (override === "http") {
    return {
      transport: "http", port, url, daemonHealthy: healthy,
      reason: healthy ? `--transport http; ${why}` : `--transport http; ${why} — the host cannot connect until one runs: ${DAEMON_INSTALL_HINT}`,
    };
  }
  if (healthy) return { transport: "http", port, url, reason: why, daemonHealthy: true };
  return { transport: "stdio", port, url, daemonHealthy: false, reason: `${why} — stdio; engram mcp will bridge when one appears` };
}

// ─── token (#52) ─────────────────────────────────────────────────────

export interface DaemonToken {
  /** Where the daemon's token was found; null = the daemon runs without one. */
  source: "env" | "env-file" | null;
  value?: string;
  /** The service env file that was consulted. */
  file: string;
}

/** `NAME=value` / `export NAME="value"` from a shell env file; undefined when absent or blank. */
export function readEnvFileVar(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return undefined; }
  let found: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] !== name) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    found = v; // last assignment wins, like a shell
  }
  return found?.trim() ? found.trim() : undefined;
}

/** Is the daemon configured with `ENGRAM_MCP_TOKEN` — here, or in the env file it sources? */
export function daemonToken(ctx: HostContext): DaemonToken {
  const file = serviceEnvFile(ctx.env, ctx.home);
  const fromEnv = resolveMcpToken(ctx.env);
  if (fromEnv) return { source: "env", value: fromEnv, file };
  const fromFile = readEnvFileVar(file, MCP_TOKEN_ENV);
  if (fromFile) return { source: "env-file", value: fromFile, file };
  return { source: null, file };
}

// ─── the entry ───────────────────────────────────────────────────────

export type EntryAuth =
  | { mode: "none" }
  | { mode: "env-ref"; envVar: string }
  | { mode: "inline"; token: string };

export interface EngramEntry {
  transport: Transport;
  port: number;
  /** HTTP endpoint (set for both transports: the stdio bridge targets it too). */
  url: string;
  /** stdio */
  command: string;
  args: string[];
  auth: EntryAuth;
}

export function buildEntry(decision: TransportDecision, ctx: HostContext, opts: { token: DaemonToken; inlineToken?: boolean }): EngramEntry {
  const args = [installedCliScript(ctx), "mcp"];
  if (decision.port !== DEFAULT_MCP_PORT) args.push("--port", String(decision.port));
  let auth: EntryAuth = { mode: "none" };
  if (decision.transport === "http" && opts.token.source) {
    auth = opts.inlineToken && opts.token.value ? { mode: "inline", token: opts.token.value } : { mode: "env-ref", envVar: MCP_TOKEN_ENV };
  }
  return { transport: decision.transport, port: decision.port, url: decision.url, command: ctx.node, args, auth };
}

/** Each host's documented way to reference an environment variable for the bearer token. */
export const TOKEN_REFERENCE: Record<HostId, string | null> = {
  claude: "${ENGRAM_MCP_TOKEN} in headers",
  codex: 'bearer_token_env_var = "ENGRAM_MCP_TOKEN"',
  cursor: "${env:ENGRAM_MCP_TOKEN} in headers",
  hermes: null, // engram.json carries `token` (mode 600); printed as a manual step
};

type JsonObject = Record<string, unknown>;

export function renderJsonEntry(id: "claude" | "cursor", e: EngramEntry): JsonObject {
  if (e.transport === "stdio") {
    return id === "claude" ? { type: "stdio", command: e.command, args: e.args } : { command: e.command, args: e.args };
  }
  const out: JsonObject = id === "claude" ? { type: "http", url: e.url } : { url: e.url };
  if (e.auth.mode === "env-ref") out.headers = { Authorization: `Bearer ${id === "claude" ? "${" : "${env:"}${e.auth.envVar}}` };
  else if (e.auth.mode === "inline") out.headers = { Authorization: `Bearer ${e.auth.token}` };
  return out;
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Body lines of `[mcp_servers.engram]` (no header). */
export function renderTomlEntry(e: EngramEntry): string[] {
  if (e.transport === "stdio") return [`command = ${tomlString(e.command)}`, `args = [${e.args.map(tomlString).join(", ")}]`];
  const lines = [`url = ${tomlString(e.url)}`];
  if (e.auth.mode === "env-ref") lines.push(`bearer_token_env_var = ${tomlString(e.auth.envVar)}`);
  else if (e.auth.mode === "inline") lines.push(`http_headers = { Authorization = ${tomlString(`Bearer ${e.auth.token}`)} }`);
  return lines;
}

// ─── JSON writer (claude, cursor) ────────────────────────────────────

function detectIndent(text: string): string {
  const m = text.match(/^[{[]\r?\n([ \t]+)\S/);
  return m ? m[1] : "  ";
}

/** Parse a JSON config file; a malformed file is an error (never clobbered). */
export function parseJsonConfig(text: string, path: string): JsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) {
    throw new Error(`${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it by hand before engram edits it`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} does not hold a JSON object`);
  return parsed as JsonObject;
}

/**
 * Set (or with `entry === null` remove) `mcpServers.<name>` in a JSON config,
 * keeping every other key, the key order, the file's indent and whether it
 * ended with a newline. A missing file becomes `{ "mcpServers": { ... } }`.
 */
export function upsertJsonServer(text: string | null, name: string, entry: JsonObject | null, path = "config"): string {
  if (text === null || text.trim() === "") {
    if (entry === null) return text ?? "";
    return JSON.stringify({ mcpServers: { [name]: entry } }, null, 2) + "\n";
  }
  const obj = parseJsonConfig(text, path);
  const indent = detectIndent(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = /\r?\n$/.test(text);
  const servers = obj.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`${path}: "mcpServers" is not an object`);
  }
  const map = (servers as JsonObject | undefined) ?? {};
  if (entry === null) delete map[name];
  else map[name] = entry;
  if (servers === undefined) {
    if (entry === null) return text;
    obj.mcpServers = map;
  }
  let out = JSON.stringify(obj, null, indent);
  if (eol !== "\n") out = out.replace(/\n/g, eol);
  return trailingNewline ? out + eol : out;
}

// ─── TOML table writer (codex) ───────────────────────────────────────

const TABLE_HEADER_RE = /^\s*(\[\[?)\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/;

/** `mcp_servers."engram"` → `mcp_servers.engram`. */
function normaliseTableName(raw: string): string {
  return raw.split(".").map((seg) => seg.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")).join(".");
}

function parseTableHeader(line: string): { name: string; array: boolean } | null {
  const m = line.match(TABLE_HEADER_RE);
  if (!m) return null;
  return { name: normaliseTableName(m[2]), array: m[1] === "[[" };
}

interface TomlRegion { start: number; end: number; } // [start, end) line indexes, header included

/** Regions of `table` and its sub-tables (`table.x`), each ending at the last non-blank line before the next header. */
function findTomlRegions(lines: string[], table: string): TomlRegion[] {
  const regions: TomlRegion[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = parseTableHeader(lines[i]);
    if (!h || (h.name !== table && !h.name.startsWith(table + "."))) continue;
    let end = i + 1;
    while (end < lines.length && !parseTableHeader(lines[end])) end++;
    while (end > i + 1 && lines[end - 1].trim() === "") end--;
    regions.push({ start: i, end });
    i = end - 1;
  }
  return regions;
}

/**
 * Replace (or with `body === null` remove) the `[<table>]` table — and any
 * `[<table>.*]` sub-table — in a TOML file, touching no other line. Dotted
 * forms (`engram = { ... }` under `[mcp_servers]`, `mcp_servers.engram.url`
 * at the root) are removed too, so the file never ends up defining the
 * server twice. A new table is appended at the end of the file.
 */
export function upsertTomlTable(text: string | null, table: string, body: string[] | null): string {
  const eol = text?.includes("\r\n") ? "\r\n" : "\n";
  const header = `[${table}]`;
  const block = body === null ? [] : [header, ...body];
  if (text === null || text.trim() === "") {
    if (body === null) return text ?? "";
    return block.join(eol) + eol;
  }
  const hadTrailingNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();

  const dot = table.lastIndexOf(".");
  const parent = dot >= 0 ? table.slice(0, dot) : "";
  const leaf = dot >= 0 ? table.slice(dot + 1) : table;
  const leafRe = `(?:${leaf}|"${leaf}"|'${leaf}')`;
  const rootDotted = new RegExp(`^\\s*${table.split(".").map((s) => `(?:${s}|"${s}"|'${s}')`).join("\\.")}(?:\\.|\\s*=)`);
  const parentDotted = new RegExp(`^\\s*${leafRe}(?:\\.|\\s*=)`);

  // 1. drop dotted-key definitions (root or inside the parent table)
  let current = "";
  const kept: string[] = [];
  for (const line of lines) {
    const h = parseTableHeader(line);
    if (h) { current = h.name; kept.push(line); continue; }
    if (current === "" && rootDotted.test(line)) continue;
    if (parent && current === parent && parentDotted.test(line)) continue;
    kept.push(line);
  }

  // 2. replace the table region(s)
  const regions = findTomlRegions(kept, table);
  let out: string[];
  if (regions.length === 0) {
    out = kept.slice();
    if (body !== null) {
      while (out.length && out[out.length - 1].trim() === "") out.pop();
      if (out.length) out.push("");
      out.push(...block);
    }
  } else {
    out = [];
    let cursor = 0;
    let inserted = false;
    for (const r of regions) {
      let start = r.start;
      // removing: also take one preceding blank line when the region sat between blank lines (or before EOF)
      if (body === null && start > cursor && kept[start - 1].trim() === "" && (r.end >= kept.length || kept[r.end].trim() === "")) start--;
      out.push(...kept.slice(cursor, start));
      if (!inserted && body !== null) { out.push(...block); inserted = true; }
      cursor = r.end;
    }
    out.push(...kept.slice(cursor));
  }
  const result = out.join(eol);
  if (result === "") return "";
  return hadTrailingNewline || body !== null ? result + eol : result;
}

/** The `key = value` pairs of one `[<table>]` table (strings, string arrays, inline tables of strings); enough for `status`. */
export function readTomlTable(text: string, table: string): Record<string, string | string[] | Record<string, string>> | null {
  const lines = text.split(/\r?\n/);
  const regions = findTomlRegions(lines, table).filter((r) => parseTableHeader(lines[r.start])?.name === table);
  if (regions.length === 0) return null;
  const out: Record<string, string | string[] | Record<string, string>> = {};
  const str = (v: string): string | null => {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"$/) ?? v.match(/^'([^']*)'$/);
    if (!m) return null;
    return v.startsWith('"') ? m[1].replace(/\\(["\\n])/g, (_, c: string) => (c === "n" ? "\n" : c)) : m[1];
  };
  for (const r of regions) {
    for (const line of lines.slice(r.start + 1, r.end)) {
      const m = line.match(/^\s*([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1].replace(/^"(.*)"$/, "$1");
      const value = m[2].replace(/\s+#.*$/, "");
      const s = str(value);
      if (s !== null) { out[key] = s; continue; }
      if (value.startsWith("[") && value.endsWith("]")) {
        const items = [...value.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((x) => (x[1] !== undefined ? x[1].replace(/\\(["\\])/g, "$1") : x[2]));
        out[key] = items;
        continue;
      }
      if (value.startsWith("{") && value.endsWith("}")) {
        const inline: Record<string, string> = {};
        for (const kv of value.slice(1, -1).matchAll(/([A-Za-z0-9_-]+|"[^"]*")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) {
          inline[kv[1].replace(/^"(.*)"$/, "$1")] = str(kv[2]) ?? kv[2];
        }
        out[key] = inline;
      }
    }
  }
  return out;
}

// ─── unified diff (no dependency) ────────────────────────────────────

type DiffOp = { op: " " | "-" | "+"; line: string };

/** Edit script for `a` → `b`: common prefix/suffix stripped, LCS on the middle (bounded; large middles fall back to replace-all). */
function diffLines(a: string[], b: string[]): DiffOp[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const ops: DiffOp[] = a.slice(0, p).map((line) => ({ op: " ", line }));
  if (am.length * bm.length > 4_000_000) {
    ops.push(...am.map((line) => ({ op: "-" as const, line })), ...bm.map((line) => ({ op: "+" as const, line })));
  } else {
    const n = am.length, m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ op: " ", line: am[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: "-", line: am[i] }); i++; }
      else { ops.push({ op: "+", line: bm[j] }); j++; }
    }
    while (i < n) ops.push({ op: "-", line: am[i++] });
    while (j < m) ops.push({ op: "+", line: bm[j++] });
  }
  ops.push(...a.slice(a.length - s).map((line) => ({ op: " " as const, line })));
  return ops;
}

/** A unified diff of two texts (`null` = absent file), `context` lines around each change; empty string when equal. */
export function unifiedDiff(before: string | null, after: string, label: string, context = 3): string {
  if (before === after) return "";
  const split = (t: string) => (t === "" ? [] : t.replace(/\r?\n$/, "").split(/\r?\n/));
  const a = before === null ? [] : split(before);
  const b = split(after);
  const ops = diffLines(a, b);
  const out: string[] = [`--- ${before === null ? "/dev/null" : label}`, `+++ ${label}`];
  let idx = 0;
  while (idx < ops.length) {
    while (idx < ops.length && ops[idx].op === " ") idx++;
    if (idx >= ops.length) break;
    let hunkStart = Math.max(0, idx - context);
    let hunkEnd = idx;
    let last = idx;
    while (hunkEnd < ops.length) {
      if (ops[hunkEnd].op !== " ") { last = hunkEnd; hunkEnd++; continue; }
      if (hunkEnd - last > context * 2) break;
      hunkEnd++;
    }
    hunkEnd = Math.min(ops.length, last + context + 1);
    let aStart = 0, bStart = 0;
    for (let k = 0; k < hunkStart; k++) { if (ops[k].op !== "+") aStart++; if (ops[k].op !== "-") bStart++; }
    let aLen = 0, bLen = 0;
    const body: string[] = [];
    for (let k = hunkStart; k < hunkEnd; k++) {
      const o = ops[k];
      if (o.op !== "+") aLen++;
      if (o.op !== "-") bLen++;
      body.push(o.op + o.line);
    }
    const range = (start: number, len: number) => (len === 1 ? `${start + 1}` : `${len === 0 ? start : start + 1},${len}`);
    out.push(`@@ -${range(aStart, aLen)} +${range(bStart, bLen)} @@`, ...body);
    idx = hunkEnd;
  }
  return out.join("\n") + "\n";
}

// ─── plans and writes ────────────────────────────────────────────────

export interface FilePlan {
  kind: "file";
  host: HostId;
  scope: HostScope;
  path: string;
  before: string | null;
  after: string;
  changed: boolean;
  diff: string;
  /** Mode for a new file (an inline token gets 0600). */
  mode: number;
}
export interface DeployPlan {
  kind: "deploy";
  host: "hermes";
  script: string;
  targets: string[];
  profiles: string[];
  /** Profiles under the Hermes home that do not have the plugin yet. */
  otherProfiles: string[];
}
export interface ManualPlan {
  kind: "manual";
  host: HostId;
  steps: string[];
}
export type HostPlan = FilePlan | DeployPlan | ManualPlan;

export function readConfigFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The plan for one host: what the file would contain after `entry` (null = uninstall) is applied. */
export function planHost(id: HostId, ctx: HostContext, scope: HostScope, entry: EngramEntry | null): HostPlan {
  if (id === "hermes") return planHermes(ctx, entry !== null);
  const path = hostConfigPath(id, ctx, scope);
  const before = readConfigFile(path);
  const after = id === "codex"
    ? upsertTomlTable(before, `mcp_servers.${SERVER_NAME}`, entry ? renderTomlEntry(entry) : null)
    : upsertJsonServer(before, SERVER_NAME, entry ? renderJsonEntry(id, entry) : null, path);
  const changed = before !== after;
  return {
    kind: "file", host: id, scope, path, before, after, changed,
    diff: changed ? unifiedDiff(before, after, tildify(path, ctx.home)) : "",
    mode: entry?.auth.mode === "inline" ? 0o600 : 0o644,
  };
}

export const HERMES_RUNTIME_FILES = ["__init__.py", "provider.py", "mcp_client.py", "plugin.yaml", "README.md"] as const;

export function hermesPluginSource(ctx: HostContext): string {
  return join(ctx.packageRoot, "interfaces", "hermes-plugin");
}

export function planHermes(ctx: HostContext, install: boolean): HostPlan {
  const src = hermesPluginSource(ctx);
  const script = join(src, "deploy.sh");
  const base = join(ctx.hermesHome, "plugins", SERVER_NAME);
  const { targets, profiles } = pluginDeployTargets(ctx.hermesHome);
  if (!install) {
    return { kind: "manual", host: "hermes", steps: targets.length ? targets.map((t) => `remove ${t}`) : [`nothing deployed under ${ctx.hermesHome}`] };
  }
  if (ctx.platform === "win32") {
    return { kind: "manual", host: "hermes", steps: [`the Hermes plugin deploys with bash (${tildify(script, ctx.home)}); run it from WSL or Git Bash with HERMES_HOME=${ctx.hermesHome}`] };
  }
  if (!existsSync(script)) {
    return {
      kind: "manual", host: "hermes",
      steps: [
        `the Hermes plugin ships with the source checkout, not the npm package: git clone https://github.com/devinmlowe/engram.git && interfaces/hermes-plugin/deploy.sh`,
        `ENGRAM_PLUGIN_PROFILES="name1 name2" adds ${ctx.hermesHome}/profiles/<name>/plugins/engram`,
      ],
    };
  }
  const profilesDir = join(ctx.hermesHome, "profiles");
  const allProfiles = existsSync(profilesDir) ? readdirSync(profilesDir).filter((n) => statSync(join(profilesDir, n)).isDirectory()) : [];
  const otherProfiles = allProfiles.filter((n) => !profiles.includes(n));
  return { kind: "deploy", host: "hermes", script, targets: targets.includes(base) ? targets : [base, ...targets], profiles, otherProfiles };
}

export interface ApplyResult {
  wrote: boolean;
  backup: string | null;
  lines: string[];
}

/** Atomic write: `<path>.bak` of the previous content, temp file + rename, mode preserved. No-op when unchanged. */
export function applyFilePlan(plan: FilePlan): ApplyResult {
  if (!plan.changed) return { wrote: false, backup: null, lines: [] };
  const dir = dirname(plan.path);
  mkdirSync(dir, { recursive: true });
  let backup: string | null = null;
  let mode = plan.mode;
  if (plan.before !== null) {
    backup = `${plan.path}.bak`;
    copyFileSync(plan.path, backup);
    try { mode = statSync(plan.path).mode & 0o777; chmodSync(backup, mode); } catch { /* keep the default */ }
    if (plan.mode === 0o600) mode = 0o600;
  }
  const tmp = join(dir, `.${basename(plan.path)}.engram-${process.pid}-${Date.now().toString(36)}.tmp`);
  writeFileSync(tmp, plan.after, { mode });
  try { chmodSync(tmp, mode); } catch { /* best effort (Windows) */ }
  renameSync(tmp, plan.path);
  return { wrote: true, backup, lines: [] };
}

export async function applyDeployPlan(plan: DeployPlan, ctx: HostContext, exec: Exec): Promise<ApplyResult> {
  const r = await exec("bash", [plan.script], {
    cwd: ctx.packageRoot,
    env: { ...ctx.env, HERMES_HOME: ctx.hermesHome, ENGRAM_PLUGIN_PROFILES: plan.profiles.join(" ") },
  });
  const lines = (r.status === 0 ? r.stdout : r.stderr || r.stdout).trim().split("\n").filter(Boolean);
  if (r.status !== 0) throw new Error(`deploy.sh failed (exit ${r.status}): ${lines.join(" | ")}`);
  return { wrote: true, backup: null, lines };
}

/** Remove every deployed Hermes plugin copy (only directories that hold our `plugin.yaml`). */
export function removeHermesPlugin(ctx: HostContext): string[] {
  const removed: string[] = [];
  for (const dir of pluginDeployTargets(ctx.hermesHome).targets) {
    if (!existsSync(join(dir, "plugin.yaml"))) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

// ─── claude plugin awareness (#60) ───────────────────────────────────

export interface ClaudePluginInfo {
  installed: boolean;
  /** `engram@<marketplace>` */
  key?: string;
  version?: string;
  scope?: string;
  installPath?: string;
  /** The engram marketplace has been added (`/plugin marketplace add devinmlowe/engram`), whether or not the plugin is installed. */
  marketplaceAdded: boolean;
  file: string;
}

export function claudePluginStatus(ctx: HostContext): ClaudePluginInfo {
  const dir = claudeConfigDir(ctx);
  const file = join(dir, "plugins", "installed_plugins.json");
  const marketplaceAdded = existsSync(join(dir, "plugins", "marketplaces", SERVER_NAME));
  const none: ClaudePluginInfo = { installed: false, marketplaceAdded, file };
  if (!existsSync(file)) return none;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { plugins?: Record<string, Array<{ version?: string; scope?: string; installPath?: string }>> };
    for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
      if (!key.startsWith(`${SERVER_NAME}@`) || !Array.isArray(entries) || entries.length === 0) continue;
      const e = entries[0];
      return { installed: true, key, version: e.version, scope: e.scope, installPath: e.installPath, marketplaceAdded, file };
    }
  } catch { /* unreadable registry: treat as not installed */ }
  return none;
}

// ─── install / uninstall ─────────────────────────────────────────────

export interface InstallOptions {
  hosts: HostId[];
  scope: HostScope;
  transport?: Transport;
  dryRun?: boolean;
  force?: boolean;
  inlineToken?: boolean;
}

export interface InstallDeps {
  ctx: HostContext;
  probe?: HealthProbe;
  exec?: Exec;
}

export interface InstallResult {
  host: HostId;
  label: string;
  scope: HostScope;
  /** Config file, or the Hermes plugin target(s). */
  path: string;
  transport: Transport | null;
  reason: string;
  auth: EntryAuth["mode"] | null;
  action: "written" | "unchanged" | "dry-run" | "skipped" | "deployed" | "manual" | "error";
  backup: string | null;
  diff: string;
  /** Human lines to print under the header. */
  notes: string[];
}

function authNote(id: HostId, entry: EngramEntry, token: DaemonToken, ctx: HostContext): string[] {
  if (entry.transport !== "http") return [];
  if (entry.auth.mode === "env-ref") {
    return [
      `auth: ${TOKEN_REFERENCE[id]} (references the variable; the literal is never written)`,
      `      ${MCP_TOKEN_ENV} must resolve in the environment ${HOST_LABELS[id]} runs in — \`engram mcp status\` checks (${token.source === "env-file" ? `value in ${tildify(token.file, ctx.home)}` : "set in this shell"})`,
    ];
  }
  if (entry.auth.mode === "inline") return [`WARNING: --inline-token wrote the literal ${MCP_TOKEN_ENV} into the config (mode 600); rotate it by re-running this command`];
  return [];
}

export const RESTART_HINT: Record<HostId, string> = {
  claude: "restart Claude Code; /mcp should list engram (16 tools)",
  codex: "restart Codex; `codex mcp list` should show engram",
  cursor: "restart Cursor (or reload the window); Settings → MCP should show engram",
  hermes: "restart the Hermes gateways so they load the plugin",
};

export async function runMcpInstall(opts: InstallOptions, deps: InstallDeps): Promise<InstallResult[]> {
  const { ctx } = deps;
  const exec = deps.exec ?? realExec;
  const results: InstallResult[] = [];
  const fileHosts = opts.hosts.filter((h) => h !== "hermes");
  let decision: TransportDecision | null = null;
  let token: DaemonToken | null = null;
  let entry: EngramEntry | null = null;
  if (fileHosts.length) {
    decision = await decideTransport({ env: ctx.env, override: opts.transport, probe: deps.probe });
    token = daemonToken(ctx);
    if (opts.inlineToken && !token.source) throw new Error(`--inline-token: ${MCP_TOKEN_ENV} is not set here nor in ${token.file}`);
    entry = buildEntry(decision, ctx, { token, inlineToken: opts.inlineToken });
    if (entry.transport === "stdio" && !existsSync(installedCliScript(ctx))) {
      throw new Error(`${installedCliScript(ctx)} does not exist — run \`npm run build\` in the checkout (or install from npm) before registering a stdio entry`);
    }
  }

  for (const id of opts.hosts) {
    const label = HOST_LABELS[id];
    if (id === "hermes") {
      const plan = planHermes(ctx, true);
      const base: InstallResult = { host: id, label, scope: "user", path: hostConfigPath("hermes", ctx, "user"), transport: null, reason: "Hermes memory-provider plugin (talks HTTP to the daemon itself)", auth: null, action: "manual", backup: null, diff: "", notes: [] };
      if (plan.kind === "manual") { results.push({ ...base, notes: plan.steps }); continue; }
      if (plan.kind !== "deploy") continue;
      const notes = [`deploy ${tildify(plan.script, ctx.home)} → ${plan.targets.map((t) => tildify(t, ctx.home)).join(", ")}`];
      if (plan.otherProfiles.length) notes.push(`profiles without the plugin (add with ENGRAM_PLUGIN_PROFILES="…" ${tildify(plan.script, ctx.home)}): ${plan.otherProfiles.join(", ")}`);
      if (opts.dryRun) { results.push({ ...base, action: "dry-run", notes: ["would " + notes[0], ...notes.slice(1)] }); continue; }
      try {
        const r = await applyDeployPlan(plan, ctx, exec);
        results.push({ ...base, action: "deployed", notes: [...notes, ...r.lines.map((l) => `  ${l}`), RESTART_HINT.hermes] });
      } catch (err) {
        results.push({ ...base, action: "error", notes: [err instanceof Error ? err.message : String(err)] });
      }
      continue;
    }

    const path = hostConfigPath(id, ctx, opts.scope);
    const base: InstallResult = {
      host: id, label, scope: opts.scope, path, transport: entry!.transport, reason: decision!.reason,
      auth: entry!.transport === "http" ? entry!.auth.mode : null, action: "written", backup: null, diff: "", notes: [],
    };
    if (id === "claude" && opts.scope === "user" && !opts.force) {
      const plugin = claudePluginStatus(ctx);
      if (plugin.installed) {
        results.push({
          ...base, action: "skipped",
          notes: [
            `the engram Claude Code plugin is installed (${plugin.key}${plugin.version ? ` ${plugin.version}` : ""}, ${plugin.scope ?? "user"} scope) and already provides the server; a user-scope entry would register it twice`,
            "pass --force to write ~/.claude.json anyway, or --project for a repo-local .mcp.json",
          ],
        });
        continue;
      }
    }
    let plan: HostPlan;
    try { plan = planHost(id, ctx, opts.scope, entry); } catch (err) {
      results.push({ ...base, action: "error", notes: [err instanceof Error ? err.message : String(err)] });
      continue;
    }
    if (plan.kind !== "file") continue;
    const notes = authNote(id, entry!, token!, ctx);
    if (!plan.changed) { results.push({ ...base, action: "unchanged", notes: [`${tildify(path, ctx.home)} already has this entry`, ...notes] }); continue; }
    if (opts.dryRun) { results.push({ ...base, action: "dry-run", diff: plan.diff, notes: [`would write ${tildify(path, ctx.home)}${plan.before === null ? " (new file)" : ` (backup: ${tildify(path, ctx.home)}.bak)`}`, ...notes] }); continue; }
    try {
      const r = applyFilePlan(plan);
      results.push({
        ...base, action: "written", backup: r.backup, diff: plan.diff,
        notes: [`wrote ${tildify(path, ctx.home)}${r.backup ? ` (previous content: ${tildify(r.backup, ctx.home)})` : " (new file)"}`, ...notes, RESTART_HINT[id]],
      });
    } catch (err) {
      results.push({ ...base, action: "error", notes: [err instanceof Error ? err.message : String(err)] });
    }
  }
  return results;
}

export async function runMcpUninstall(id: HostId, scope: HostScope, deps: InstallDeps, dryRun = false): Promise<InstallResult> {
  const { ctx } = deps;
  const label = HOST_LABELS[id];
  if (id === "hermes") {
    const targets = pluginDeployTargets(ctx.hermesHome).targets;
    const base: InstallResult = { host: id, label, scope: "user", path: hostConfigPath("hermes", ctx, "user"), transport: null, reason: "", auth: null, action: "unchanged", backup: null, diff: "", notes: [] };
    if (!targets.length) return { ...base, notes: [`nothing deployed under ${tildify(ctx.hermesHome, ctx.home)}`] };
    if (dryRun) return { ...base, action: "dry-run", notes: targets.map((t) => `would remove ${tildify(t, ctx.home)}`) };
    const removed = removeHermesPlugin(ctx);
    return { ...base, action: "written", notes: [...removed.map((t) => `removed ${tildify(t, ctx.home)}`), RESTART_HINT.hermes] };
  }
  const path = hostConfigPath(id, ctx, scope);
  const base: InstallResult = { host: id, label, scope, path, transport: null, reason: "", auth: null, action: "unchanged", backup: null, diff: "", notes: [] };
  const plan = planHost(id, ctx, scope, null);
  if (plan.kind !== "file") return base;
  if (!plan.changed) return { ...base, notes: [`${tildify(path, ctx.home)} has no ${SERVER_NAME} entry`] };
  if (dryRun) return { ...base, action: "dry-run", diff: plan.diff, notes: [`would edit ${tildify(path, ctx.home)}`] };
  const r = applyFilePlan(plan);
  return { ...base, action: "written", backup: r.backup, diff: plan.diff, notes: [`removed ${SERVER_NAME} from ${tildify(path, ctx.home)} (previous content: ${tildify(r.backup!, ctx.home)})`, RESTART_HINT[id]] };
}

export function formatInstallResults(results: InstallResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    const head = r.transport ? `${r.host}: ${r.transport} — ${r.reason}` : `${r.host}: ${r.reason || r.label}`;
    lines.push(r.action === "skipped" ? `${r.host}: skipped` : r.action === "error" ? `${r.host}: ERROR` : head);
    for (const n of r.notes) lines.push(`  ${n}`);
    if (r.action === "dry-run" && r.diff) lines.push(...r.diff.replace(/\n$/, "").split("\n").map((l) => `  ${l}`));
  }
  return lines;
}

// ─── status ──────────────────────────────────────────────────────────

/** What a host config says about engram, parsed back out of the file. */
export interface RegisteredEntry {
  transport: Transport | null;
  url?: string;
  port?: number;
  command?: string;
  args?: string[];
  /** Bearer header / token setting: `env-ref` (which var), `inline`, or none. */
  auth: { mode: "none" } | { mode: "env-ref"; envVar: string } | { mode: "inline" };
  raw: unknown;
}

const ENV_REF_RE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/;

function authFromHeader(value: string | undefined): RegisteredEntry["auth"] {
  if (!value) return { mode: "none" };
  const m = value.match(ENV_REF_RE);
  return m ? { mode: "env-ref", envVar: m[1] } : { mode: "inline" };
}

function portFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.port ? Number.parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
  } catch { return undefined; }
}

export function parseRegisteredEntry(id: HostId, raw: unknown): RegisteredEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (id === "codex") {
    const url = str(o.url);
    const command = str(o.command);
    const headers = (o.http_headers && typeof o.http_headers === "object" ? o.http_headers : {}) as Record<string, string>;
    const auth: RegisteredEntry["auth"] = str(o.bearer_token_env_var)
      ? { mode: "env-ref", envVar: str(o.bearer_token_env_var)! }
      : headers.Authorization || headers.authorization ? { mode: "inline" } : { mode: "none" };
    return { transport: url ? "http" : command ? "stdio" : null, url, port: portFromUrl(url), command, args: Array.isArray(o.args) ? (o.args as string[]) : [], auth, raw };
  }
  const url = str(o.url);
  const command = str(o.command);
  const type = str(o.type);
  const transport: Transport | null = type === "http" || type === "sse" || type === "streamable-http" || type === "ws" ? "http" : type === "stdio" ? "stdio" : url ? "http" : command ? "stdio" : null;
  const headers = (o.headers && typeof o.headers === "object" ? o.headers : {}) as Record<string, string>;
  return { transport, url, port: portFromUrl(url), command, args: Array.isArray(o.args) ? (o.args as string[]) : [], auth: authFromHeader(headers.Authorization ?? headers.authorization), raw };
}

/** The `engram` entry a host config file currently holds (null = not registered / no file). */
export function readRegisteredEntry(id: HostId, path: string): RegisteredEntry | null {
  const text = readConfigFile(path);
  if (text === null) return null;
  if (id === "codex") {
    const table = readTomlTable(text, `mcp_servers.${SERVER_NAME}`);
    return table ? parseRegisteredEntry(id, table) : null;
  }
  let obj: JsonObject;
  try { obj = parseJsonConfig(text, path); } catch { return null; }
  const servers = obj.mcpServers;
  if (!servers || typeof servers !== "object") return null;
  const raw = (servers as JsonObject)[SERVER_NAME];
  return raw === undefined ? null : parseRegisteredEntry(id, raw);
}

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/**
 * Does a registered stdio entry run this install? Accepts the CLI entry
 * (`dist/interfaces/cli/index.js mcp`) or the bare server
 * (`dist/interfaces/mcp/server.js`) under this package root; an `npx
 * @devinmlowe/engram` entry runs the published package (reported, not compared).
 */
export function stdioTarget(entry: RegisteredEntry, ctx: HostContext): { current: boolean | null; detail: string } {
  const root = safeRealpath(ctx.packageRoot);
  const scripts = [entry.command, ...(entry.args ?? [])].filter((a): a is string => typeof a === "string");
  const cmd = entry.command ?? "";
  if (basename(cmd) === "npx" || scripts.some((a) => a === PACKAGE_NAME || a.startsWith(`${PACKAGE_NAME}@`))) {
    const spec = scripts.find((a) => a === PACKAGE_NAME || a.startsWith(`${PACKAGE_NAME}@`)) ?? PACKAGE_NAME;
    return { current: null, detail: `npx ${spec} (published package, not this ${ctx.packageRoot === PACKAGE_ROOT ? "install" : "checkout"})` };
  }
  const script = scripts.find((a) => /\.(c|m)?js$/.test(a));
  if (!script) return { current: false, detail: `${[cmd, ...(entry.args ?? [])].join(" ")} (no engram script in the command)` };
  const real = safeRealpath(script);
  const known = [join(root, "dist", "interfaces", "cli", "index.js"), join(root, "dist", "interfaces", "mcp", "server.js")];
  if (known.includes(real)) return { current: true, detail: `${tildify(script, ctx.home)} (this install)` };
  return { current: false, detail: `${tildify(script, ctx.home)} (${existsSync(script) ? "another install" : "missing"})` };
}

export interface TokenStatus {
  /** The entry references this variable (env-ref) … */
  envVar: string | null;
  /** … and it resolves in the environment this command runs in. */
  resolves: boolean | null;
  inline: boolean;
  /** The daemon requires a token (per env / env file) but the entry sends none. */
  missing: boolean;
}

export interface HostStatus {
  host: HostId;
  label: string;
  /** User-scope config path (or Hermes plugin dir). */
  path: string;
  /** The host's config directory exists. */
  present: boolean;
  registered: boolean;
  transport: Transport | null;
  /** What the entry points at. */
  target: string;
  /** Points at this install (stdio path / daemon port); null = not comparable (npx, absent). */
  current: boolean | null;
  /** The daemon this entry uses (HTTP target, or the port the stdio bridge probes). */
  daemon: { port: number; healthy: boolean | null } | null;
  token: TokenStatus | null;
  plugin?: ClaudePluginInfo;
  notes: string[];
}

export interface StatusReport {
  hosts: HostStatus[];
  daemon: { port: number; url: string; healthy: boolean | null; detail: string };
  token: DaemonToken & { hint: string[] };
  install: { packageRoot: string; cli: string; node: string };
}

/** Platform-specific way to make `ENGRAM_MCP_TOKEN` visible to GUI-launched hosts. */
export function tokenEnvHint(platform: NodeJS.Platform, envFile: string): string[] {
  const where = `(the value lives in ${envFile})`;
  switch (platform) {
    case "darwin":
      return [
        `GUI apps and Claude Code launched from the Dock do not inherit a fish/zsh login shell ${where}:`,
        `  launchctl setenv ${MCP_TOKEN_ENV} "<token>"   # this login session; put it in a LaunchAgent to persist`,
        `  terminals: set -Ux ${MCP_TOKEN_ENV} "<token>" (fish) or export it in ~/.zprofile, then restart the host`,
      ];
    case "win32":
      return [`set it as a user environment variable ${where}: setx ${MCP_TOKEN_ENV} "<token>"  — then restart the host`];
    default:
      return [
        `GUI sessions do not read ~/.profile ${where}:`,
        `  ~/.config/environment.d/engram.conf → ${MCP_TOKEN_ENV}=<token>  (systemd user session; re-login)`,
        `  terminals: export ${MCP_TOKEN_ENV}=<token> in ~/.profile, then restart the host`,
      ];
  }
}

export interface StatusDeps {
  ctx: HostContext;
  probe?: HealthProbe | false;
}

async function probePort(port: number, probe: HealthProbe | false | undefined, cache: Map<number, Promise<boolean | null>>): Promise<boolean | null> {
  if (probe === false) return null;
  const fn = probe ?? probeMcpHealth;
  if (!cache.has(port)) cache.set(port, fn(port, 1500).then(isEngramDaemonHealth, () => false));
  return cache.get(port)!;
}

export async function runMcpStatus(deps: StatusDeps): Promise<StatusReport> {
  const { ctx } = deps;
  const port = parseMcpPort(ctx.env.ENGRAM_MCP_PORT, DEFAULT_MCP_PORT);
  const cache = new Map<number, Promise<boolean | null>>();
  const token = daemonToken(ctx);
  const hosts: HostStatus[] = [];

  for (const id of HOST_IDS) {
    const path = hostConfigPath(id, ctx, "user");
    const present = hostPresent(id, ctx);
    const base: HostStatus = { host: id, label: HOST_LABELS[id], path, present, registered: false, transport: null, target: "", current: null, daemon: null, token: null, notes: [] };
    if (id === "hermes") {
      hosts.push(await hermesStatus(base, ctx, token, deps.probe, cache));
      continue;
    }
    if (id === "claude") {
      const plugin = claudePluginStatus(ctx);
      base.plugin = plugin;
      if (plugin.installed) base.notes.push(`plugin ${plugin.key}${plugin.version ? ` ${plugin.version}` : ""} installed (${plugin.scope ?? "user"} scope): npx ${PACKAGE_NAME}@<version> mcp — bridges to the daemon on :${port} when it is up`);
      else if (plugin.marketplaceAdded) base.notes.push("engram marketplace added but the plugin is not installed (/plugin install engram@engram)");
    }
    const entry = readRegisteredEntry(id, path);
    if (!entry) {
      if (base.plugin?.installed) { base.registered = true; base.target = "Claude Code plugin"; base.transport = "stdio"; base.daemon = { port, healthy: await probePort(port, deps.probe, cache) }; }
      hosts.push(base);
      continue;
    }
    base.registered = true;
    base.transport = entry.transport;
    if (entry.transport === "http") {
      const p = entry.port ?? port;
      base.target = entry.url ?? "";
      base.current = p === port;
      base.daemon = { port: p, healthy: await probePort(p, deps.probe, cache) };
      if (!base.current) base.notes.push(`points at :${p}; this install's daemon port is :${port} (ENGRAM_MCP_PORT)`);
      const referenced = entry.auth.mode === "env-ref" ? entry.auth.envVar : null;
      base.token = {
        envVar: referenced,
        resolves: referenced ? Boolean(ctx.env[referenced]?.trim()) : null,
        inline: entry.auth.mode === "inline",
        missing: entry.auth.mode === "none" && token.source !== null,
      };
    } else if (entry.transport === "stdio") {
      const t = stdioTarget(entry, ctx);
      base.target = t.detail;
      base.current = t.current;
      const idx = (entry.args ?? []).indexOf("--port");
      const p = idx >= 0 ? parseMcpPort(entry.args?.[idx + 1], port) : port;
      base.daemon = { port: p, healthy: await probePort(p, deps.probe, cache) };
    } else {
      base.target = "unrecognised entry (neither url nor command)";
      base.current = false;
    }
    hosts.push(base);
  }

  const healthy = await probePort(port, deps.probe, cache);
  return {
    hosts,
    daemon: { port, url: `http://127.0.0.1:${port}/mcp`, healthy, detail: healthy === null ? "not probed" : healthy ? "answering /health" : `not answering /health — HTTP entries fail, stdio entries run inline (${DAEMON_INSTALL_HINT})` },
    token: { ...token, hint: tokenEnvHint(ctx.platform, tildify(token.file, ctx.home)) },
    install: { packageRoot: ctx.packageRoot, cli: installedCliScript(ctx), node: ctx.node },
  };
}

async function hermesStatus(base: HostStatus, ctx: HostContext, token: DaemonToken, probe: HealthProbe | false | undefined, cache: Map<number, Promise<boolean | null>>): Promise<HostStatus> {
  const { targets, profiles } = pluginDeployTargets(ctx.hermesHome);
  const deployed = targets.filter((t) => existsSync(join(t, "__init__.py")));
  if (!deployed.length) return base;
  base.registered = true;
  base.transport = "http";
  base.target = `${deployed.length} plugin cop${deployed.length === 1 ? "y" : "ies"}${profiles.length ? ` (profiles: ${profiles.join(", ")})` : ""}`;
  const src = hermesPluginSource(ctx);
  if (existsSync(join(src, "__init__.py"))) {
    const stale = deployed.filter((t) => HERMES_RUNTIME_FILES.some((f) => {
      const a = join(t, f), b = join(src, f);
      return !existsSync(a) || !existsSync(b) || !readFileSync(a).equals(readFileSync(b));
    }));
    base.current = stale.length === 0;
    if (stale.length) base.notes.push(`differs from this checkout: ${stale.map((t) => tildify(t, ctx.home)).join(", ")} — engram mcp install hermes`);
  }
  let baseUrl = "http://127.0.0.1:9907";
  let hasToken = false;
  const cfg = join(ctx.hermesHome, "engram.json");
  if (existsSync(cfg)) {
    try {
      const j = JSON.parse(readFileSync(cfg, "utf8")) as { base_url?: string; token?: string };
      if (typeof j.base_url === "string") baseUrl = j.base_url;
      hasToken = typeof j.token === "string" && j.token.trim() !== "";
    } catch { base.notes.push(`${tildify(cfg, ctx.home)} is not valid JSON`); }
  }
  const p = portFromUrl(baseUrl) ?? DEFAULT_MCP_PORT;
  base.daemon = { port: p, healthy: await probePort(p, probe, cache) };
  base.token = { envVar: null, resolves: null, inline: hasToken, missing: !hasToken && token.source !== null };
  if (base.token.missing) base.notes.push(`the daemon requires ${MCP_TOKEN_ENV} but ${tildify(cfg, ctx.home)} has no "token": add it (the file is mode 600)`);
  return base;
}

export function formatStatus(report: StatusReport, ctx: HostContext): string[] {
  const lines: string[] = [];
  lines.push(`install:  ${tildify(report.install.packageRoot, ctx.home)} (stdio: ${tildify(report.install.node, ctx.home)} ${tildify(report.install.cli, ctx.home)} mcp)`);
  lines.push(`daemon:   ${report.daemon.url} — ${report.daemon.detail}`);
  lines.push("");
  let needHint = false;
  for (const h of report.hosts) {
    const where = tildify(h.path, ctx.home);
    if (!h.present && !h.registered) { lines.push(`[--]   ${h.host.padEnd(7)} not installed (no ${tildify(hostConfigDir(h.host, ctx), ctx.home)})`); continue; }
    if (!h.registered) { lines.push(`[--]   ${h.host.padEnd(7)} not registered in ${where} — engram mcp install ${h.host}`); for (const n of h.notes) lines.push(`         ${n}`); continue; }
    const parts: string[] = [];
    if (h.host === "hermes") parts.push(`plugin deployed: ${h.target}`);
    else if (h.target === "Claude Code plugin") parts.push("via the Claude Code plugin");
    else parts.push(`${h.transport ?? "?"} → ${h.target}`);
    if (h.current === true) parts.push("current install");
    else if (h.current === false) parts.push(h.host === "hermes" ? "stale copy (redeploy)" : "NOT this install");
    if (h.daemon) parts.push(h.daemon.healthy === null ? `daemon :${h.daemon.port} not probed` : h.daemon.healthy ? `daemon :${h.daemon.port} answering` : `daemon :${h.daemon.port} down${h.transport === "stdio" ? " (runs inline)" : ""}`);
    const level = h.current === false || (h.transport === "http" && h.daemon?.healthy === false) || h.token?.missing || h.token?.resolves === false ? "[--] " : "[ok] ";
    lines.push(`${level}  ${h.host.padEnd(7)} ${parts.join("; ")}`);
    lines.push(`         ${where}`);
    if (h.token) {
      if (h.token.envVar) {
        lines.push(`         token: references ${h.token.envVar} — ${h.token.resolves ? "resolves in this environment" : "NOT set in this environment"}`);
        if (!h.token.resolves) needHint = true;
      } else if (h.token.inline) lines.push(`         token: literal in the config${h.host === "hermes" ? " (engram.json)" : " (--inline-token)"}`);
      else if (h.token.missing) lines.push(`         token: the daemon requires ${MCP_TOKEN_ENV} but this entry sends none — re-run engram mcp install ${h.host}`);
    }
    for (const n of h.notes) lines.push(`         ${n}`);
  }
  if (needHint) {
    lines.push("");
    lines.push(...report.token.hint);
  }
  return lines;
}

// ─── doctor `hosts` check ────────────────────────────────────────────

/** One line for `engram doctor`: registered hosts pointing at this install; never a failure. */
export async function summariseHostsForDoctor(ctx: HostContext = defaultHostContext()): Promise<{ ok: boolean; detail: string }> {
  const report = await runMcpStatus({ ctx, probe: false });
  const registered = report.hosts.filter((h) => h.registered);
  const current = registered.filter((h) => h.current === true || (h.host === "claude" && h.target === "Claude Code plugin"));
  const describe = (h: HostStatus) => `${h.host} (${h.target === "Claude Code plugin" ? "plugin" : h.host === "hermes" ? "plugin" : h.transport ?? "?"}${h.current === false ? ", not this install" : ""})`;
  if (registered.length === 0) {
    return { ok: false, detail: `no host registered — engram mcp install claude|codex|cursor|hermes (or --all)` };
  }
  const detail = registered.map(describe).join(", ");
  if (current.length === 0) return { ok: false, detail: `${detail} — none points at this install; re-run engram mcp install <host>` };
  return { ok: true, detail: `${detail}${registered.length < HOST_IDS.length ? ` — engram mcp status for the rest` : ""}` };
}
