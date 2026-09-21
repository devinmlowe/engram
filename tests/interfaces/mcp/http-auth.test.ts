/**
 * #27: optional bearer-token auth on the HTTP MCP daemon. `/health` stays
 * open for supervisors; `/mcp` needs `Authorization: Bearer <token>` once a
 * token is configured; a non-loopback bind without a token is refused.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createEngramHttpServer, type EngramHttpServer } from "../../../src/interfaces/mcp/http.js";
import {
  assertBindAllowed, bearerFromHeaders, isLoopbackHost, resolveMcpToken, resolveWebToken, tokensEqual,
} from "../../../src/interfaces/mcp/auth.js";
import { gateWebRequest, WEB_TOKEN_COOKIE } from "../../../src/interfaces/web/auth-gate.js";

const servers: EngramHttpServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

async function start(opts: { token?: string; host?: string }) {
  const http = createEngramHttpServer({
    port: 0, host: opts.host, token: opts.token,
    registerHandlers: (_srv: Server) => {},
    log: () => {},
  });
  servers.push(http);
  const addr = await http.listen();
  return { http, port: addr.port };
}

const INIT = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("auth helpers", () => {
  it("token resolution trims and treats blank as unset; web falls back to the MCP token", () => {
    expect(resolveMcpToken({})).toBeUndefined();
    expect(resolveMcpToken({ ENGRAM_MCP_TOKEN: "  " })).toBeUndefined();
    expect(resolveMcpToken({ ENGRAM_MCP_TOKEN: " abc " })).toBe("abc");
    expect(resolveWebToken({ ENGRAM_MCP_TOKEN: "m" })).toBe("m");
    expect(resolveWebToken({ ENGRAM_MCP_TOKEN: "m", ENGRAM_WEB_TOKEN: "w" })).toBe("w");
  });

  it("loopback detection and the bind rule", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["0.0.0.0", "10.0.0.5", "::", "example.com"]) expect(isLoopbackHost(h), h).toBe(false);
    expect(() => assertBindAllowed("127.0.0.1", undefined, "X")).not.toThrow();
    expect(() => assertBindAllowed("0.0.0.0", "t", "X")).not.toThrow();
    expect(() => assertBindAllowed("0.0.0.0", undefined, "ENGRAM_MCP_TOKEN")).toThrow(/refusing to bind 0\.0\.0\.0.*ENGRAM_MCP_TOKEN/);
  });

  it("bearer parsing and constant-time compare", () => {
    expect(bearerFromHeaders({ headers: { authorization: "Bearer abc" } })).toBe("abc");
    expect(bearerFromHeaders({ headers: { authorization: "bearer  abc " } })).toBe("abc");
    expect(bearerFromHeaders({ headers: { authorization: "Basic abc" } })).toBeUndefined();
    expect(bearerFromHeaders({ headers: {} })).toBeUndefined();
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abd", "abc")).toBe(false);
    expect(tokensEqual("ab", "abc")).toBe(false);
    expect(tokensEqual(undefined, "abc")).toBe(false);
  });
});

describe("HTTP MCP daemon bearer token", () => {
  it("without a token everything works as before", async () => {
    const { port } = await start({});
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body: INIT });
    expect(r.status).toBe(200);
  });

  it("with a token: /health open, /mcp 401 without or with a wrong bearer, 200 with the right one", async () => {
    const { port } = await start({ token: "s3cr3t" });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const none = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body: INIT });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await none.json()).error).toContain("Bearer");
    const wrong = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body: INIT });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { ...headers, authorization: "Bearer s3cr3t" }, body: INIT });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("refuses a non-loopback bind without a token, before binding", async () => {
    const http = createEngramHttpServer({ port: 0, host: "0.0.0.0", registerHandlers: () => {}, log: () => {} });
    await expect(http.listen()).rejects.toThrow(/refusing to bind 0\.0\.0\.0/);
    expect(http.httpServer.listening).toBe(false);
  });
});

describe("visualizer gate", () => {
  const url = (path: string) => new URL(path, "http://localhost");
  it("no token configured: everything passes", () => {
    expect(gateWebRequest({ headers: {} }, url("/graph"), undefined)).toEqual({ ok: true });
  });
  it("token configured: health open; bearer, cookie, or ?token= accepted; ?token= sets the cookie", () => {
    expect(gateWebRequest({ headers: {} }, url("/api/health"), "t").ok).toBe(true);
    expect(gateWebRequest({ headers: {} }, url("/graph/api/health"), "t").ok).toBe(false); // alias removed (#122)
    const denied = gateWebRequest({ headers: {} }, url("/api/graph"), "t");
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("Bearer");
    expect(gateWebRequest({ headers: { authorization: "Bearer t" } }, url("/api/graph"), "t").ok).toBe(true);
    expect(gateWebRequest({ headers: { cookie: `x=1; ${WEB_TOKEN_COOKIE}=t` } }, url("/graph/api/diff"), "t").ok).toBe(true);
    expect(gateWebRequest({ headers: { cookie: `${WEB_TOKEN_COOKIE}=wrong` } }, url("/graph"), "t").ok).toBe(false);
    const viaQuery = gateWebRequest({ headers: {} }, url("/graph?token=t"), "t");
    expect(viaQuery.ok).toBe(true);
    expect(viaQuery.setCookie).toMatch(new RegExp(`^${WEB_TOKEN_COOKIE}=t; Path=/; HttpOnly; SameSite=Strict$`));
    expect(gateWebRequest({ headers: {} }, url("/graph?token=nope"), "t").ok).toBe(false);
  });
});
