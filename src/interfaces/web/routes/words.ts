/**
 * Route handler for word frequency API endpoint.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { getWordFrequencies } from "../data/word-queries.js";

export function handleWordFrequencies(_req: IncomingMessage, res: ServerResponse, db: Database.Database, url: URL): void {
  const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(getWordFrequencies(db, limit)));
}
