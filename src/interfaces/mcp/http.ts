/**
 * Streamable-HTTP front end for the Engram MCP server.
 *
 * One `Server` + `StreamableHTTPServerTransport` per client session (the
 * transport carries a per-instance `_initialized` flag, so a shared one
 * rejects the second client's initialize with "Server already initialized").
 * Sessions are routed by the `Mcp-Session-Id` header.
 *
 * `/health` is answered directly by the Node HTTP handler and never touches
 * the MCP layer or a tool handler, so it stays fast as long as the main
 * thread's event loop is free — which the worker pool guarantees.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface EngramHttpOptions {
  port: number;
  /** Bind address. Default 127.0.0.1 — the server has no auth. */
  host?: string;
  /** Registers list-tools / call-tool handlers on each per-session Server. */
  registerHandlers: (server: Server) => void;
  serverInfo?: { name: string; version: string };
  /** Extra fields merged into the `/health` JSON body. */
  health?: () => Record<string, unknown>;
  log?: (message: string) => void;
}

export interface EngramHttpServer {
  httpServer: HttpServer;
  /** Live MCP sessions keyed by session id. */
  sessions: Map<string, StreamableHTTPServerTransport>;
  /** Start listening; resolves with the bound address. */
  listen(): Promise<AddressInfo>;
  /** Close every session transport and the HTTP listener. */
  close(): Promise<void>;
}

export function createEngramHttpServer(options: EngramHttpOptions): EngramHttpServer {
  const host = options.host ?? "127.0.0.1";
  const log = options.log ?? ((m) => console.error(m));
  const serverInfo = options.serverInfo ?? { name: "engram", version: "0.1.0" };
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // DELETE = session teardown
    if (req.method === "DELETE" && sessionId) {
      const transport = sessions.get(sessionId);
      if (transport) {
        sessions.delete(sessionId);
        await transport.close();
      }
      res.writeHead(200);
      res.end();
      return;
    }

    // Existing session — route to its transport
    if (sessionId && sessions.has(sessionId)) {
      try {
        await sessions.get(sessionId)!.handleRequest(req, res);
      } catch (error) {
        log(`MCP error (session ${sessionId}): ${String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { error: String(error) });
      }
      return;
    }

    // New session (initialize, or any request without a known session id).
    // Don't consume the body stream — handleRequest reads it itself.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const sessionServer = new Server(serverInfo, { capabilities: { tools: {} } });
    options.registerHandlers(sessionServer);
    await sessionServer.connect(transport);
    try {
      await transport.handleRequest(req, res);
      if (transport.sessionId) {
        sessions.set(transport.sessionId, transport);
      }
    } catch (error) {
      log(`MCP initialize error: ${String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: String(error) });
    }
  };

  const httpServer = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/health" || url === "/") {
      sendJson(res, 200, { status: "ok", ...(options.health?.() ?? {}) });
      return;
    }
    if (url === "/mcp") {
      handleMcp(req, res).catch((error) => {
        log(`MCP handler crashed: ${String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { error: String(error) });
      });
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  return {
    httpServer,
    sessions,
    listen: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(options.port, host, () => {
          httpServer.off("error", reject);
          resolve(httpServer.address() as AddressInfo);
        });
      }),
    close: async () => {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map((t) => t.close()));
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      });
    },
  };
}
