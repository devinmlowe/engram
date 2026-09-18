/**
 * #58 / decision #60 — daemon-aware stdio entry (`src/interfaces/mcp/bridge.ts`).
 *
 * `engram mcp` (the command the Claude Code plugin runs via `npx`) bridges
 * stdio to the HTTP daemon when `/health` answers, and runs the full server
 * inline otherwise. Three layers here:
 *
 *   1. `decideStdioMode` with an injected probe: every branch of the decision.
 *   2. Static: the bridge module imports neither the DB nor the embeddings,
 *      and the CLI decides before it imports server.ts.
 *   3. End to end: a REAL daemon (Streamable HTTP + a real worker thread,
 *      ephemeral port) and a REAL child process running the CLI from source
 *      (`node --import tsx src/interfaces/cli/index.ts mcp`), driven over
 *      stdio with the SDK's StdioClientTransport — bridge when healthy
 *      (16 tools, remember → recall → forget round-trip with the host's
 *      clientInfo as the actor, no DB module loaded, impossible
 *      ENGRAM_DB_PATH), inline when there is no daemon, `--standalone`
 *      when there is one, bearer token forwarded (and 401 without it),
 *      clean exit when stdin closes.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_TOOL_NAMES } from "../../../src/interfaces/mcp/tool-names.js";
import {
  decideStdioMode,
  describeStdioDecision,
  portFromArgs,
  STANDALONE_ENV,
  STANDALONE_FLAG,
} from "../../../src/interfaces/mcp/bridge.js";

// The daemon side runs in this process; its tool calls go to the worker.
// Importing server.ts must not load a model on the main thread.
vi.mock("../../../src/_core/embeddings/index.js", () => ({
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  embedQuery: vi.fn(),
  embedDocument: vi.fn(),
  embedDocumentBatch: vi.fn(),
  getActiveModel: vi.fn().mockReturnValue("mock-model"),
  resetEmbeddings: vi.fn(),
}));

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI_SRC = join(REPO_ROOT, "src/interfaces/cli/index.ts");
const WORKER_FIXTURE = fileURLToPath(new URL("./fixtures/forget-worker-entry.mjs", import.meta.url));
const MODULE_TRACE = fileURLToPath(new URL("./fixtures/module-trace.mjs", import.meta.url));

const tmpDir = mkdtempSync(join(tmpdir(), "engram-bridge-"));
// The daemon's database (what the worker opens). The bridge child never sees this path.
process.env.ENGRAM_DB_PATH = join(tmpDir, "daemon.db");
process.env.ENGRAM_DATA_DIR = tmpDir;
process.env.ENGRAM_RERANK_ENABLED = "0";
delete process.env.ENGRAM_SCOPE;
delete process.env.ENGRAM_READ_SCOPES;
delete process.env.ENGRAM_MCP_STANDALONE;
delete process.env.ENGRAM_MCP_TOKEN;

/** A directory that does not exist, so any attempt to open a database under it throws SQLITE_CANTOPEN. */
const IMPOSSIBLE_DIR = join(tmpDir, "does-not-exist", "nested");
const IMPOSSIBLE_DB = join(IMPOSSIBLE_DIR, "engram.db");

const FACT = "The stdio bridge forwards forget with the host's clientInfo";
const HOST_NAME = "claude-code-bridge-test";
const silent = () => {};

const ok = (status = 200, body = '{"status":"ok"}') => async () => ({ status, body });
const refused = async () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9907"), { code: "ECONNREFUSED" }); };

function text(res: unknown): string {
  return (res as { content: Array<{ type: string; text?: string }> }).content.map((c) => c.text ?? "").join("\n");
}

function readDaemonDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(process.env.ENGRAM_DB_PATH!, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

/** A loopback port nothing listens on (bound then released). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

interface ChildHandle {
  client: Client;
  transport: StdioClientTransport;
  stderr: () => string;
  trace: () => string;
  env: Record<string, string>;
}

/**
 * Spawn `engram mcp [...args]` from source under a module tracer, connect an
 * MCP client to it over stdio, and collect its stderr. `ENGRAM_DB_PATH`
 * points at an impossible location so any DB open would fail loudly.
 */
async function spawnCli(args: string[], env: Record<string, string>, name = HOST_NAME): Promise<ChildHandle> {
  const traceFile = join(tmpDir, `trace-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpDir,
    ENGRAM_DB_PATH: IMPOSSIBLE_DB,
    ENGRAM_DATA_DIR: IMPOSSIBLE_DIR,
    ENGRAM_MODEL_CACHE_DIR: IMPOSSIBLE_DIR,
    ENGRAM_RERANK_ENABLED: "0",
    MODULE_TRACE_FILE: traceFile,
    ...env,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "--import", MODULE_TRACE, CLI_SRC, "mcp", ...args],
    env: childEnv,
    cwd: REPO_ROOT,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    stderr: () => stderr,
    trace: () => (existsSync(traceFile) ? readFileSync(traceFile, "utf8") : ""),
    env: childEnv,
  };
}

afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }); });

// What a bridged `engram mcp` must never load: the embedding stack and the
// full server. (The CLI's own top-level imports resolve `_core/db`, so the
// better-sqlite3 *module* is loaded by every `engram` command; the bridge
// never opens a database — the IMPOSSIBLE_DB assertions below pin that.)
const FORBIDDEN_IN_BRIDGE = ["@xenova/transformers", "onnxruntime", "/src/_core/embeddings/index.ts", "/src/interfaces/mcp/server.ts", "/src/interfaces/mcp/dispatch.ts"];

describe("decideStdioMode", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("bridges when /health is the daemon's, on the resolved port and url", async () => {
    const probe = vi.fn(ok());
    const d = await decideStdioMode({ args: [], env: { ENGRAM_MCP_PORT: "9911" }, probe });
    expect(d).toEqual({ mode: "bridge", port: 9911, url: "http://127.0.0.1:9911/mcp", reason: "daemon healthy" });
    expect(probe).toHaveBeenCalledWith(9911, expect.any(Number));
    expect(describeStdioDecision(d)).toBe("Engram MCP: bridging stdio to http://127.0.0.1:9911/mcp (daemon healthy)");
  });

  it("defaults to 9907 and runs inline when nothing answers, naming the port and error", async () => {
    const d = await decideStdioMode({ args: [], env, probe: refused });
    expect(d.mode).toBe("inline");
    expect(d.port).toBe(9907);
    expect(d.reason).toBe("no daemon on :9907 (ECONNREFUSED)");
    expect(describeStdioDecision(d)).toMatch(/^Engram MCP: running inline \(no daemon on :9907/);
  });

  it("does not bridge to something that answers on the port but is not the engram daemon", async () => {
    expect((await decideStdioMode({ args: [], env, probe: ok(200, "<html>") })).mode).toBe("inline");
    expect((await decideStdioMode({ args: [], env, probe: ok(503, '{"status":"starting"}') })).mode).toBe("inline");
    const d = await decideStdioMode({ args: [], env, probe: ok(404, "nope") });
    expect(d.reason).toContain("not like the engram daemon (HTTP 404)");
  });

  it("--standalone and ENGRAM_MCP_STANDALONE force inline without probing", async () => {
    const probe = vi.fn(ok());
    expect(await decideStdioMode({ args: [STANDALONE_FLAG], env, probe })).toMatchObject({ mode: "inline", reason: "--standalone" });
    for (const v of ["1", "true", "YES", " on "]) {
      expect((await decideStdioMode({ args: [], env: { [STANDALONE_ENV]: v }, probe })).mode, v).toBe("inline");
    }
    expect(probe).not.toHaveBeenCalled();
    // A falsy value does not count.
    expect((await decideStdioMode({ args: [], env: { [STANDALONE_ENV]: "0" }, probe })).mode).toBe("bridge");
  });

  it("--port wins over ENGRAM_MCP_PORT; an invalid --port is ignored", async () => {
    expect(portFromArgs(["--port", "9912"])).toBe(9912);
    expect(portFromArgs(["--port", "nope"])).toBeUndefined();
    expect(portFromArgs([])).toBeUndefined();
    const d = await decideStdioMode({ args: ["--port", "9912"], env: { ENGRAM_MCP_PORT: "9911" }, probe: ok() });
    expect(d.port).toBe(9912);
  });
});

describe("bridge module stays light", () => {
  it("bridge.ts imports neither the database nor the embeddings layer", () => {
    const src = readFileSync(join(REPO_ROOT, "src/interfaces/mcp/bridge.ts"), "utf8");
    const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(3);
    for (const spec of imports) {
      expect(spec, spec).not.toMatch(/_core\/db|_core\/embeddings|better-sqlite3|@xenova|\.\/server\.js|\.\/dispatch\.js|\.\/worker/);
    }
  });

  it("the CLI's mcp command decides via bridge.ts before importing server.ts", () => {
    const src = readFileSync(join(REPO_ROOT, "src/interfaces/cli/index.ts"), "utf8");
    const start = src.indexOf('.command("mcp")');
    const end = src.indexOf(".command(", start + 1);
    const block = src.slice(start, end);
    expect(block).toContain('import("../mcp/bridge.js")');
    expect(block.indexOf('import("../mcp/bridge.js")')).toBeLessThan(block.lastIndexOf('import("../mcp/server.js")'));
    expect(block).toContain("--standalone");
  });
});

describe("stdio entry end to end (real daemon, real child process)", () => {
  let http: import("../../../src/interfaces/mcp/http.js").EngramHttpServer;
  let dispatcher: import("../../../src/interfaces/mcp/dispatch.js").ToolDispatcher;
  let daemonPort: number;
  const children: ChildHandle[] = [];

  beforeAll(async () => {
    const { registerToolHandlers, handleToolCall } = await import("../../../src/interfaces/mcp/server.js");
    const { createToolDispatcher } = await import("../../../src/interfaces/mcp/dispatch.js");
    const { createEngramHttpServer } = await import("../../../src/interfaces/mcp/http.js");

    dispatcher = createToolDispatcher({
      workers: 1,
      direct: handleToolCall,
      spawn: () => new Worker(WORKER_FIXTURE),
      timeoutMs: 20_000,
      log: silent,
    });
    await dispatcher.whenReady();

    http = createEngramHttpServer({
      port: 0,
      registerHandlers: (srv) => registerToolHandlers(srv, dispatcher.call),
      health: () => ({ workers: dispatcher.stats() ?? { size: 0 } }),
      log: silent,
    });
    daemonPort = (await http.listen()).port;
  }, 60_000);

  afterAll(async () => {
    for (const c of children.splice(0)) await c.client.close().catch(() => {});
    await http?.close();
    await dispatcher?.close();
  });

  it("bridges to the healthy daemon: 16 tools, round-trip through the daemon, host identity kept, no DB/model loaded", async () => {
    const child = await spawnCli([], { ENGRAM_MCP_PORT: String(daemonPort) });
    children.push(child);

    expect(child.stderr()).toContain(`Engram MCP: bridging stdio to http://127.0.0.1:${daemonPort}/mcp (daemon healthy)`);
    expect(child.stderr()).not.toContain("running via stdio");

    const { tools } = await child.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools).toHaveLength(16);
    // serverInfo comes from the daemon, not a second identity.
    expect(child.client.getServerVersion()?.name).toBe("engram");
    await child.client.ping();

    // remember → recall (id) → forget <id> → recall empty, all executed by the daemon's worker.
    const remembered = await child.client.callTool({ name: "remember", arguments: { content: FACT } });
    expect(text(remembered)).toContain("Remembered:");
    const row = readDaemonDb((db) => db.prepare("SELECT id, is_active FROM memories WHERE content = ?").get(FACT) as { id: string; is_active: number });
    expect(row.is_active).toBe(1);

    const recalled = text(await child.client.callTool({ name: "recall", arguments: { query: FACT } }));
    expect(recalled).toContain(`id="${row.id}"`);

    const forgotten = text(await child.client.callTool({ name: "forget", arguments: { memory_id: row.id } }));
    expect(forgotten).toContain("<forgotten");
    const after = readDaemonDb((db) => db.prepare("SELECT is_active, deleted_by FROM memories WHERE id = ?").get(row.id) as { is_active: number; deleted_by: string | null });
    expect(after.is_active).toBe(0);
    // The daemon saw the HOST's clientInfo.name, not "engram-bridge" (#55 actor fidelity).
    expect(after.deleted_by).toBe(HOST_NAME);
    expect(text(await child.client.callTool({ name: "recall", arguments: { query: FACT } }))).not.toContain(`id="${row.id}"`);

    // A daemon-side tool failure comes back exactly as the daemon reports it (an isError result), not as a bridge crash.
    const unknown = await child.client.callTool({ name: "no_such_tool", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("Unknown tool: no_such_tool");
    // A request the daemon cannot serve at all surfaces as an MCP error to the host.
    await expect(child.client.getPrompt({ name: "nope" })).rejects.toThrow(/Method not found|-32601/);
    expect(child.stderr()).not.toMatch(/Server error|unhandled/i);

    // The daemon dropping the session (what `engram update` restarting it looks like from
    // here) is survived: one reconnect, the call succeeds, the host is told to refresh tools.
    for (const [id, t] of [...http.sessions]) { http.sessions.delete(id); await t.close(); }
    const { tools: again } = await child.client.listTools();
    expect(again).toHaveLength(16);
    expect(child.stderr()).toContain("reopening the daemon session");

    // Nothing heavy was loaded and the impossible DB path was never touched.
    const trace = child.trace();
    expect(trace).toContain("/src/interfaces/mcp/bridge.ts");
    for (const forbidden of FORBIDDEN_IN_BRIDGE) expect(trace, `bridge child must not load ${forbidden}`).not.toContain(forbidden);
    expect(existsSync(IMPOSSIBLE_DB)).toBe(false);
    expect(existsSync(IMPOSSIBLE_DIR)).toBe(false);
  }, 60_000);

  it("runs inline when no daemon answers on the port, and says so", async () => {
    const port = await freePort();
    const child = await spawnCli([], { ENGRAM_MCP_PORT: String(port) });
    children.push(child);

    expect(child.stderr()).toMatch(new RegExp(`Engram MCP: running inline \\(no daemon on :${port} \\(`));
    expect(child.stderr()).toContain("Engram MCP server running via stdio");
    const { tools } = await child.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    // Inline really is the full server.
    expect(child.trace()).toContain("/src/interfaces/mcp/server.ts");
  }, 60_000);

  it("--standalone runs inline even though the daemon is healthy, and never opens a daemon session", async () => {
    const before = http.sessions.size;
    const child = await spawnCli(["--standalone"], { ENGRAM_MCP_PORT: String(daemonPort) });
    children.push(child);

    expect(child.stderr()).toContain("Engram MCP: running inline (--standalone)");
    expect(child.stderr()).not.toContain("bridging");
    const { tools } = await child.client.listTools();
    expect(tools).toHaveLength(16);
    expect(child.trace()).toContain("/src/interfaces/mcp/server.ts");
    expect(http.sessions.size).toBe(before);
  }, 60_000);

  it("ENGRAM_MCP_STANDALONE=1 does the same from the environment (plugin users can opt out without editing args)", async () => {
    const child = await spawnCli([], { ENGRAM_MCP_PORT: String(daemonPort), ENGRAM_MCP_STANDALONE: "1" });
    children.push(child);
    expect(child.stderr()).toContain("Engram MCP: running inline (ENGRAM_MCP_STANDALONE=1)");
    expect((await child.client.listTools()).tools).toHaveLength(16);
  }, 60_000);

  it("exits 0 when the host closes stdin", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI_SRC, "mcp"], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? tmpDir, ENGRAM_MCP_PORT: String(daemonPort), ENGRAM_DB_PATH: IMPOSSIBLE_DB, ENGRAM_DATA_DIR: IMPOSSIBLE_DIR },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    // Wait until it has bridged, then hang up.
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => { if (stderr.includes("bridging stdio")) { clearInterval(tick); resolve(); } }, 50);
    });
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(0);
    expect(stderr).toContain("shutting down (stdin closed)");
  }, 60_000);
});

describe("bridge forwards the bearer token", () => {
  let http: import("../../../src/interfaces/mcp/http.js").EngramHttpServer;
  let port: number;
  const TOKEN = "bridge-test-secret";
  const children: ChildHandle[] = [];

  beforeAll(async () => {
    const { registerToolHandlers } = await import("../../../src/interfaces/mcp/server.js");
    const { createEngramHttpServer } = await import("../../../src/interfaces/mcp/http.js");
    // tools/list never runs a tool, so no worker pool is needed here.
    http = createEngramHttpServer({ port: 0, token: TOKEN, registerHandlers: (srv) => registerToolHandlers(srv), log: silent });
    port = (await http.listen()).port;
  }, 30_000);

  afterAll(async () => {
    for (const c of children.splice(0)) await c.client.close().catch(() => {});
    await http?.close();
  });

  it("with ENGRAM_MCP_TOKEN in the bridge's env the daemon accepts it", async () => {
    const child = await spawnCli([], { ENGRAM_MCP_PORT: String(port), ENGRAM_MCP_TOKEN: TOKEN });
    children.push(child);
    expect(child.stderr()).toContain("bridging stdio");
    expect((await child.client.listTools()).tools).toHaveLength(16);
  }, 60_000);

  it("without it the daemon answers 401 and the bridge fails at startup with a hint (health stays open, so it still tried to bridge)", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", CLI_SRC, "mcp"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? tmpDir, ENGRAM_MCP_PORT: String(port), ENGRAM_DB_PATH: IMPOSSIBLE_DB, ENGRAM_DATA_DIR: IMPOSSIBLE_DIR },
      cwd: REPO_ROOT,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    const client = new Client({ name: HOST_NAME, version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
    expect(stderr).toContain("bridging stdio");
    expect(stderr).toMatch(/cannot connect to the daemon .*unauthorized/);
    expect(stderr).toContain("ENGRAM_MCP_TOKEN");
    await client.close().catch(() => {});
  }, 60_000);
});
