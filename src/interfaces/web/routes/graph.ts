/**
 * Route handlers for graph API endpoints.
 *
 * Handles /graph/api/*, /depth/api/*, /galaxy/api/* routes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { getGraphData, getGraphDiff, getDepthGraphData, computeOptimalThreshold } from "../data/graph-queries.js";
import { handleSseConnection } from "./sse.js";
import { getDreamStatus, startDream } from "./dream.js";

const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } as const;

// ─── Graph API ──────────────────────────────────────────────────

export function handleGraphData(_req: IncomingMessage, res: ServerResponse, db: Database.Database): void {
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(getGraphData(db)));
}

export function handleGraphEvents(req: IncomingMessage, res: ServerResponse, _db: Database.Database): void {
  handleSseConnection(req, res);
}

export function handleGraphDiff(_req: IncomingMessage, res: ServerResponse, db: Database.Database, url: URL): void {
  const since = parseInt(url.searchParams.get("since") ?? "0", 10);
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(getGraphDiff(db, since)));
}

export function handleThreshold(_req: IncomingMessage, res: ServerResponse, db: Database.Database): void {
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(computeOptimalThreshold(db)));
}

// ─── Dream API ──────────────────────────────────────────────────

export function handleDreamStatus(_req: IncomingMessage, res: ServerResponse, db: Database.Database): void {
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(getDreamStatus(db)));
}

export function handleDreamStart(_req: IncomingMessage, res: ServerResponse, _db: Database.Database): void {
  const result = startDream();
  res.writeHead(result.ok ? 200 : 409, JSON_HEADERS);
  res.end(JSON.stringify(result));
}

// ─── Depth (3D) API ─────────────────────────────────────────────

export function handleDepthGraphData(_req: IncomingMessage, res: ServerResponse, db: Database.Database): void {
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(getDepthGraphData(db)));
}
