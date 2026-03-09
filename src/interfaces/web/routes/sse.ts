/**
 * Server-Sent Events (SSE) client management.
 *
 * Tracks connected SSE clients and broadcasts graph data updates
 * when the database WAL file changes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { getGraphData } from "../data/graph-queries.js";

// ─── Client Tracking ────────────────────────────────────────────

const sseClients = new Set<ServerResponse>();

let lastBroadcast = 0;
const BROADCAST_COOLDOWN = 30_000; // 30s minimum between full graph broadcasts

export function getSseClientCount(): number {
  return sseClients.size;
}

// ─── SSE Connection Handler ─────────────────────────────────────

export function handleSseConnection(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("data: connected\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

// ─── Broadcast ──────────────────────────────────────────────────

export function broadcastUpdate(db: Database.Database): void {
  if (sseClients.size === 0) return;
  const now = Date.now();
  if (now - lastBroadcast < BROADCAST_COOLDOWN) return;
  lastBroadcast = now;
  const data = JSON.stringify(getGraphData(db));
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
}
