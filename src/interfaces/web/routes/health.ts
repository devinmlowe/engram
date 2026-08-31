/**
 * Route handler for the health endpoint.
 *
 * Handles /api/health — lightweight liveness check with DB stats.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { getStats } from "../data/graph-queries.js";

const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } as const;

export function handleHealth(_req: IncomingMessage, res: ServerResponse, db: Database.Database): void {
  try {
    const stats = getStats(db);
    res.writeHead(200, JSON_HEADERS);
    res.end(
      JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        ...stats,
      }),
    );
  } catch (err) {
    res.writeHead(503, JSON_HEADERS);
    res.end(
      JSON.stringify({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
