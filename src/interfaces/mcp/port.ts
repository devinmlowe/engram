/**
 * The MCP HTTP daemon's loopback port, shared by the server (`--port` /
 * `ENGRAM_MCP_PORT`), `engram doctor`'s health probe, the stdio bridge
 * (`bridge.ts`, #58/#60) and the supervisor launchers
 * (`scripts/run-mcp-daemon.sh`, `scripts/run-mcp-daemon.ps1`).
 */
import { request as httpRequest } from "node:http";

export const DEFAULT_MCP_PORT = 9907;

/** Parse `ENGRAM_MCP_PORT`: integer 1-65535, else the fallback. */
export function parseMcpPort(raw: string | undefined, fallback: number = DEFAULT_MCP_PORT): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

export interface McpHealthProbe {
  status: number;
  body: string;
}

/**
 * GET http://127.0.0.1:port/health with a short timeout. Rejects on any
 * transport error (connection refused, timeout). Callers decide what a
 * healthy body looks like; see `isEngramDaemonHealth`.
 */
export function probeMcpHealth(port: number, timeoutMs = 1500): Promise<McpHealthProbe> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/health", method: "GET", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => { req.destroy(new Error(`timed out after ${timeoutMs}ms`)); });
    req.on("error", reject);
    req.end();
  });
}

/** True when a `/health` answer is the engram daemon's (`200` + `{"status":"ok"}`), not just something on the port. */
export function isEngramDaemonHealth(probe: McpHealthProbe): boolean {
  if (probe.status !== 200) return false;
  try {
    return (JSON.parse(probe.body) as { status?: unknown }).status === "ok";
  } catch {
    return false;
  }
}
