/**
 * Engram Knowledge Graph Visualizer
 *
 * Standalone HTTP server serving:
 *   /graph        — D3 force-directed knowledge graph (Canvas)
 *   /graph/depth  — Three.js 3D visualization
 *   /graph/galaxy — Orbital mechanics visualization
 *   /graph/words  — D3 word cloud from episodic conversation data
 *   /terminal/*   — SVG views for carbonyl / terminal browsers
 *
 * Every page polls its `.../api/diff` route; the WAL watcher only drops the
 * per-process caches so the next poll sees live data.
 *
 * Usage: PORT=3001 npx tsx src/interfaces/web/server.ts
 */

import Database from "better-sqlite3";
import { assertBindAllowed, resolveWebToken, WEB_TOKEN_ENV, WWW_AUTHENTICATE } from "../mcp/auth.js";
import { gateWebRequest } from "./auth-gate.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { loadConfig } from "../../_core/config/index.js";

// Data queries
import {
  getGraphData,
  getGraphDiff,
  getStats,
  computeOptimalThreshold,
  getCommunityData,
  resetThresholdCache,
} from "./data/graph-queries.js";
import { getWordFrequencies, resetWordCache } from "./data/word-queries.js";
import { getDreamStatus, startDream } from "./routes/dream.js";

// Page templates
import { graphPage } from "./pages/graph.html.js";
import { depthPage } from "./pages/depth.html.js";
import { galaxyPage } from "./pages/galaxy.html.js";
import { wordsPage } from "./pages/words.html.js";

// Terminal-optimized page templates (for carbonyl / terminal browsers)
import { terminalGraphPage } from "./pages/terminal/graph.html.js";
import { terminalDepthPage } from "./pages/terminal/depth.html.js";
import { terminalWordsPage } from "./pages/terminal/words.html.js";
import { terminalCommunitiesPage } from "./pages/terminal/communities.html.js";

// ─── Configuration ──────────────────────────────────────────────

// Resolved through loadConfig() (ENGRAM_DATA_DIR / ENGRAM_DB_PATH aware).
const DB_PATH = loadConfig().dbPath;

const PORT = parseInt(process.env.PORT ?? "3001", 10);
// Bind to loopback by default; ENGRAM_BIND (documented) or HOST (ADR-010) exposes it on the network.
const BIND_HOST = process.env.ENGRAM_BIND?.trim() || process.env.HOST?.trim() || "127.0.0.1";
// ENGRAM_WEB_TOKEN (or ENGRAM_MCP_TOKEN) gates every route except /api/health;
// required when BIND_HOST is not loopback (#27).
const WEB_TOKEN = resolveWebToken(process.env);

const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } as const;

// ─── Routes ─────────────────────────────────────────────────────
// Paths are matched after stripping a trailing slash. Each page's API calls
// live under that page's prefix; the terminal graph and communities pages use
// the bare /api prefix.

const HTML_PAGE = graphPage();
const DEPTH_PAGE = depthPage();
const GALAXY_PAGE = galaxyPage();
const WORDS_PAGE = wordsPage();
const TERMINAL_GRAPH_PAGE = terminalGraphPage();

const PAGES = new Map<string, string>([
  ["/", HTML_PAGE],
  ["/graph", HTML_PAGE],
  ["/graph/depth", DEPTH_PAGE],
  ["/graph/galaxy", GALAXY_PAGE],
  ["/graph/words", WORDS_PAGE],
  ["/terminal", TERMINAL_GRAPH_PAGE],
  ["/terminal/graph", TERMINAL_GRAPH_PAGE],
  ["/terminal/depth", terminalDepthPage()],
  ["/terminal/words", terminalWordsPage()],
  ["/terminal/communities", terminalCommunitiesPage()],
]);

// Legacy page paths
const REDIRECTS = new Map<string, string>([
  ["/depth", "/graph/depth"],
  ["/words", "/graph/words"],
]);

type JsonHandler = (db: Database.Database, url: URL) => unknown;

/** Integer query parameter; NaN would bind as NULL in better-sqlite3, so fall back instead. */
function intParam(url: URL, name: string, fallback: number): number {
  const parsed = parseInt(url.searchParams.get(name) ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const graph: JsonHandler = (db) => getGraphData(db);
const threshold: JsonHandler = (db) => computeOptimalThreshold(db);
const diff: JsonHandler = (db, url) => getGraphDiff(db, intParam(url, "since", 0));

const JSON_ROUTES = new Map<string, JsonHandler>([
  ["/api/graph", graph],
  ["/graph/api/graph", graph],
  ["/graph/depth/api/graph", graph],
  ["/graph/galaxy/api/graph", graph],
  ["/api/threshold", threshold],
  ["/graph/api/threshold", threshold],
  ["/graph/depth/api/threshold", threshold],
  ["/graph/galaxy/api/threshold", threshold],
  ["/graph/api/diff", diff],
  ["/graph/depth/api/diff", diff],
  ["/graph/galaxy/api/diff", diff],
  ["/graph/api/dream/status", (db) => getDreamStatus(db)],
  ["/api/communities", (db) => getCommunityData(db)],
  ["/graph/words/api/words", (db, url) => {
    const limit = intParam(url, "limit", 200);
    return getWordFrequencies(db, limit > 0 ? limit : 200);
  }],
]);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

// ─── HTTP Server ─────────────────────────────────────────────────

function serve() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(DB_PATH + "-wal", () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        // The DB changed (engram sync/dream, hook ingestion, or any external writer).
        // Drop every per-process cache so the next request recomputes from live data;
        // a threshold computed against an empty DB must not outlive the first import.
        resetWordCache();
        resetThresholdCache();
      }, 5000);
    });
  } catch {
    console.log("Note: WAL watcher not available, caches will not refresh until restart");
  }

  // Route handlers are synchronous; an uncaught throw here would take the
  // whole visualizer down, so every request is fenced by handleRequest
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      route(req, res);
    } catch (err) {
      console.error("Request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end("Internal error");
    }
  });

  function route(req: IncomingMessage, res: ServerResponse): void {
    // Fixed base: the Host header is client-controlled and may not parse
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    url.pathname = pathname; // the auth gate must see the same path the router matches

    const gate = gateWebRequest(req, url, WEB_TOKEN);
    if (!gate.ok) {
      res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": WWW_AUTHENTICATE });
      res.end(gate.reason ?? "unauthorized");
      return;
    }
    if (gate.setCookie) res.setHeader("Set-Cookie", gate.setCookie);

    // Liveness probe for the supervisor scripts: the one route with a non-200 JSON path
    if (pathname === "/api/health") {
      try {
        sendJson(res, 200, { status: "ok", uptime: process.uptime(), ...getStats(db) });
      } catch (err) {
        sendJson(res, 503, { status: "error", error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (pathname === "/graph/api/dream/start" && req.method === "POST") {
      const result = startDream();
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    const json = JSON_ROUTES.get(pathname);
    if (json) {
      sendJson(res, 200, json(db, url));
      return;
    }

    const page = PAGES.get(pathname);
    if (page) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page);
      return;
    }

    const redirect = REDIRECTS.get(pathname);
    if (redirect) {
      res.writeHead(301, { Location: redirect });
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  try {
    assertBindAllowed(BIND_HOST, WEB_TOKEN, WEB_TOKEN_ENV);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  server.listen(PORT, BIND_HOST, () => {
    const stats = getStats(db);
    const threshold = computeOptimalThreshold(db);
    console.log(`Engram Visualizer`);
    const base = `http://${BIND_HOST === "0.0.0.0" ? "127.0.0.1" : BIND_HOST}:${PORT}`;
    console.log(`  Graph: ${base}/graph`);
    console.log(`  Depth: ${base}/graph/depth`);
    console.log(`  Galaxy: ${base}/graph/galaxy`);
    console.log(`  Words: ${base}/graph/words`);
    console.log(`  Terminal: ${base}/terminal/graph`);
    console.log(`  ${stats.nodes} nodes, ${stats.edges} edges, ${stats.communities} communities`);
    console.log(`  Auto-threshold: ${threshold.value} (${threshold.nodes} nodes, ${threshold.edges} edges, ${threshold.edgePct}% edge retention)`);
    console.log(`  Auth: ${WEB_TOKEN ? "bearer token / ?token= required (except /api/health)" : "none (loopback only)"}`);
    console.log(`  Watching the WAL for cache refreshes...`);
  });

  process.on("SIGINT", () => {
    watcher?.close();
    db.close();
    process.exit(0);
  });
}

serve();
