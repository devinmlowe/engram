/**
 * Optional bearer-token authentication for the HTTP MCP daemon and the web
 * visualizer (#27). Both bind 127.0.0.1 by default and rely on that for
 * access control; with a token set, `/mcp` and the visualizer API require
 * `Authorization: Bearer <token>`, and a non-loopback bind is refused
 * unless a token is configured. `/health` stays open for supervisors.
 *
 * The token is read from an environment variable and compared in constant
 * time; it is never logged or echoed.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const MCP_TOKEN_ENV = "ENGRAM_MCP_TOKEN";
export const WEB_TOKEN_ENV = "ENGRAM_WEB_TOKEN";

/** The MCP daemon token, or undefined when auth is off. Blank counts as unset. */
export function resolveMcpToken(env: Record<string, string | undefined>): string | undefined {
  const t = env[MCP_TOKEN_ENV]?.trim();
  return t ? t : undefined;
}

/** The visualizer token: ENGRAM_WEB_TOKEN, falling back to ENGRAM_MCP_TOKEN. */
export function resolveWebToken(env: Record<string, string | undefined>): string | undefined {
  const t = env[WEB_TOKEN_ENV]?.trim();
  return t ? t : resolveMcpToken(env);
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Throws when `host` is not loopback and no token protects the server. */
export function assertBindAllowed(host: string, token: string | undefined, tokenEnv: string): void {
  if (isLoopbackHost(host) || token) return;
  throw new Error(
    `refusing to bind ${host} without authentication: set ${tokenEnv} to a secret and clients must send "Authorization: Bearer <token>", or bind 127.0.0.1`,
  );
}

export function tokensEqual(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>` from a request, or undefined. */
export function bearerFromHeaders(req: Pick<IncomingMessage, "headers">): string | undefined {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const m = value?.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return m ? m[1] : undefined;
}

export const WWW_AUTHENTICATE = 'Bearer realm="engram"';
