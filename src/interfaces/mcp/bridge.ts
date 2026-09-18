/**
 * Daemon-aware stdio entry for the Engram MCP server (#58, decision #60).
 *
 * `engram mcp` (what the Claude Code plugin runs via `npx`) has two ways to
 * serve a stdio host:
 *
 *   bridge — the HTTP daemon answers `GET /health` on the configured port, so
 *            this process is a thin proxy: an MCP SDK *client* over Streamable
 *            HTTP to the daemon's `/mcp`, and an MCP *server* on stdio that
 *            forwards `tools/list`, `tools/call` and `ping`. The daemon keeps
 *            the database connection and the embedding model; the bridge
 *            opens neither. A daemon user therefore never pays the model-load
 *            cost in the host process, and every host shares one warm daemon.
 *   inline — no daemon (or `--standalone` / `ENGRAM_MCP_STANDALONE=1`): the
 *            full server runs in-process on stdio, as it always has.
 *
 * This module must stay light: it is imported before `server.ts`, so a
 * bridged process never loads better-sqlite3 or @xenova/transformers.
 * `tests/interfaces/mcp/bridge.test.ts` pins that (no `_core/db` or
 * `_core/embeddings` import) and drives both modes end to end.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  PingRequestSchema,
  type Implementation,
} from "@modelcontextprotocol/sdk/types.js";
import { ENGRAM_VERSION } from "../../_core/version/index.js";
import { resolveMcpToken } from "./auth.js";
import { DEFAULT_MCP_PORT, isEngramDaemonHealth, parseMcpPort, probeMcpHealth, type McpHealthProbe } from "./port.js";

export const STANDALONE_FLAG = "--standalone";
export const STANDALONE_ENV = "ENGRAM_MCP_STANDALONE";
/** How long the stdio entry waits for `/health` before falling back to inline. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const BRIDGE_CLIENT_NAME = "engram-bridge";

export type StdioMode = "bridge" | "inline";

export interface StdioDecision {
  mode: StdioMode;
  /** The daemon port the decision was made against (`--port`, else `ENGRAM_MCP_PORT`, else 9907). */
  port: number;
  /** The daemon's MCP endpoint. */
  url: string;
  /** Why this mode: `daemon healthy`, `--standalone`, `no daemon on :9907 (ECONNREFUSED)`, ... */
  reason: string;
}

export type HealthProbe = (port: number, timeoutMs: number) => Promise<McpHealthProbe>;

export interface DecideStdioModeOptions {
  args: string[];
  env: NodeJS.ProcessEnv;
  probe?: HealthProbe;
  timeoutMs?: number;
}

/** `--port N` from the stdio args, when present and valid. */
export function portFromArgs(args: string[]): number | undefined {
  const idx = args.indexOf("--port");
  if (idx < 0) return undefined;
  const n = Number.parseInt(args[idx + 1] ?? "", 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

function isTruthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `ECONNREFUSED` / `ETIMEDOUT` when the error carries a code, else its message. */
function errShort(err: unknown): string {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return typeof code === "string" && code ? code : errMsg(err);
}

/**
 * Choose bridge or inline for a stdio start. Pure apart from the probe, so
 * tests inject one. `--standalone` and `ENGRAM_MCP_STANDALONE` win without
 * probing; otherwise one `GET /health` with a short timeout decides.
 */
export async function decideStdioMode(options: DecideStdioModeOptions): Promise<StdioDecision> {
  const { args, env, probe = probeMcpHealth, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = options;
  const port = portFromArgs(args) ?? parseMcpPort(env.ENGRAM_MCP_PORT, DEFAULT_MCP_PORT);
  const url = `http://127.0.0.1:${port}/mcp`;

  if (args.includes(STANDALONE_FLAG)) return { mode: "inline", port, url, reason: STANDALONE_FLAG };
  if (isTruthy(env[STANDALONE_ENV])) return { mode: "inline", port, url, reason: `${STANDALONE_ENV}=${env[STANDALONE_ENV]?.trim()}` };

  try {
    const health = await probe(port, timeoutMs);
    if (isEngramDaemonHealth(health)) return { mode: "bridge", port, url, reason: "daemon healthy" };
    return {
      mode: "inline", port, url,
      reason: `something answers on :${port} but not like the engram daemon (HTTP ${health.status})`,
    };
  } catch (err) {
    return { mode: "inline", port, url, reason: `no daemon on :${port} (${errShort(err)})` };
  }
}

/** The one stderr line the stdio entry logs about its mode. */
export function describeStdioDecision(d: StdioDecision): string {
  return d.mode === "bridge"
    ? `Engram MCP: bridging stdio to ${d.url} (${d.reason})`
    : `Engram MCP: running inline (${d.reason})`;
}

// ─── Bridge ────────────────────────────────────────────────────

export interface BridgeOptions {
  /** The daemon's `/mcp` URL. */
  url: string;
  /** Bearer token for the daemon (`ENGRAM_MCP_TOKEN` from the bridge's own env). */
  token?: string;
  log?: (line: string) => void;
  /** Called after the stdio side closes (stdin EOF) or a signal; defaults to `process.exit`. */
  onExit?: (code: number) => void;
  /** Test hook: the host-facing transport (defaults to stdio). */
  serverTransport?: () => Parameters<Server["connect"]>[0];
}

export interface BridgeHandle {
  server: Server;
  /** The daemon's serverInfo as seen at connect time. */
  daemon: Implementation;
  close(): Promise<void>;
}

/** Strip the SDK's `MCP error <code>: ` prefix so a forwarded error is not prefixed once per hop. */
function bareMessage(err: McpError): string {
  return err.message.replace(/^MCP error -?\d+:\s*/, "");
}

/**
 * Run the stdio ↔ Streamable-HTTP proxy. Resolves once the stdio transport
 * is connected; the process then lives until stdin closes. Rejects (before
 * touching stdio) when the daemon refuses the first connection, e.g. 401
 * without `ENGRAM_MCP_TOKEN`, so the host sees a clear startup failure.
 */
export async function runBridge(options: BridgeOptions): Promise<BridgeHandle> {
  const log = options.log ?? ((line: string) => console.error(line));
  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  const url = new URL(options.url);
  const headers = options.token ? { Authorization: `Bearer ${options.token}` } : undefined;

  // The daemon session. Opened with the bridge's own identity first (so the
  // daemon's serverInfo/capabilities are known before the host's initialize),
  // then re-opened under the host's clientInfo once the host has introduced
  // itself, so `forget` records the real actor (#55) instead of the bridge.
  let identity: Implementation = { name: BRIDGE_CLIENT_NAME, version: ENGRAM_VERSION };
  let current: { client: Client; transport: StreamableHTTPClientTransport } | null = null;
  let pending: Promise<Client> | null = null;
  let closing = false;

  const open = async (): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined);
    const client = new Client(identity);
    await client.connect(transport);
    const previous = current;
    current = { client, transport };
    if (previous) await dispose(previous);
    return client;
  };

  const dispose = async (s: { client: Client; transport: StreamableHTTPClientTransport }) => {
    await s.transport.terminateSession().catch(() => {});
    await s.client.close().catch(() => {});
  };

  /** The live client, waiting on any (re)connect in flight. */
  const session = (): Promise<Client> => {
    if (pending) return pending;
    if (current) return Promise.resolve(current.client);
    pending = open().finally(() => { pending = null; });
    return pending;
  };

  const reconnect = (why: string): Promise<Client> => {
    if (!pending) {
      log(`Engram MCP bridge: reopening the daemon session at ${url} (${why})`);
      pending = open().finally(() => { pending = null; });
    }
    return pending;
  };

  // First connection, before any stdio traffic: a refused/unauthenticated
  // daemon fails the start instead of every later call.
  let daemon: Implementation;
  let instructions: string | undefined;
  try {
    const client = await session();
    daemon = client.getServerVersion() ?? { name: "engram", version: "unknown" };
    instructions = client.getInstructions();
  } catch (err) {
    const hint = /401|unauthorized/i.test(errMsg(err))
      ? ` — the daemon requires a bearer token; set ENGRAM_MCP_TOKEN in this process's environment`
      : "";
    throw new Error(`Engram MCP bridge: cannot connect to the daemon at ${url}: ${errMsg(err)}${hint}`);
  }

  const server = new Server(
    { name: daemon.name, version: daemon.version },
    {
      capabilities: { tools: { listChanged: true } },
      instructions,
    },
  );

  /**
   * Forward one call. A JSON-RPC error from the daemon (unknown tool, bad
   * params, tool failure) is the answer and goes back verbatim; a transport
   * failure (daemon restarted by `engram update`, session expired, connection
   * refused) gets one reconnect + retry before it becomes an InternalError.
   */
  const forward = async <T>(what: string, op: (client: Client) => Promise<T>): Promise<T> => {
    const client = await session().catch((err) => {
      throw new McpError(ErrorCode.InternalError, `engram daemon at ${url} unreachable: ${errMsg(err)}`);
    });
    try {
      return await op(client);
    } catch (err) {
      if (err instanceof McpError) throw new McpError(err.code, bareMessage(err), err.data);
      try {
        const again = await reconnect(`${what} failed: ${errMsg(err)}`);
        const result = await op(again);
        // The daemon may have come back as a newer build; let the host refresh.
        server.sendToolListChanged().catch(() => {});
        return result;
      } catch (retryErr) {
        if (retryErr instanceof McpError) throw new McpError(retryErr.code, bareMessage(retryErr), retryErr.data);
        throw new McpError(ErrorCode.InternalError, `engram daemon at ${url} unreachable: ${errMsg(retryErr)}`);
      }
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, (req) => forward("tools/list", (c) => c.listTools(req.params)));
  server.setRequestHandler(CallToolRequestSchema, (req) => forward(`tools/call ${req.params.name}`, (c) => c.callTool(req.params)));
  server.setRequestHandler(PingRequestSchema, () => forward("ping", (c) => c.ping()).then(() => ({})));

  // Once the host has said who it is, talk to the daemon under that name.
  server.oninitialized = () => {
    const host = server.getClientVersion();
    if (!host || host.name === identity.name) return;
    identity = { name: host.name, version: host.version };
    void reconnect(`host is ${host.name}`).catch((err) => log(`Engram MCP bridge: ${errMsg(err)}`));
  };

  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => {});
    if (current) await dispose(current);
    current = null;
  };

  const shutdown = (why: string, code = 0) => {
    if (closing) return;
    log(`Engram MCP bridge: shutting down (${why})`);
    close().finally(() => onExit(code));
  };

  const transport = options.serverTransport ? options.serverTransport() : new StdioServerTransport();
  transport.onclose = () => shutdown("host transport closed");
  if (!options.serverTransport) {
    // The SDK's stdio transport does not watch for EOF, and the daemon session's
    // SSE stream would keep the event loop alive after the host hung up; exit
    // when stdin ends so a closed host never leaves a bridge behind.
    process.stdin.once("end", () => shutdown("stdin closed"));
    process.stdin.once("close", () => shutdown("stdin closed"));
  }
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  await server.connect(transport);

  return { server, daemon, close };
}

// ─── Stdio entry ───────────────────────────────────────────────

export interface StdioEntryOptions extends DecideStdioModeOptions {
  /** Start the full in-process server on stdio (lazily imports server.ts). */
  inline: () => Promise<void>;
  log?: (line: string) => void;
}

/**
 * The shared stdio start used by `engram mcp` and by
 * `node dist/interfaces/mcp/server.js`: decide, log one line, run.
 */
export async function runStdioEntry(options: StdioEntryOptions): Promise<StdioDecision> {
  const log = options.log ?? ((line: string) => console.error(line));
  const decision = await decideStdioMode(options);
  log(describeStdioDecision(decision));
  if (decision.mode === "bridge") {
    await runBridge({ url: decision.url, token: resolveMcpToken(options.env), log });
  } else {
    await options.inline();
  }
  return decision;
}
