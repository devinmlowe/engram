/**
 * Visualizer request gate (#27). With a token configured every route needs
 * it except `/api/health` (supervisor probes). Browsers cannot attach an
 * `Authorization` header to page loads or `EventSource`, so the token is
 * also accepted as `?token=` on any request and, once presented that way on
 * a page, remembered in an HttpOnly cookie for the page's own API calls.
 */
import type { IncomingMessage } from "node:http";
import { bearerFromHeaders, tokensEqual } from "../mcp/auth.js";

export const WEB_TOKEN_COOKIE = "engram_token";
export const OPEN_WEB_PATHS = new Set(["/api/health", "/graph/api/health"]);

export interface GateDecision {
  /** true: serve the request. */
  ok: boolean;
  /** Set when the token arrived in the query string: persist it for the page's API calls. */
  setCookie?: string;
  /** 401 body when `ok` is false. */
  reason?: string;
}

function cookieValue(req: Pick<IncomingMessage, "headers">, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function gateWebRequest(
  req: Pick<IncomingMessage, "headers">,
  url: URL,
  token: string | undefined,
): GateDecision {
  if (!token) return { ok: true };
  if (OPEN_WEB_PATHS.has(url.pathname)) return { ok: true };
  if (tokensEqual(bearerFromHeaders(req), token)) return { ok: true };
  if (tokensEqual(cookieValue(req, WEB_TOKEN_COOKIE), token)) return { ok: true };
  const q = url.searchParams.get("token") ?? undefined;
  if (tokensEqual(q, token)) {
    return {
      ok: true,
      setCookie: `${WEB_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`,
    };
  }
  return { ok: false, reason: "unauthorized: send Authorization: Bearer <token>, or open a page with ?token=<token> once" };
}
