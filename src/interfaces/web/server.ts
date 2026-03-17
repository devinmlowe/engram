/**
 * Engram Knowledge Graph Visualizer
 *
 * Standalone HTTP server serving:
 *   /graph        — D3 force-directed knowledge graph (Canvas)
 *   /graph/depth  — Three.js 3D visualization
 *   /graph/galaxy — Orbital mechanics visualization
 *   /graph/words  — D3 word cloud from episodic conversation data
 *
 * Watches the SQLite WAL for changes and pushes updates via SSE.
 *
 * Usage: npx tsx src/interfaces/web/server.ts [--port 3000]
 */

import Database from "better-sqlite3";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Data queries
import { getStats, computeOptimalThreshold } from "./data/graph-queries.js";

// Route handlers
import {
  handleGraphData,
  handleGraphEvents,
  handleGraphDiff,
  handleThreshold,
  handleDreamStatus,
  handleDreamStart,
  handleDepthGraphData,
  handleCommunityData,
} from "./routes/graph.js";
import { handleWordFrequencies } from "./routes/words.js";
import { broadcastUpdate } from "./routes/sse.js";

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

const DB_PATH =
  process.env.ENGRAM_DB_PATH ??
  join(homedir(), ".local", "share", "engram", "engram.db");

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ─── Pre-render pages ───────────────────────────────────────────

const HTML_PAGE = graphPage();
const DEPTH_PAGE = depthPage();
const GALAXY_PAGE = galaxyPage();
const WORDS_PAGE = wordsPage();

// Terminal-optimized pages (pre-rendered)
const TERMINAL_GRAPH_PAGE = terminalGraphPage();
const TERMINAL_DEPTH_PAGE = terminalDepthPage();
const TERMINAL_WORDS_PAGE = terminalWordsPage();
const TERMINAL_COMMUNITIES_PAGE = terminalCommunitiesPage();

// ─── HTTP Server ─────────────────────────────────────────────────

function serve() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(DB_PATH + "-wal", () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => broadcastUpdate(db), 5000);
    });
  } catch {
    console.log("Note: WAL watcher not available, SSE updates disabled");
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ─── Threshold route ────────────────────────────────
    if (pathname === "/api/threshold" || pathname === "/graph/api/threshold" || pathname === "/depth/api/threshold" || pathname === "/graph/depth/api/threshold") {
      handleThreshold(req, res, db);
      return;
    }

    // ─── Graph routes ──────────────────────────────────
    if (pathname === "/graph/api/graph" || pathname === "/api/graph") {
      handleGraphData(req, res, db);
      return;
    }

    if (pathname === "/graph/api/events" || pathname === "/api/events") {
      handleGraphEvents(req, res, db);
      return;
    }

    // ─── Diff route ────────────────────────────────────
    if (pathname === "/api/diff" || pathname === "/graph/api/diff" || pathname === "/depth/api/diff" || pathname === "/graph/depth/api/diff") {
      handleGraphDiff(req, res, db, url);
      return;
    }

    // ─── Dream routes ──────────────────────────────────
    if (pathname === "/api/dream/status" || pathname === "/graph/api/dream/status") {
      handleDreamStatus(req, res, db);
      return;
    }

    if ((pathname === "/api/dream/start" || pathname === "/graph/api/dream/start") && req.method === "POST") {
      handleDreamStart(req, res, db);
      return;
    }

    // ─── Depth (3D) routes ────────────────────────────
    if (pathname === "/depth/api/graph" || pathname === "/graph/depth/api/graph") {
      handleDepthGraphData(req, res, db);
      return;
    }

    if (pathname === "/graph/depth" || pathname === "/graph/depth/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(DEPTH_PAGE);
      return;
    }

    // ─── Galaxy routes ─────────────────────────────────
    if (pathname === "/graph/galaxy/api/graph") {
      handleDepthGraphData(req, res, db);
      return;
    }

    if (pathname === "/graph/galaxy/api/diff") {
      handleGraphDiff(req, res, db, url);
      return;
    }

    if (pathname === "/graph/galaxy/api/threshold") {
      handleThreshold(req, res, db);
      return;
    }

    if (pathname === "/graph/galaxy" || pathname === "/graph/galaxy/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(GALAXY_PAGE);
      return;
    }

    // Legacy redirects
    if (pathname === "/depth" || pathname === "/depth/") {
      res.writeHead(301, { Location: "/graph/depth" });
      res.end();
      return;
    }
    if (pathname === "/words" || pathname === "/words/") {
      res.writeHead(301, { Location: "/graph/words" });
      res.end();
      return;
    }

    // ─── Communities routes ───────────────────────────
    if (pathname === "/api/communities") {
      handleCommunityData(req, res, db);
      return;
    }

    // ─── Words routes ──────────────────────────────────
    if (pathname === "/words/api/words" || pathname === "/api/words" || pathname === "/graph/words/api/words") {
      handleWordFrequencies(req, res, db, url);
      return;
    }

    if (pathname === "/graph/words" || pathname === "/graph/words/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(WORDS_PAGE);
      return;
    }

    // ─── Terminal-optimized routes (for carbonyl) ──────
    if (pathname === "/terminal/graph" || pathname === "/terminal/graph/" || pathname === "/terminal" || pathname === "/terminal/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(TERMINAL_GRAPH_PAGE);
      return;
    }

    if (pathname === "/terminal/depth" || pathname === "/terminal/depth/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(TERMINAL_DEPTH_PAGE);
      return;
    }

    if (pathname === "/terminal/words" || pathname === "/terminal/words/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(TERMINAL_WORDS_PAGE);
      return;
    }

    if (pathname === "/terminal/communities" || pathname === "/terminal/communities/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(TERMINAL_COMMUNITIES_PAGE);
      return;
    }

    // ─── Default: graph page ───────────────────────────
    if (pathname === "/graph" || pathname === "/graph/" || pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HTML_PAGE);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(PORT, "0.0.0.0", () => {
    const stats = getStats(db);
    const threshold = computeOptimalThreshold(db);
    console.log(`Engram Visualizer`);
    console.log(`  Graph: https://127.0.0.1/graph`);
    console.log(`  Depth: https://127.0.0.1/graph/depth`);
    console.log(`  Galaxy: https://127.0.0.1/graph/galaxy`);
    console.log(`  Words: https://127.0.0.1/graph/words`);
    console.log(`  Terminal: https://127.0.0.1/terminal/graph`);
    console.log(`  ${stats.nodes} nodes, ${stats.edges} edges, ${stats.communities} communities`);
    console.log(`  Auto-threshold: ${threshold.value} (${threshold.nodes} nodes, ${threshold.edges} edges, ${threshold.edgePct}% edge retention)`);
    console.log(`  Watching for real-time updates...`);
  });

  process.on("SIGINT", () => {
    watcher?.close();
    db.close();
    process.exit(0);
  });
}

serve();
