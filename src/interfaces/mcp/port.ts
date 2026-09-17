/**
 * The MCP HTTP daemon's loopback port, shared by the server (`--port` /
 * `ENGRAM_MCP_PORT`), `engram doctor`'s health probe, and the supervisor
 * launchers (`scripts/run-mcp-daemon.sh`, `scripts/run-mcp-daemon.ps1`).
 */
export const DEFAULT_MCP_PORT = 9907;

/** Parse `ENGRAM_MCP_PORT`: integer 1-65535, else the fallback. */
export function parseMcpPort(raw: string | undefined, fallback: number = DEFAULT_MCP_PORT): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}
