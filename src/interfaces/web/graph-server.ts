/**
 * Engram Knowledge Graph Visualizer
 *
 * Standalone HTTP server serving:
 *   /graph  — D3 force-directed knowledge graph (Canvas)
 *   /words  — D3 word cloud from episodic conversation data
 *
 * Watches the SQLite WAL for changes and pushes updates via SSE.
 *
 * Usage: npx tsx src/web/graph-server.ts [--port 3000]
 */

import Database from "better-sqlite3";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { watch, type FSWatcher, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

const DB_PATH =
  process.env.ENGRAM_DB_PATH ??
  join(homedir(), ".local", "share", "engram", "engram.db");

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ─── Database ────────────────────────────────────────────────────

function getGraphData(db: Database.Database) {
  const entities = db
    .prepare(
      `SELECT id, name, type, description, mention_count as mentionCount,
              COALESCE(first_seen, created_at) as firstSeen,
              created_at as createdAt
       FROM entities ORDER BY mention_count DESC`
    )
    .all() as Array<{
    id: string;
    name: string;
    type: string;
    description: string | null;
    mentionCount: number;
    firstSeen: number | null;
    createdAt: number | null;
  }>;

  const relationships = db
    .prepare(
      `SELECT r.source_entity_id as source, r.target_entity_id as target,
              r.type, r.weight, r.context
       FROM relationships r`
    )
    .all() as Array<{
    source: string;
    target: string;
    type: string;
    weight: number;
    context: string | null;
  }>;

  const clusters = db
    .prepare("SELECT name, entity_ids FROM topic_clusters")
    .all() as Array<{ name: string; entity_ids: string }>;

  const entityCommunity: Record<string, string> = {};
  for (const c of clusters) {
    try {
      const ids: string[] = JSON.parse(c.entity_ids);
      for (const id of ids) {
        if (!entityCommunity[id]) entityCommunity[id] = c.name;
      }
    } catch { /* skip */ }
  }

  return {
    nodes: entities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      description: e.description,
      mentionCount: e.mentionCount,
      firstSeen: e.firstSeen ?? e.createdAt ?? 0,
      community: entityCommunity[e.id] ?? null,
    })),
    links: relationships.map((r) => ({
      source: r.source,
      target: r.target,
      type: r.type,
      weight: r.weight,
      context: r.context,
    })),
  };
}

function getStats(db: Database.Database) {
  const nodes = (db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
  const edges = (db.prepare("SELECT COUNT(*) as c FROM relationships").get() as { c: number }).c;
  const communities = (db.prepare("SELECT COUNT(*) as c FROM topic_clusters").get() as { c: number }).c;
  return { nodes, edges, communities };
}

/**
 * Compute optimal mention threshold by maximizing edge retention efficiency
 * within a target node count band (1500–4000 for rendering performance).
 *
 * Metric: edge_retention% / node_retention% — highest value means we're
 * shedding the most structurally unimportant nodes while keeping edges.
 *
 * Cached at startup since the distribution changes only during dream runs.
 */
let cachedThreshold: { value: number; nodes: number; edges: number; edgePct: number } | null = null;

function computeOptimalThreshold(db: Database.Database): { value: number; nodes: number; edges: number; edgePct: number } {
  if (cachedThreshold) return cachedThreshold;

  const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
  const totalEdges = (db.prepare("SELECT COUNT(*) as c FROM relationships").get() as { c: number }).c;

  if (totalNodes === 0) {
    cachedThreshold = { value: 1, nodes: 0, edges: 0, edgePct: 100 };
    return cachedThreshold;
  }

  // Get distinct mention counts as candidate thresholds
  const candidates = db.prepare(
    `SELECT DISTINCT mention_count as t FROM entities
     WHERE mention_count BETWEEN 1 AND 100
     ORDER BY mention_count`
  ).all() as Array<{ t: number }>;

  const NODE_MIN = 1500;
  const NODE_MAX = 4000;

  let best = { value: 1, nodes: totalNodes, edges: totalEdges, edgePct: 100, score: 1 };

  for (const { t } of candidates) {
    const nodeCount = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE mention_count >= ?"
    ).get(t) as { c: number }).c;

    // Skip if outside performance band
    if (nodeCount > NODE_MAX && t > 1) continue;
    if (nodeCount < NODE_MIN) break; // thresholds only go up, so we're done

    const edgeCount = (db.prepare(
      `SELECT COUNT(*) as c FROM relationships r
       WHERE EXISTS (SELECT 1 FROM entities e WHERE e.id = r.source_entity_id AND e.mention_count >= ?)
         AND EXISTS (SELECT 1 FROM entities e WHERE e.id = r.target_entity_id AND e.mention_count >= ?)`
    ).get(t, t) as { c: number }).c;

    const nodePct = nodeCount / totalNodes;
    const edgePct = edgeCount / totalEdges;
    const score = edgePct / nodePct; // > 1 means we keep proportionally more edges than nodes

    if (score >= best.score) {
      best = { value: t, nodes: nodeCount, edges: edgeCount, edgePct: Math.round(edgePct * 1000) / 10, score };
    }
  }

  // If all thresholds leave us above NODE_MAX, pick the first one that drops below
  if (best.nodes > NODE_MAX) {
    for (const { t } of candidates) {
      const nodeCount = (db.prepare(
        "SELECT COUNT(*) as c FROM entities WHERE mention_count >= ?"
      ).get(t) as { c: number }).c;
      if (nodeCount <= NODE_MAX) {
        const edgeCount = (db.prepare(
          `SELECT COUNT(*) as c FROM relationships r
           WHERE EXISTS (SELECT 1 FROM entities e WHERE e.id = r.source_entity_id AND e.mention_count >= ?)
             AND EXISTS (SELECT 1 FROM entities e WHERE e.id = r.target_entity_id AND e.mention_count >= ?)`
        ).get(t, t) as { c: number }).c;
        best = { value: t, nodes: nodeCount, edges: edgeCount, edgePct: Math.round((edgeCount / totalEdges) * 1000) / 10, score: 0 };
        break;
      }
    }
  }

  cachedThreshold = { value: best.value, nodes: best.nodes, edges: best.edges, edgePct: best.edgePct };
  return cachedThreshold;
}

// ─── Graph Diff ──────────────────────────────────────────────────

function getGraphDiff(db: Database.Database, since: number) {
  const newNodes = db.prepare(
    `SELECT e.id, e.name, e.type, e.description, e.mention_count as mentionCount,
            COALESCE(e.last_seen, e.created_at) as lastActive, e.created_at as createdAt,
            e.first_seen as firstSeen,
            COALESCE(bs.bridge_score, 0) as bridgeScore
     FROM entities e
     LEFT JOIN bridge_scores bs ON bs.entity_id = e.id
       AND bs.generation = (SELECT MAX(generation) FROM bridge_scores)
     WHERE e.created_at > ?`
  ).all(since) as Array<{ id: string; name: string; type: string; description: string | null; mentionCount: number; lastActive: number | null; createdAt: number | null; firstSeen: number | null; bridgeScore: number }>;

  const updatedNodes = db.prepare(
    `SELECT e.id, e.name, e.type, e.description, e.mention_count as mentionCount,
            COALESCE(e.last_seen, e.created_at) as lastActive, e.created_at as createdAt,
            e.first_seen as firstSeen,
            COALESCE(bs.bridge_score, 0) as bridgeScore
     FROM entities e
     LEFT JOIN bridge_scores bs ON bs.entity_id = e.id
       AND bs.generation = (SELECT MAX(generation) FROM bridge_scores)
     WHERE e.last_seen > ? AND e.created_at <= ?`
  ).all(since, since) as Array<{ id: string; name: string; type: string; description: string | null; mentionCount: number; lastActive: number | null; createdAt: number | null; firstSeen: number | null; bridgeScore: number }>;

  const newLinks = db.prepare(
    `SELECT source_entity_id as source, target_entity_id as target, type, weight, context
     FROM relationships WHERE created_at > ?`
  ).all(since) as Array<{ source: string; target: string; type: string; weight: number; context: string | null }>;

  const updatedLinks = db.prepare(
    `SELECT source_entity_id as source, target_entity_id as target, type, weight, context
     FROM relationships WHERE updated_at > ? AND created_at <= ?`
  ).all(since, since) as Array<{ source: string; target: string; type: string; weight: number; context: string | null }>;

  // Get community for new nodes
  const clusters = db.prepare("SELECT name, entity_ids FROM topic_clusters").all() as Array<{ name: string; entity_ids: string }>;
  const entityCommunity: Record<string, string> = {};
  const newIds = new Set(newNodes.map(n => n.id).concat(updatedNodes.map(n => n.id)));
  for (const c of clusters) {
    try {
      const ids: string[] = JSON.parse(c.entity_ids);
      for (const id of ids) {
        if (newIds.has(id) && !entityCommunity[id]) entityCommunity[id] = c.name;
      }
    } catch { /* skip */ }
  }

  const mapNode = (e: typeof newNodes[0]) => ({
    id: e.id, name: e.name, type: e.type, description: e.description,
    mentionCount: e.mentionCount, community: entityCommunity[e.id] ?? null,
    lastActive: e.lastActive ?? e.createdAt ?? 0,
    firstSeen: e.firstSeen ?? e.createdAt ?? 0,
    bridgeScore: e.bridgeScore,
  });

  return {
    timestamp: Math.floor(Date.now() / 1000),
    newNodes: newNodes.map(mapNode),
    updatedNodes: updatedNodes.map(mapNode),
    newLinks,
    updatedLinks,
  };
}

// ─── Depth (3D) Graph Data ───────────────────────────────────────

function getDepthGraphData(db: Database.Database) {
  const entities = db
    .prepare(
      `SELECT e.id, e.name, e.type, e.description, e.mention_count as mentionCount,
              COALESCE(e.last_seen, e.created_at) as lastActive, e.created_at as createdAt,
              e.first_seen as firstSeen,
              COALESCE(bs.bridge_score, 0) as bridgeScore
       FROM entities e
       LEFT JOIN bridge_scores bs ON bs.entity_id = e.id
         AND bs.generation = (SELECT MAX(generation) FROM bridge_scores)
       ORDER BY e.mention_count DESC`
    )
    .all() as Array<{
    id: string;
    name: string;
    type: string;
    description: string | null;
    mentionCount: number;
    lastActive: number | null;
    createdAt: number | null;
    firstSeen: number | null;
    bridgeScore: number;
  }>;

  const relationships = db
    .prepare(
      `SELECT r.source_entity_id as source, r.target_entity_id as target,
              r.type, r.weight, r.context
       FROM relationships r`
    )
    .all() as Array<{
    source: string;
    target: string;
    type: string;
    weight: number;
    context: string | null;
  }>;

  const clusters = db
    .prepare("SELECT name, entity_ids FROM topic_clusters")
    .all() as Array<{ name: string; entity_ids: string }>;

  const entityCommunity: Record<string, string> = {};
  for (const c of clusters) {
    try {
      const ids: string[] = JSON.parse(c.entity_ids);
      for (const id of ids) {
        if (!entityCommunity[id]) entityCommunity[id] = c.name;
      }
    } catch { /* skip */ }
  }

  return {
    nodes: entities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      description: e.description,
      mentionCount: e.mentionCount,
      community: entityCommunity[e.id] ?? null,
      lastActive: e.lastActive ?? e.createdAt ?? 0,
      firstSeen: e.firstSeen ?? e.createdAt ?? 0,
      bridgeScore: e.bridgeScore,
    })),
    links: relationships.map((r) => ({
      source: r.source,
      target: r.target,
      type: r.type,
      weight: r.weight,
      context: r.context,
    })),
  };
}

// ─── Dream Management ────────────────────────────────────────────

const ENGRAM_DIR = join(homedir(), ".local", "share", "engram");
const DREAM_LOG = join(ENGRAM_DIR, "logs", "dream.log");

let dreamProcess: ChildProcess | null = null;

const DREAM_PHASES = ["ingest", "extract", "consolidate", "reflect", "prune"] as const;

function getDreamStatus(db: Database.Database): {
  running: boolean;
  phase: string | null;
  detail: string | null;
  progress: { processed: number; total: number; errors: number } | null;
  runId: string | null;
  startedAt: number | null;
  lastReport: { newMemories: number; newEntities: number; newRelationships: number; memoriesPruned: number } | null;
} {
  // Check for active run in DB
  const activeRun = db.prepare(
    "SELECT id, started_at, phases_completed, new_memories, new_entities, new_relationships, memories_pruned FROM dream_runs WHERE completed_at IS NULL AND error IS NULL ORDER BY started_at DESC LIMIT 1"
  ).get() as {
    id: string; started_at: number; phases_completed: string | null;
    new_memories: number; new_entities: number; new_relationships: number; memories_pruned: number;
  } | undefined;

  if (!activeRun && !dreamProcess) {
    // Check most recent completed run for last report
    const lastRun = db.prepare(
      "SELECT new_memories, new_entities, new_relationships, memories_pruned, completed_at FROM dream_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1"
    ).get() as { new_memories: number; new_entities: number; new_relationships: number; memories_pruned: number; completed_at: number } | undefined;

    return {
      running: false, phase: null, detail: null, progress: null, runId: null, startedAt: null,
      lastReport: lastRun ? {
        newMemories: lastRun.new_memories, newEntities: lastRun.new_entities,
        newRelationships: lastRun.new_relationships, memoriesPruned: lastRun.memories_pruned,
      } : null,
    };
  }

  if (!activeRun) {
    return { running: true, phase: "starting", detail: "Initializing...", progress: null, runId: null, startedAt: null, lastReport: null };
  }

  const completedPhases: string[] = activeRun.phases_completed ? JSON.parse(activeRun.phases_completed) : [];

  // Figure out current phase
  let currentPhase = "ingest";
  for (const p of DREAM_PHASES) {
    if (!completedPhases.includes(p)) {
      currentPhase = p;
      break;
    }
  }

  // Get checkpoint progress for current phase
  const checkpointCount = (db.prepare(
    "SELECT COUNT(*) as c FROM dream_checkpoints WHERE run_id = ? AND phase = ? AND status = 'success'"
  ).get(activeRun.id, currentPhase) as { c: number }).c;

  const errorCount = (db.prepare(
    "SELECT COUNT(*) as c FROM dream_checkpoints WHERE run_id = ? AND phase = ? AND status = 'error'"
  ).get(activeRun.id, currentPhase) as { c: number }).c;

  // Estimate total for the phase
  let total = 0;
  if (currentPhase === "extract" || currentPhase === "ingest") {
    total = (db.prepare("SELECT COUNT(*) as c FROM conversations").get() as { c: number }).c;
  } else if (currentPhase === "consolidate" || currentPhase === "prune") {
    total = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE is_active = 1").get() as { c: number }).c;
  } else if (currentPhase === "reflect") {
    total = 1;
  }

  // Read last log line for detail (read only tail of file)
  let detail: string | null = null;
  try {
    if (existsSync(DREAM_LOG)) {
      const stat = statSync(DREAM_LOG);
      const tailSize = Math.min(2048, stat.size);
      const buf = Buffer.alloc(tailSize);
      const fd = openSync(DREAM_LOG, "r");
      readSync(fd, buf, 0, tailSize, stat.size - tailSize);
      closeSync(fd);
      const tail = buf.toString("utf-8");
      const lines = tail.trim().split("\n");
      const last = lines[lines.length - 1];
      if (last) {
        const parsed = JSON.parse(last);
        detail = parsed.message ?? null;
      }
    }
  } catch { /* ignore */ }

  const phaseLabel = currentPhase.charAt(0).toUpperCase() + currentPhase.slice(1);

  return {
    running: true,
    phase: currentPhase,
    detail: detail ?? `${phaseLabel} phase in progress...`,
    progress: { processed: checkpointCount, total, errors: errorCount },
    runId: activeRun.id,
    startedAt: activeRun.started_at,
    lastReport: {
      newMemories: activeRun.new_memories, newEntities: activeRun.new_entities,
      newRelationships: activeRun.new_relationships, memoriesPruned: activeRun.memories_pruned,
    },
  };
}

function startDream(): { ok: boolean; message: string } {
  if (dreamProcess) {
    return { ok: false, message: "Dream already running" };
  }

  const engramBin = join(import.meta.dirname ?? ".", "..", "cli", "index.ts");

  dreamProcess = spawn("npx", ["tsx", engramBin, "dream", "--verbose"], {
    cwd: join(homedir(), "Documents", "git", "engram"),
    stdio: "ignore",
    detached: true,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  dreamProcess.on("exit", (code) => {
    console.log(`Dream process exited with code ${code}`);
    dreamProcess = null;
    cachedThreshold = null; // recompute after dream adds new entities
  });

  dreamProcess.on("error", (err) => {
    console.error(`Dream process error: ${err.message}`);
    dreamProcess = null;
  });

  dreamProcess.unref();

  return { ok: true, message: "Dream sequence initiated" };
}

// ─── Word Frequency ──────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the","be","to","of","and","a","in","that","have","i","it","for","not","on",
  "with","he","as","you","do","at","this","but","his","by","from","they","we",
  "say","her","she","or","an","will","my","one","all","would","there","their",
  "what","so","up","out","if","about","who","get","which","go","me","when",
  "make","can","like","time","no","just","him","know","take","people","into",
  "year","your","good","some","could","them","see","other","than","then","now",
  "look","only","come","its","over","think","also","back","after","use","two",
  "how","our","work","first","well","way","even","new","want","because","any",
  "these","give","day","most","us","is","are","was","were","been","being","has",
  "had","did","does","done","will","shall","should","may","might","must","can",
  "need","let","got","here","very","much","more","own","run","set","try","ask",
  "too","still","found","keep","last","long","made","sure","thing","going",
  "yes","no","ok","okay","right","yeah","hey","hi","hello","thanks","thank",
  "please","sorry","sure","great","actually","really","quite","pretty","etc",
  "using","used","file","files","code","tool","called","call","calls","command",
  "output","input","result","results","error","true","false","null","undefined",
  "let","const","var","function","return","import","export","default","class",
  "type","string","number","boolean","object","array","value","values","name",
  "path","data","list","read","write","create","update","delete","add","remove",
  "check","test","note","text","line","lines","run","start","end","src","http",
  "https","www","com","org","json","html","css","js","ts","md","yml","yaml",
  "png","jpg","txt","log","git","npm","node","usr","bin","etc","tmp","dev",
  "user","users","devinmlowe","teammate-message","summary","content","based",
  "should","current","don't","i'm","it's","that's","there's","what's","you're",
  "isn't","doesn't","didn't","won't","can't","couldn't","wouldn't","haven't",
  "hasn't","aren't","weren't","they're","we're","i've","you've","they've",
  "i'll","you'll","we'll","they'll","i'd","you'd","he'd","she'd","we'd",
  "assistant","message","messages","system","prompt","response","conversation",
  "context","token","tokens","model","models","already","specific","different",
  "working","look","looking","instead","need","needs","change","changes","show",
  "showing","ensure","existing","currently","without","available","following",
  "running","seems","relevant","approach","provide","provided","makes","making",
  "including","included","includes","correctly","correct","issue","issues",
  "information","example","process","version","configure","support","handle",
  "handling","handled","specify","specified","appropriate","complete","completed",
  "implement","implements","implementing","implementation","allow","allows",
  "allowed","possible","enable","enabled","confirm","execute","executing",
  "status","failed","success","pass","passing","passed","properly",
]);

let wordCache: { words: Array<{ text: string; count: number }>; timestamp: number } | null = null;
const WORD_CACHE_TTL = 60_000; // 1 minute

function getWordFrequencies(db: Database.Database, limit = 300): Array<{ text: string; count: number }> {
  if (wordCache && Date.now() - wordCache.timestamp < WORD_CACHE_TTL) {
    return wordCache.words.slice(0, limit);
  }

  const rows = db
    .prepare("SELECT user_message FROM exchanges WHERE user_message IS NOT NULL")
    .all() as Array<{ user_message: string }>;

  const freq = new Map<string, number>();

  for (const row of rows) {
    const words = row.user_message
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && w.length < 25 && !STOP_WORDS.has(w) && !/^\d+$/.test(w) && !/^[a-f0-9]{8,}$/.test(w));

    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  const sorted = [...freq.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 500)
    .map(([text, count]) => ({ text, count }));

  wordCache = { words: sorted, timestamp: Date.now() };
  return sorted.slice(0, limit);
}

// ─── SSE ─────────────────────────────────────────────────────────

const sseClients = new Set<ServerResponse>();

let lastBroadcast = 0;
const BROADCAST_COOLDOWN = 30_000; // 30s minimum between full graph broadcasts

function broadcastUpdate(db: Database.Database) {
  if (sseClients.size === 0) return;
  const now = Date.now();
  if (now - lastBroadcast < BROADCAST_COOLDOWN) return;
  lastBroadcast = now;
  const data = JSON.stringify(getGraphData(db));
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
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
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(computeOptimalThreshold(db)));
      return;
    }

    // ─── Graph routes ──────────────────────────────────
    if (pathname === "/graph/api/graph" || pathname === "/api/graph") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getGraphData(db)));
      return;
    }

    if (pathname === "/graph/api/events" || pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("data: connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // ─── Diff route ────────────────────────────────────
    if (pathname === "/api/diff" || pathname === "/graph/api/diff" || pathname === "/depth/api/diff" || pathname === "/graph/depth/api/diff") {
      const since = parseInt(url.searchParams.get("since") ?? "0", 10);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getGraphDiff(db, since)));
      return;
    }

    // ─── Dream routes ──────────────────────────────────
    if (pathname === "/api/dream/status" || pathname === "/graph/api/dream/status") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getDreamStatus(db)));
      return;
    }

    if ((pathname === "/api/dream/start" || pathname === "/graph/api/dream/start") && req.method === "POST") {
      const result = startDream();
      res.writeHead(result.ok ? 200 : 409, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(result));
      return;
    }

    // ─── Depth (3D) routes ────────────────────────────
    if (pathname === "/depth/api/graph" || pathname === "/graph/depth/api/graph") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getDepthGraphData(db)));
      return;
    }

    if (pathname === "/graph/depth" || pathname === "/graph/depth/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(DEPTH_PAGE);
      return;
    }

    // ─── Galaxy routes ─────────────────────────────────
    if (pathname === "/graph/galaxy/api/graph") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getDepthGraphData(db)));
      return;
    }

    if (pathname === "/graph/galaxy/api/diff") {
      const since = parseInt(url.searchParams.get("since") ?? "0", 10);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getGraphDiff(db, since)));
      return;
    }

    if (pathname === "/graph/galaxy/api/threshold") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(computeOptimalThreshold(db)));
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

    // ─── Words routes ──────────────────────────────────
    if (pathname === "/words/api/words" || pathname === "/api/words" || pathname === "/graph/words/api/words") {
      const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(getWordFrequencies(db, limit)));
      return;
    }

    if (pathname === "/graph/words" || pathname === "/graph/words/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(WORDS_PAGE);
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

// ─── HTML + D3 Canvas ────────────────────────────────────────────

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
    height: 100vh;
  }
  canvas { display: block; }

  #tooltip {
    position: fixed;
    display: none;
    background: #313244;
    border: 1px solid #45475a;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    max-width: 360px;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }
  #tooltip .name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  #tooltip .type { color: #a6adc8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  #tooltip .desc { margin-top: 6px; color: #bac2de; line-height: 1.4; }
  #tooltip .community { margin-top: 6px; color: #74c7ec; font-size: 11px; }

  /* ─── Settings toggle button ─── */
  #settings-toggle {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 60;
    width: 36px; height: 36px;
    border-radius: 50%;
    background: #313244;
    border: 1px solid #45475a;
    color: #cdd6f4;
    font-size: 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    line-height: 1;
  }
  #settings-toggle:hover { background: #45475a; border-color: #89b4fa; }

  /* ─── Settings panel ─── */
  #settings-panel {
    position: fixed;
    top: 0; right: 0;
    width: 300px;
    height: 100vh;
    background: rgba(30, 30, 46, 0.95);
    border-left: 1px solid #45475a;
    z-index: 55;
    overflow-y: auto;
    transform: translateX(100%);
    transition: transform 0.25s ease;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  #settings-panel.open { transform: translateX(0); }
  #settings-panel::-webkit-scrollbar { width: 4px; }
  #settings-panel::-webkit-scrollbar-track { background: transparent; }
  #settings-panel::-webkit-scrollbar-thumb { background: #45475a; border-radius: 2px; }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid #313244;
  }
  .panel-header h2 {
    font-size: 15px;
    font-weight: 600;
    color: #cdd6f4;
  }
  .panel-header-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .panel-header-actions button {
    background: none;
    border: none;
    color: #6c7086;
    cursor: pointer;
    font-size: 16px;
    padding: 2px;
    line-height: 1;
    transition: color 0.15s;
  }
  .panel-header-actions button:hover { color: #cdd6f4; }

  /* Collapsible sections */
  .section {
    border-bottom: 1px solid #313244;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    cursor: pointer;
    user-select: none;
    transition: background 0.1s;
  }
  .section-header:hover { background: rgba(69, 71, 90, 0.3); }
  .section-header .arrow {
    font-size: 10px;
    color: #6c7086;
    transition: transform 0.2s;
    width: 12px;
    text-align: center;
  }
  .section.open .section-header .arrow { transform: rotate(90deg); }
  .section-header .section-title {
    font-size: 14px;
    font-weight: 500;
    color: #cdd6f4;
  }
  .section-body {
    display: none;
    padding: 4px 20px 16px;
  }
  .section.open .section-body { display: block; }

  /* Control rows */
  .ctrl-row {
    margin-bottom: 12px;
  }
  .ctrl-row:last-child { margin-bottom: 0; }
  .ctrl-label {
    font-size: 12px;
    color: #a6adc8;
    margin-bottom: 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .ctrl-label .val {
    font-size: 11px;
    color: #6c7086;
    min-width: 32px;
    text-align: right;
  }
  .ctrl-row input[type=range] {
    width: 100%;
    accent-color: #89b4fa;
    height: 4px;
  }
  .ctrl-row input[type=text] {
    width: 100%;
    background: #313244;
    border: 1px solid #45475a;
    border-radius: 6px;
    padding: 7px 12px;
    color: #cdd6f4;
    font-size: 13px;
    outline: none;
  }
  .ctrl-row input[type=text]:focus { border-color: #89b4fa; }
  .ctrl-row input[type=text]::placeholder { color: #6c7086; }

  /* Toggle switch */
  .ctrl-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .ctrl-toggle .label { font-size: 12px; color: #a6adc8; }
  .switch {
    width: 36px; height: 20px;
    background: #45475a;
    border-radius: 10px;
    position: relative;
    cursor: pointer;
    transition: background 0.2s;
  }
  .switch.on { background: #89b4fa; }
  .switch::after {
    content: '';
    position: absolute;
    top: 2px; left: 2px;
    width: 16px; height: 16px;
    background: #cdd6f4;
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .switch.on::after { transform: translateX(16px); }

  /* Type filter pills in panel */
  #filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pill {
    background: #313244;
    border: 1px solid #45475a;
    border-radius: 14px;
    padding: 4px 10px;
    font-size: 11px;
    color: #a6adc8;
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
  }
  .pill:hover { border-color: #89b4fa; color: #cdd6f4; }
  .pill.active { background: #45475a; color: #cdd6f4; border-color: #89b4fa; }
  .pill .dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 5px;
    vertical-align: middle;
  }

  /* Stats bar (minimal, always visible) */
  #stats-bar {
    position: fixed;
    bottom: 12px;
    left: 16px;
    z-index: 50;
    font-size: 11px;
    color: #585b70;
    pointer-events: none;
  }

  /* Dream button (always visible, bottom-right) */
  #dream-btn {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 50;
    background: #313244;
    border: 1px solid #45475a;
    border-radius: 8px;
    padding: 8px 16px;
    color: #cba6f7;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #dream-btn:hover { border-color: #cba6f7; background: #45475a; }
  #dream-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #dream-btn .icon { font-size: 16px; }

  /* Dream status (in panel) */
  #dream-status {
    display: none;
    margin-top: 8px;
  }
  #dream-status.active { display: block; }
  .ds-phase-label {
    font-size: 13px;
    font-weight: 600;
    color: #cba6f7;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ds-phase-label .spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid #45475a;
    border-top-color: #cba6f7;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ds-detail {
    font-size: 11px;
    color: #a6adc8;
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .ds-progress-bar {
    height: 4px;
    background: #45475a;
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 4px;
  }
  .ds-progress-fill {
    height: 100%;
    background: #cba6f7;
    border-radius: 2px;
    transition: width 0.5s ease;
  }
  .ds-progress-text {
    font-size: 10px;
    color: #6c7086;
  }
  .ds-pipeline {
    display: flex;
    gap: 3px;
    margin-top: 8px;
  }
  .ds-pipeline .step {
    flex: 1;
    height: 3px;
    border-radius: 1.5px;
    background: #45475a;
    transition: background 0.3s;
  }
  .ds-pipeline .step.done { background: #a6e3a1; }
  .ds-pipeline .step.active { background: #cba6f7; animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }
  .ds-phase-names {
    display: flex;
    gap: 3px;
    margin-top: 2px;
  }
  .ds-phase-names span {
    flex: 1;
    font-size: 8px;
    text-align: center;
    color: #585b70;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .ds-phase-names span.done { color: #a6e3a1; }
  .ds-phase-names span.active { color: #cba6f7; }

  /* ─── View tab bar ─── */
  #view-tabs {
    position: fixed; top: 12px; left: 16px; z-index: 60;
    display: flex; gap: 4px;
  }
  #view-tabs a {
    background: rgba(49,50,68,0.85); border: 1px solid #45475a; border-radius: 14px;
    padding: 5px 14px; font-size: 12px; font-weight: 500;
    color: #a6adc8; text-decoration: none; cursor: pointer;
    transition: all 0.15s; user-select: none;
  }
  #view-tabs a:hover { border-color: #89b4fa; color: #cdd6f4; }
  #view-tabs a.active { background: #45475a; color: #89b4fa; border-color: #89b4fa; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="tooltip"></div>
<div id="view-tabs">
  <a class="active" href="/graph">Graph</a>
  <a href="/graph/depth">Depth</a>
  <a href="/graph/galaxy">Galaxy</a>
  <a href="/graph/words">Words</a>
</div>
<div id="live">updated</div>
<div id="stats-bar"><span id="stat-nodes">-</span> nodes &middot; <span id="stat-edges">-</span> edges &middot; <span id="stat-total">-</span> total</div>

<button id="animate-btn" title="Animate growth">&#x25B6;</button>
<div id="anim-progress"><span id="anim-date"></span><div id="anim-bar-wrap"><div id="anim-bar"></div></div><span id="anim-speed" title="Click to cycle speed">1x</span></div>

<button id="settings-toggle">&#x2026;</button>

<div id="settings-panel">
  <div class="panel-header">
    <h2>Graph view</h2>
    <div class="panel-header-actions">
      <button id="reset-btn" title="Reset defaults">&#x21BB;</button>
      <button id="close-panel" title="Close">&times;</button>
    </div>
  </div>

  <!-- Filters -->
  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Filters</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <input type="text" id="search" placeholder="Search nodes..." autocomplete="off" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Min mentions <span class="val" id="threshold-val">5</span></div>
        <input type="range" id="threshold" min="1" max="50" value="5" />
      </div>
    </div>
  </div>

  <!-- Groups (type filters) -->
  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Groups</span></div>
    <div class="section-body">
      <div id="filters"></div>
    </div>
  </div>

  <!-- Display -->
  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Display</span></div>
    <div class="section-body">
      <div class="ctrl-toggle">
        <span class="label">Show labels</span>
        <div class="switch on" id="toggle-labels"></div>
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Label threshold <span class="val" id="label-threshold-val">auto</span></div>
        <input type="range" id="label-threshold" min="1" max="100" value="20" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Node size <span class="val" id="node-size-val">1.0</span></div>
        <input type="range" id="node-size" min="2" max="30" value="10" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link thickness <span class="val" id="link-thickness-val">1.0</span></div>
        <input type="range" id="link-thickness" min="1" max="30" value="10" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link gradient <span class="val" id="link-gradient-val">50</span></div>
        <input type="range" id="link-gradient" min="0" max="100" value="50" />
      </div>
      <div class="ctrl-toggle">
        <span class="label">Auto-zoom to changes</span>
        <div class="switch on" id="toggle-autozoom"></div>
      </div>
    </div>
  </div>

  <!-- Forces -->
  <div class="section">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Forces</span></div>
    <div class="section-body">
      <div class="ctrl-row" style="gap:6px;margin-bottom:4px;display:flex">
        <button class="preset-btn active" id="preset-cluster">Cluster</button>
        <button class="preset-btn" id="preset-spread">Spread</button>
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Center force <span class="val" id="center-force-val">0.01</span></div>
        <input type="range" id="center-force" min="0" max="100" value="1" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Repel force <span class="val" id="repel-force-val">-200</span></div>
        <input type="range" id="repel-force" min="0" max="100" value="50" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link force <span class="val" id="link-force-val">0.50</span></div>
        <input type="range" id="link-force" min="0" max="100" value="50" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link distance <span class="val" id="link-distance-val">30</span></div>
        <input type="range" id="link-distance" min="10" max="200" value="30" />
      </div>
    </div>
  </div>

  <!-- Dream -->
  <div class="section">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Dream</span></div>
    <div class="section-body">
      <button id="dream-btn-panel" style="width:100%;background:#313244;border:1px solid #45475a;border-radius:8px;padding:8px 16px;color:#cba6f7;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all 0.2s"><span class="icon">&#x2728;</span> Dream</button>
      <div id="dream-status">
        <div class="ds-phase-label"><span class="spinner"></span> <span id="ds-phase">-</span></div>
        <div class="ds-detail" id="ds-detail">-</div>
        <div class="ds-progress-bar"><div class="ds-progress-fill" id="ds-fill"></div></div>
        <div class="ds-progress-text" id="ds-progress">-</div>
        <div class="ds-pipeline" id="ds-pipeline"></div>
        <div class="ds-phase-names" id="ds-phase-names"></div>
      </div>
    </div>
  </div>

</div>

<button id="dream-btn" style="display:none"><span class="icon">&#x2728;</span> Dream</button>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
// ─── Color System ─────────────────────────────────────────────────
const TYPE_COLORS = {
  project:    '#f38ba8',
  tool:       '#89b4fa',
  technology: '#a6e3a1',
  person:     '#fab387',
  concept:    '#cba6f7',
  file:       '#6c7086',
  repo:       '#74c7ec',
};

// Pre-compute RGB for type colors and their muted versions
const BG = [30, 30, 46]; // #1e1e2e
const FADE_DURATION = 60000; // 60 seconds to fully mute
const GLOW_DURATION = 3000;  // 3 seconds of glow effect

function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

const TYPE_RGB = {};
const TYPE_MUTED = {};
for (const [k, hex] of Object.entries(TYPE_COLORS)) {
  const [r, g, b] = hexToRgb(hex);
  TYPE_RGB[k] = [r, g, b];
  TYPE_MUTED[k] = [
    Math.round(r * 0.35 + BG[0] * 0.65),
    Math.round(g * 0.35 + BG[1] * 0.65),
    Math.round(b * 0.35 + BG[2] * 0.65),
  ];
}

function sparkNodeColor(type, lastSpark) {
  const muted = TYPE_MUTED[type] || [60, 60, 70];
  if (!lastSpark) return 'rgb(' + muted.join(',') + ')';
  const age = Date.now() - lastSpark;
  if (age >= FADE_DURATION) return 'rgb(' + muted.join(',') + ')';
  const t = age / FADE_DURATION; // 0=fresh, 1=muted
  const bright = TYPE_RGB[type] || [136, 136, 136];
  const r = Math.round(bright[0] + (muted[0] - bright[0]) * t);
  const g = Math.round(bright[1] + (muted[1] - bright[1]) * t);
  const b = Math.round(bright[2] + (muted[2] - bright[2]) * t);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function sparkLinkAlpha(lastSpark) {
  if (!lastSpark) return 0.06;
  const age = Date.now() - lastSpark;
  if (age >= FADE_DURATION) return 0.06;
  const t = age / FADE_DURATION;
  return 0.45 + (0.06 - 0.45) * t; // 0.45 → 0.06
}

function glowAlpha(lastSpark) {
  if (!lastSpark) return 0;
  const age = Date.now() - lastSpark;
  if (age >= GLOW_DURATION) return 0;
  return 0.5 * (1 - age / GLOW_DURATION);
}

const REL_RGB = {
  uses:          [137,180,250],
  depends_on:    [243,139,168],
  related_to:    [203,166,247],
  part_of:       [166,227,161],
  configured_by: [250,179,135],
  solved_by:     [249,226,175],
};

let allNodes = [], allLinks = [];
let nodeMap = new Map();
let linkKey = new Set();
let filteredNodes = [], filteredLinks = [];
let activeTypes = new Set(Object.keys(TYPE_COLORS));
let searchTerm = '';
let mentionThreshold = 5;
let simulation;
let transform = d3.zoomIdentity;
let hoveredNode = null;
let focusedNode = null;
let focusNeighbors = null;
let draggedNode = null;
let totalInDb = 0;
let lastDiffTimestamp = 0;
let diffPollTimer = null;
let hasFreshNodes = false;
let autoZoom2D = localStorage.getItem('engram-autozoom-2d') !== 'false';
let lastAutoZoomTime2D = 0;

// Display settings
let showLabels = true;
let labelThresholdManual = 20;
let nodeSizeMult = 1.0;
let linkThicknessMult = 1.0;
let linkGradient = 0.5;

// Force settings — Cluster preset (default)
let forceCenter = 0.01;
let forceRepel = -200;
let forceLinkStrength = 0.5;
let forceLinkDistance = 30;

const PRESETS = {
  cluster:  { center: 0.01, repel: -200, linkStr: 0.5, linkDist: 30 },
  spread:   { center: 0.03, repel: -80,  linkStr: 0.2, linkDist: 60 },
};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;

function resize() {
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener('resize', () => {
  resize();
  if (simulation) {
    simulation.force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2));
    simulation.alpha(0.05).restart();
  }
});

function nodeRadius(d) {
  return Math.max(2.5, Math.min(Math.sqrt(d.mentionCount || 1) * 2 * nodeSizeMult, 18 * nodeSizeMult));
}

function filterGraph() {
  const nodeSet = new Set();
  filteredNodes = allNodes.filter(n => {
    if (!activeTypes.has(n.type)) return false;
    if (n.mentionCount < mentionThreshold) return false;
    nodeSet.add(n.id);
    return true;
  });
  filteredLinks = allLinks.filter(l => {
    const sid = typeof l.source === 'object' ? l.source.id : l.source;
    const tid = typeof l.target === 'object' ? l.target.id : l.target;
    return nodeSet.has(sid) && nodeSet.has(tid);
  });
}

function buildFilters() {
  const types = [...new Set(allNodes.map(n => n.type))].sort();
  const container = document.getElementById('filters');
  container.innerHTML = '';
  for (const t of types) {
    const pill = document.createElement('div');
    pill.className = 'pill active';
    pill.dataset.type = t;
    pill.innerHTML = '<span class="dot" style="background:' + (TYPE_COLORS[t] || '#888') + '"></span>' + t;
    pill.addEventListener('click', () => {
      if (activeTypes.has(t)) { activeTypes.delete(t); pill.classList.remove('active'); }
      else { activeTypes.add(t); pill.classList.add('active'); }
      rebuildSim();
    });
    container.appendChild(pill);
  }
}

function rebuildSim() {
  filterGraph();
  updateStats();

  if (simulation) simulation.stop();

  simulation = d3.forceSimulation(filteredNodes)
    .force('link', d3.forceLink(filteredLinks).id(d => d.id).distance(forceLinkDistance).strength(d => Math.min((d.weight || 0.5) * forceLinkStrength, forceLinkStrength * 2)))
    .force('charge', d3.forceManyBody().strength(forceRepel).distanceMax(600).theta(0.9))
    .force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2).strength(forceCenter))
    .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 1).strength(0.3))
    .alphaDecay(0.03)
    .velocityDecay(0.4)
    .on('tick', draw);
}

function draw() {
  ctx.save();
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const labelsVisible = showLabels && transform.k > 0.15;
  const labelThreshold = Math.max(3, Math.round(labelThresholdManual / transform.k));

  // Determine highlight state
  let highlightSet = null;
  let highlightEdges = null;
  if (searchTerm) {
    highlightSet = new Set();
    allNodes.forEach(n => {
      if (n.name.toLowerCase().includes(searchTerm) ||
          (n.description && n.description.toLowerCase().includes(searchTerm)) ||
          (n.community && n.community.toLowerCase().includes(searchTerm))) {
        highlightSet.add(n.id);
      }
    });
  } else if (focusedNode) {
    highlightSet = focusNeighbors;
    highlightEdges = new Set();
    filteredLinks.forEach(l => {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      if (sid === focusedNode.id || tid === focusedNode.id) highlightEdges.add(l);
    });
  }

  // Track whether any sparks are still fading
  let hasActiveSparks = false;
  const now = Date.now();

  // Draw links
  for (const l of filteredLinks) {
    if (!l.source.x || !l.target.x) continue;
    let alpha = sparkLinkAlpha(l.lastSpark);
    if (l.lastSpark && now - l.lastSpark < FADE_DURATION) hasActiveSparks = true;
    if (highlightSet) {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      if (highlightEdges) {
        alpha = highlightEdges.has(l) ? 0.5 : 0.02;
      } else {
        alpha = (highlightSet.has(sid) || highlightSet.has(tid)) ? 0.4 : 0.02;
      }
    }
    const rgb = REL_RGB[l.type] || [69, 71, 90];
    ctx.beginPath();
    ctx.moveTo(l.source.x, l.source.y);
    ctx.lineTo(l.target.x, l.target.y);
    // Gradient: parameterized by linkGradient (0=invisible, 0.5=default fade, 1=solid)
    const rc = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    const g = linkGradient;
    const fz = (1.0 - g) * 0.5;
    const dimLevel = g * g;
    const scale = Math.min(g * 3.0, 1.0);
    if (fz < 0.001) {
      // Solid line
      ctx.strokeStyle = 'rgba(' + rc + ',' + (alpha * scale) + ')';
    } else {
      const grad = ctx.createLinearGradient(l.source.x, l.source.y, l.target.x, l.target.y);
      const hiA = alpha * scale;
      const loA = alpha * dimLevel * scale;
      grad.addColorStop(0,      'rgba(' + rc + ',' + hiA + ')');
      grad.addColorStop(fz,     'rgba(' + rc + ',' + loA + ')');
      grad.addColorStop(1 - fz, 'rgba(' + rc + ',' + loA + ')');
      grad.addColorStop(1,      'rgba(' + rc + ',' + hiA + ')');
      ctx.strokeStyle = grad;
    }
    ctx.lineWidth = Math.max(0.3, (l.weight || 0.5) * 1.2 * linkThicknessMult);
    ctx.stroke();
  }

  // Draw glow halos for fresh nodes (behind the nodes)
  for (const n of filteredNodes) {
    if (n.x == null) continue;
    const ga = glowAlpha(n.lastSpark);
    if (ga > 0) {
      hasActiveSparks = true;
      const r = nodeRadius(n);
      const bright = TYPE_RGB[n.type] || [136, 136, 136];
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + bright[0] + ',' + bright[1] + ',' + bright[2] + ',' + ga + ')';
      ctx.fill();
    }
  }

  // Draw nodes
  for (const n of filteredNodes) {
    if (n.x == null) continue;
    const r = nodeRadius(n);
    if (n.lastSpark && now - n.lastSpark < FADE_DURATION) hasActiveSparks = true;
    let alpha = 1;
    if (highlightSet) {
      alpha = highlightSet.has(n.id) ? 1 : 0.06;
    }

    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = sparkNodeColor(n.type, n.lastSpark);
    ctx.globalAlpha = alpha;
    ctx.fill();

    // Glow for hovered node
    if (hoveredNode === n) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  // Draw labels
  if (labelsVisible) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const n of filteredNodes) {
      if (n.x == null) continue;
      if (n.mentionCount < labelThreshold && !(highlightSet && highlightSet.has(n.id))) continue;
      const r = nodeRadius(n);
      const fontSize = Math.max(7, Math.min(10, n.mentionCount * 0.3 + 5));
      ctx.font = fontSize + 'px -apple-system, system-ui, sans-serif';
      let alpha = 0.75;
      if (highlightSet) {
        alpha = highlightSet.has(n.id) ? 0.95 : 0.04;
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#cdd6f4';
      ctx.fillText(n.name, n.x, n.y - r - 3);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // Continue rAF loop while sparks are fading
  hasFreshNodes = hasActiveSparks;
  if (hasActiveSparks) {
    requestAnimationFrame(draw);
  }
}

// ─── Zoom ────────────────────────────────────────────────────────

const zoomBehavior = d3.zoom()
  .scaleExtent([0.02, 10])
  .on('zoom', (e) => { transform = e.transform; draw(); });
d3.select(canvas).call(zoomBehavior);

// ─── Mouse interaction ──────────────────────────────────────────

function screenToWorld(sx, sy) {
  return [(sx - transform.x) / transform.k, (sy - transform.y) / transform.k];
}

function findNodeAt(sx, sy) {
  const [wx, wy] = screenToWorld(sx, sy);
  let closest = null, minDist = Infinity;
  for (const n of filteredNodes) {
    if (n.x == null) continue;
    const dx = n.x - wx, dy = n.y - wy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const r = nodeRadius(n) + 4;
    if (dist < r && dist < minDist) { closest = n; minDist = dist; }
  }
  return closest;
}

canvas.addEventListener('mousemove', (e) => {
  if (draggedNode) {
    const [wx, wy] = screenToWorld(e.clientX, e.clientY);
    draggedNode.fx = wx;
    draggedNode.fy = wy;
    return;
  }
  const node = findNodeAt(e.clientX, e.clientY);
  if (node !== hoveredNode) {
    hoveredNode = node;
    canvas.style.cursor = node ? 'pointer' : 'default';
    if (node) {
      showTooltip(e, node);
    } else {
      hideTooltip();
    }
    draw();
  } else if (node) {
    moveTooltip(e);
  }
});

canvas.addEventListener('mousedown', (e) => {
  const node = findNodeAt(e.clientX, e.clientY);
  if (node) {
    draggedNode = node;
    node.fx = node.x;
    node.fy = node.y;
    simulation.alphaTarget(0.1).restart();
    e.stopPropagation();
  }
});

canvas.addEventListener('mouseup', () => {
  if (draggedNode) {
    draggedNode.fx = null;
    draggedNode.fy = null;
    draggedNode = null;
    simulation.alphaTarget(0);
  }
});

canvas.addEventListener('click', (e) => {
  if (draggedNode) return;
  const node = findNodeAt(e.clientX, e.clientY);
  if (node) {
    if (focusedNode === node) {
      focusedNode = null;
      focusNeighbors = null;
    } else {
      focusedNode = node;
      focusNeighbors = new Set([node.id]);
      filteredLinks.forEach(l => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        if (sid === node.id) focusNeighbors.add(tid);
        if (tid === node.id) focusNeighbors.add(sid);
      });
    }
    draw();
  } else {
    if (focusedNode) {
      focusedNode = null;
      focusNeighbors = null;
      draw();
    }
  }
});

// ─── Tooltip ─────────────────────────────────────────────────────

function showTooltip(event, d) {
  const tip = document.getElementById('tooltip');
  let html = '<div class="name">' + esc(d.name) + '</div>';
  html += '<div class="type">' + d.type + ' &middot; ' + d.mentionCount + ' mentions</div>';
  if (d.description) html += '<div class="desc">' + esc(d.description) + '</div>';
  if (d.community) html += '<div class="community">' + esc(d.community) + '</div>';
  tip.innerHTML = html;
  tip.style.display = 'block';
  moveTooltip(event);
}
function moveTooltip(event) {
  const tip = document.getElementById('tooltip');
  tip.style.left = (event.clientX + 16) + 'px';
  tip.style.top = (event.clientY - 10) + 'px';
}
function hideTooltip() {
  document.getElementById('tooltip').style.display = 'none';
}
function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

// ─── Settings Panel ──────────────────────────────────────────────

// Panel toggle
document.getElementById('settings-toggle').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('open');
});
document.getElementById('close-panel').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('open');
});

// Section collapse
document.querySelectorAll('.section-header').forEach(hdr => {
  hdr.addEventListener('click', () => {
    hdr.parentElement.classList.toggle('open');
  });
});

// Filters
document.getElementById('search').addEventListener('input', (e) => {
  searchTerm = e.target.value.toLowerCase();
  focusedNode = null;
  focusNeighbors = null;
  draw();
});

document.getElementById('threshold').addEventListener('input', (e) => {
  mentionThreshold = parseInt(e.target.value, 10);
  document.getElementById('threshold-val').textContent = mentionThreshold;
  rebuildSim();
});

// Display controls
document.getElementById('toggle-labels').addEventListener('click', function() {
  this.classList.toggle('on');
  showLabels = this.classList.contains('on');
  draw();
});

document.getElementById('label-threshold').addEventListener('input', (e) => {
  labelThresholdManual = parseInt(e.target.value, 10);
  document.getElementById('label-threshold-val').textContent = labelThresholdManual;
  draw();
});

document.getElementById('node-size').addEventListener('input', (e) => {
  nodeSizeMult = parseInt(e.target.value, 10) / 10;
  document.getElementById('node-size-val').textContent = nodeSizeMult.toFixed(1);
  draw();
});

document.getElementById('link-thickness').addEventListener('input', (e) => {
  linkThicknessMult = parseInt(e.target.value, 10) / 10;
  document.getElementById('link-thickness-val').textContent = linkThicknessMult.toFixed(1);
  draw();
});

document.getElementById('link-gradient').addEventListener('input', (e) => {
  linkGradient = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-gradient-val').textContent = e.target.value;
  draw();
});

// Force controls
function updateForces() {
  if (!simulation) return;
  simulation.force('center').strength(forceCenter);
  simulation.force('charge').strength(forceRepel);
  simulation.force('link').distance(forceLinkDistance);
  simulation.force('link').strength(d => Math.min((d.weight || 0.5) * forceLinkStrength, forceLinkStrength * 2));
  simulation.alpha(0.3).restart();
}

document.getElementById('center-force').addEventListener('input', (e) => {
  forceCenter = parseInt(e.target.value, 10) / 100;
  document.getElementById('center-force-val').textContent = forceCenter.toFixed(2);
  updateForces();
});

document.getElementById('repel-force').addEventListener('input', (e) => {
  forceRepel = -(parseInt(e.target.value, 10) * 4);
  document.getElementById('repel-force-val').textContent = forceRepel;
  updateForces();
});

document.getElementById('link-force').addEventListener('input', (e) => {
  forceLinkStrength = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-force-val').textContent = forceLinkStrength.toFixed(2);
  updateForces();
});

document.getElementById('link-distance').addEventListener('input', (e) => {
  forceLinkDistance = parseInt(e.target.value, 10);
  document.getElementById('link-distance-val').textContent = forceLinkDistance;
  updateForces();
});

// Preset buttons
function applyPreset(name) {
  const p = PRESETS[name];
  forceCenter = p.center; forceRepel = p.repel; forceLinkStrength = p.linkStr; forceLinkDistance = p.linkDist;
  document.getElementById('center-force').value = Math.round(p.center * 100);
  document.getElementById('center-force-val').textContent = p.center.toFixed(2);
  document.getElementById('repel-force').value = Math.round(-p.repel / 4);
  document.getElementById('repel-force-val').textContent = p.repel;
  document.getElementById('link-force').value = Math.round(p.linkStr * 100);
  document.getElementById('link-force-val').textContent = p.linkStr.toFixed(2);
  document.getElementById('link-distance').value = p.linkDist;
  document.getElementById('link-distance-val').textContent = p.linkDist;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('preset-' + name).classList.add('active');
  updateForces();
}
document.getElementById('preset-cluster').addEventListener('click', () => applyPreset('cluster'));
document.getElementById('preset-spread').addEventListener('click', () => applyPreset('spread'));

// Auto-zoom toggle
document.getElementById('toggle-autozoom').addEventListener('click', function() {
  this.classList.toggle('on');
  autoZoom2D = this.classList.contains('on');
  localStorage.setItem('engram-autozoom-2d', autoZoom2D);
});
if (!autoZoom2D) document.getElementById('toggle-autozoom').classList.remove('on');

// Reset defaults (resets to Cluster preset)
document.getElementById('reset-btn').addEventListener('click', () => {
  showLabels = true; labelThresholdManual = 20; nodeSizeMult = 1.0; linkThicknessMult = 1.0;
  document.getElementById('toggle-labels').classList.add('on');
  document.getElementById('label-threshold').value = 20; document.getElementById('label-threshold-val').textContent = 'auto';
  document.getElementById('node-size').value = 10; document.getElementById('node-size-val').textContent = '1.0';
  document.getElementById('link-thickness').value = 10; document.getElementById('link-thickness-val').textContent = '1.0';
  applyPreset('cluster');
  draw();
});

function updateStats() {
  document.getElementById('stat-nodes').textContent = filteredNodes.length;
  document.getElementById('stat-edges').textContent = filteredLinks.length;
  document.getElementById('stat-total').textContent = totalInDb;
}

// ─── Init ────────────────────────────────────────────────────────

Promise.all([
  fetch('/graph/api/graph').then(r => r.json()),
  fetch('/graph/api/threshold').then(r => r.json()),
]).then(([data, thresholdData]) => {
    // Apply computed optimal threshold
    mentionThreshold = thresholdData.value;
    document.getElementById('threshold').value = mentionThreshold;
    document.getElementById('threshold-val').textContent = mentionThreshold;

    // Initialize all nodes as fully muted (lastSpark = 0)
    allNodes = data.nodes.map(n => { n.lastSpark = 0; return n; });
    allLinks = data.links.map(l => { l.lastSpark = 0; return l; });
    totalInDb = allNodes.length;

    // Build lookup structures
    nodeMap.clear();
    linkKey.clear();
    for (const n of allNodes) nodeMap.set(n.id, n);
    for (const l of allLinks) linkKey.add(l.source + '|' + l.target + '|' + l.type);

    // Set initial diff timestamp to now (only fetch changes after load)
    lastDiffTimestamp = Math.floor(Date.now() / 1000);

    buildFilters();
    rebuildSim();

    // Start diff polling
    startDiffPolling();

    // Auto-fit after settling
    setTimeout(() => {
      if (filteredNodes.length === 0) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of filteredNodes) {
        if (n.x == null) continue;
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      const pad = 60;
      const bw = maxX - minX + pad * 2;
      const bh = maxY - minY + pad * 2;
      const scale = Math.min(window.innerWidth / bw, window.innerHeight / bh, 2);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const t = d3.zoomIdentity
        .translate(window.innerWidth / 2, window.innerHeight / 2)
        .scale(scale)
        .translate(-cx, -cy);
      d3.select(canvas).transition().duration(750).call(zoomBehavior.transform, t);
    }, 3000);
  });

// ─── Diff Polling ─────────────────────────────────────────────────

function startDiffPolling() {
  if (diffPollTimer) return;
  diffPollTimer = setInterval(pollDiff, 1500);
}

function pollDiff() {
  fetch('/graph/api/diff?since=' + lastDiffTimestamp)
    .then(r => r.json())
    .then(mergeDiff)
    .catch(() => {});
}

function mergeDiff(diff) {
  if (!diff) return;
  lastDiffTimestamp = diff.timestamp;
  const sparkTime = Date.now();
  let changed = false;
  const newNodeIds = [];

  // New nodes
  for (const n of diff.newNodes) {
    if (!nodeMap.has(n.id)) {
      n.lastSpark = sparkTime;
      allNodes.push(n);
      nodeMap.set(n.id, n);
      newNodeIds.push(n.id);
      changed = true;
    }
  }

  // Updated nodes — refresh properties, spark them
  for (const n of diff.updatedNodes) {
    const existing = nodeMap.get(n.id);
    if (existing) {
      existing.name = n.name;
      existing.description = n.description;
      existing.mentionCount = n.mentionCount;
      existing.community = n.community;
      existing.lastSpark = sparkTime;
      changed = true;
    }
  }

  // New links
  for (const l of diff.newLinks) {
    const key = l.source + '|' + l.target + '|' + l.type;
    if (!linkKey.has(key)) {
      l.lastSpark = sparkTime;
      allLinks.push(l);
      linkKey.add(key);
      changed = true;
      // Also spark the connected nodes
      const sn = nodeMap.get(l.source);
      const tn = nodeMap.get(l.target);
      if (sn) sn.lastSpark = sparkTime;
      if (tn) tn.lastSpark = sparkTime;
    }
  }

  // Updated links
  for (const l of diff.updatedLinks) {
    const key = l.source + '|' + l.target + '|' + l.type;
    // Find and update existing link
    for (const el of allLinks) {
      const sid = typeof el.source === 'object' ? el.source.id : el.source;
      const tid = typeof el.target === 'object' ? el.target.id : el.target;
      if (sid === l.source && tid === l.target && el.type === l.type) {
        el.weight = l.weight;
        el.context = l.context;
        el.lastSpark = sparkTime;
        changed = true;
        break;
      }
    }
  }

  if (changed) {
    totalInDb = allNodes.length;

    // Incremental sim update: re-filter and add new nodes/links without full restart
    const prevNodeCount = filteredNodes.length;
    filterGraph();
    updateStats();

    if (filteredNodes.length !== prevNodeCount) {
      // New visible nodes appeared — warm-restart the sim
      simulation.nodes(filteredNodes);
      simulation.force('link').links(filteredLinks);
      simulation.alpha(0.15).restart();
    }

    // Show update indicator
    const live = document.getElementById('live');
    live.textContent = '+' + (diff.newNodes.length + diff.updatedNodes.length) + ' changes';
    live.classList.add('show');
    setTimeout(() => live.classList.remove('show'), 2000);

    // Auto-zoom to new nodes
    if (autoZoom2D && newNodeIds.length >= 2 && Date.now() - lastAutoZoomTime2D > 5000) {
      setTimeout(() => {
        const newNodes = newNodeIds.map(id => nodeMap.get(id)).filter(n => n && n.x != null);
        if (newNodes.length >= 2) {
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const n of newNodes) {
            minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
            minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
          }
          const pad = 150;
          const bw = maxX - minX + pad * 2;
          const bh = maxY - minY + pad * 2;
          const scale = Math.min(window.innerWidth / bw, window.innerHeight / bh, 2);
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          const t = d3.zoomIdentity
            .translate(window.innerWidth / 2, window.innerHeight / 2)
            .scale(scale)
            .translate(-cx, -cy);
          d3.select(canvas).transition().duration(750).call(zoomBehavior.transform, t);
          lastAutoZoomTime2D = Date.now();
        }
      }, 500);
    }

    // Trigger rAF fade loop
    if (!hasFreshNodes) {
      hasFreshNodes = true;
      requestAnimationFrame(draw);
    }
  }
}

// ─── Dream UI ─────────────────────────────────────────────────────

const PHASES = ['ingest', 'extract', 'consolidate', 'reflect', 'prune'];
let dreamPolling = null;

function initDreamUI() {
  // Build pipeline indicators
  const pipeline = document.getElementById('ds-pipeline');
  const names = document.getElementById('ds-phase-names');
  pipeline.innerHTML = '';
  names.innerHTML = '';
  PHASES.forEach(p => {
    const step = document.createElement('div');
    step.className = 'step';
    step.dataset.phase = p;
    pipeline.appendChild(step);
    const label = document.createElement('span');
    label.dataset.phase = p;
    label.textContent = p.slice(0, 3);
    names.appendChild(label);
  });

  document.getElementById('dream-btn-panel').addEventListener('click', startDreamFromPanel);

  // Initial status check
  pollDreamStatus();
}

function startDreamFromPanel() {
  const btn = document.getElementById('dream-btn-panel');
  btn.disabled = true;
  btn.style.opacity = '0.5';
  fetch('/graph/api/dream/start', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        startDreamPolling();
      } else {
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    })
    .catch(() => { btn.disabled = false; btn.style.opacity = '1'; });
}

function startDreamPolling() {
  if (dreamPolling) return;
  dreamPolling = setInterval(pollDreamStatus, 2000);
}

function stopDreamPolling() {
  if (dreamPolling) {
    clearInterval(dreamPolling);
    dreamPolling = null;
  }
}

function pollDreamStatus() {
  fetch('/graph/api/dream/status')
    .then(r => r.json())
    .then(updateDreamUI)
    .catch(() => {});
}

function updateDreamUI(status) {
  const panel = document.getElementById('dream-status');
  const btn = document.getElementById('dream-btn-panel');

  if (!status.running) {
    panel.classList.remove('active');
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.innerHTML = '<span class="icon">&#x2728;</span> Dream';
    stopDreamPolling();
    return;
  }

  panel.classList.add('active');
  btn.disabled = true;
  btn.style.opacity = '0.5';
  btn.innerHTML = '<span class="icon">&#x2728;</span> Dreaming...';
  startDreamPolling();

  // Phase label
  const phaseLabel = status.phase ? status.phase.charAt(0).toUpperCase() + status.phase.slice(1) : 'Starting';
  document.getElementById('ds-phase').textContent = phaseLabel;

  // Detail
  document.getElementById('ds-detail').textContent = status.detail || 'Processing...';

  // Progress bar
  const fill = document.getElementById('ds-fill');
  const progressText = document.getElementById('ds-progress');
  if (status.progress && status.progress.total > 0) {
    const pct = Math.round((status.progress.processed / status.progress.total) * 100);
    fill.style.width = pct + '%';
    progressText.textContent = status.progress.processed + '/' + status.progress.total +
      (status.progress.errors > 0 ? ' (' + status.progress.errors + ' errors)' : '');
  } else {
    fill.style.width = '0%';
    progressText.textContent = '';
  }

  // Pipeline steps
  const currentIdx = PHASES.indexOf(status.phase);
  document.querySelectorAll('.ds-pipeline .step, #ds-pipeline .step').forEach((el, i) => {
    el.className = 'step';
    if (i < currentIdx) el.classList.add('done');
    else if (i === currentIdx) el.classList.add('active');
  });
  document.querySelectorAll('.ds-phase-names span, #ds-phase-names span').forEach((el, i) => {
    el.className = '';
    if (i < currentIdx) el.classList.add('done');
    else if (i === currentIdx) el.classList.add('active');
  });
}

initDreamUI();

// ─── Growth Animation ────────────────────────────────────────────

let animating2D = false;
let animTime2D = 0;
let animMinTime2D = 0;
let animMaxTime2D = 0;
let animSpeed2D = 1;
const ANIM_SPEEDS_2D = [1, 2, 5, 10, 20];
let animSpeedIdx2D = 0;
let animLastFrame2D = 0;
let animNodeOrder2D = [];
let animVisibleCount2D = 0;
let animSavedThreshold2D = 0;

const animBtn2D = document.getElementById('animate-btn');
const animProgress2D = document.getElementById('anim-progress');
const animBar2D = document.getElementById('anim-bar');
const animDate2D = document.getElementById('anim-date');
const animSpeedEl2D = document.getElementById('anim-speed');

function formatAnimDate2D(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function startAnimation2D() {
  // Animate within the current threshold — keeps node count manageable
  const thresholdFiltered = allNodes.filter(n => (n.mentionCount || 0) >= mentionThreshold);
  animNodeOrder2D = thresholdFiltered
    .filter(n => (n.firstSeen || 0) > 0)
    .sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
  if (animNodeOrder2D.length < 2) return;

  animMinTime2D = animNodeOrder2D[0].firstSeen;
  animMaxTime2D = animNodeOrder2D[animNodeOrder2D.length - 1].firstSeen;
  animTime2D = animMinTime2D;
  animVisibleCount2D = 0;
  animSavedThreshold2D = mentionThreshold;

  animating2D = true;
  animLastFrame2D = performance.now();
  animBtn2D.classList.add('playing');
  animBtn2D.innerHTML = '&#x25A0;';
  animProgress2D.classList.add('show');

  // Start with empty graph
  filteredNodes = [];
  filteredLinks = [];
  rebuildSim();
  requestAnimationFrame(animTick2D);
}

function stopAnimation2D() {
  animating2D = false;
  animBtn2D.classList.remove('playing');
  animBtn2D.innerHTML = '&#x25B6;';
  animProgress2D.classList.remove('show');

  mentionThreshold = animSavedThreshold2D;
  document.getElementById('threshold').value = mentionThreshold;
  document.getElementById('threshold-val').textContent = mentionThreshold;
  rebuildSim();
}

function animTick2D(now) {
  if (!animating2D) return;
  const dt = (now - animLastFrame2D) / 1000;
  animLastFrame2D = now;

  const BASE_DURATION = 45;
  const timeSpan = animMaxTime2D - animMinTime2D || 1;
  const timeScale = timeSpan / BASE_DURATION;
  animTime2D += dt * timeScale * animSpeed2D;

  if (animTime2D >= animMaxTime2D) {
    animTime2D = animMaxTime2D;
    animVisibleCount2D = animNodeOrder2D.length;
    animRebuild2D();
    updateAnimUI2D();
    setTimeout(stopAnimation2D, 1500);
    return;
  }

  let newCount = animVisibleCount2D;
  while (newCount < animNodeOrder2D.length && (animNodeOrder2D[newCount].firstSeen || 0) <= animTime2D) {
    newCount++;
  }

  if (newCount > animVisibleCount2D) {
    const sparkTime = Date.now();
    for (let i = animVisibleCount2D; i < newCount; i++) {
      animNodeOrder2D[i].lastSpark = sparkTime;
    }
    animVisibleCount2D = newCount;
    animRebuild2D();
  }

  updateAnimUI2D();
  requestAnimationFrame(animTick2D);
}

function animRebuild2D() {
  const visibleIds = new Set();
  for (let i = 0; i < animVisibleCount2D; i++) {
    visibleIds.add(animNodeOrder2D[i].id);
  }

  filteredNodes = allNodes.filter(n => visibleIds.has(n.id));
  filteredLinks = allLinks.filter(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return visibleIds.has(s) && visibleIds.has(t);
  });

  updateStats();

  if (simulation) simulation.stop();
  simulation = d3.forceSimulation(filteredNodes)
    .force('link', d3.forceLink(filteredLinks).id(d => d.id).distance(forceLinkDistance).strength(d => Math.min((d.weight || 0.5) * forceLinkStrength, forceLinkStrength * 2)))
    .force('charge', d3.forceManyBody().strength(forceRepel).distanceMax(600).theta(0.9))
    .force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2).strength(forceCenter))
    .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 1).strength(0.3))
    .alphaDecay(0.03)
    .velocityDecay(0.4)
    .on('tick', draw);
}

function updateAnimUI2D() {
  const pct = ((animTime2D - animMinTime2D) / (animMaxTime2D - animMinTime2D || 1)) * 100;
  animBar2D.style.width = pct + '%';
  animDate2D.textContent = formatAnimDate2D(animTime2D);
}

animBtn2D.addEventListener('click', () => {
  if (animating2D) stopAnimation2D();
  else startAnimation2D();
});

animSpeedEl2D.addEventListener('click', () => {
  animSpeedIdx2D = (animSpeedIdx2D + 1) % ANIM_SPEEDS_2D.length;
  animSpeed2D = ANIM_SPEEDS_2D[animSpeedIdx2D];
  animSpeedEl2D.textContent = animSpeed2D + 'x';
});
</script>
</body>
</html>`;

// ─── Words Cloud Page ────────────────────────────────────────────

// ─── Shared Panel CSS ────────────────────────────────────────────

const PANEL_CSS = `
  #settings-toggle {
    position: fixed; top: 16px; right: 16px; z-index: 60;
    width: 36px; height: 36px; border-radius: 50%;
    background: rgba(49,50,68,0.85); border: 1px solid #45475a;
    color: #cdd6f4; font-size: 18px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.2s; line-height: 1;
  }
  #settings-toggle:hover { background: #45475a; border-color: #89b4fa; }
  #settings-panel {
    position: fixed; top: 0; right: 0; width: 300px; height: 100vh;
    background: rgba(30,30,46,0.95); border-left: 1px solid #45475a;
    z-index: 55; overflow-y: auto;
    transform: translateX(100%); transition: transform 0.25s ease;
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  }
  #settings-panel.open { transform: translateX(0); }
  #settings-panel::-webkit-scrollbar { width: 4px; }
  #settings-panel::-webkit-scrollbar-thumb { background: #45475a; border-radius: 2px; }
  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px 12px; border-bottom: 1px solid #313244;
  }
  .panel-header h2 { font-size: 15px; font-weight: 600; color: #cdd6f4; }
  .panel-header-actions { display: flex; gap: 8px; align-items: center; }
  .panel-header-actions button {
    background: none; border: none; color: #6c7086; cursor: pointer;
    font-size: 16px; padding: 2px; line-height: 1; transition: color 0.15s;
  }
  .panel-header-actions button:hover { color: #cdd6f4; }
  .section { border-bottom: 1px solid #313244; }
  .section-header {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 20px; cursor: pointer; user-select: none;
    transition: background 0.1s;
  }
  .section-header:hover { background: rgba(69,71,90,0.3); }
  .section-header .arrow {
    font-size: 10px; color: #6c7086; transition: transform 0.2s;
    width: 12px; text-align: center;
  }
  .section.open .section-header .arrow { transform: rotate(90deg); }
  .section-header .section-title { font-size: 14px; font-weight: 500; color: #cdd6f4; }
  .section-body { display: none; padding: 4px 20px 16px; }
  .section.open .section-body { display: block; }
  .ctrl-row { margin-bottom: 12px; }
  .ctrl-row:last-child { margin-bottom: 0; }
  .ctrl-label {
    font-size: 12px; color: #a6adc8; margin-bottom: 6px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .ctrl-label .val { font-size: 11px; color: #6c7086; min-width: 32px; text-align: right; }
  .ctrl-row input[type=range] { width: 100%; accent-color: #89b4fa; height: 4px; }
  .ctrl-row input[type=text] {
    width: 100%; background: #313244; border: 1px solid #45475a;
    border-radius: 6px; padding: 7px 12px; color: #cdd6f4; font-size: 13px; outline: none;
  }
  .ctrl-row input[type=text]:focus { border-color: #89b4fa; }
  .ctrl-row input[type=text]::placeholder { color: #6c7086; }
  .ctrl-toggle {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;
  }
  .ctrl-toggle .label { font-size: 12px; color: #a6adc8; }
  .switch {
    width: 36px; height: 20px; background: #45475a; border-radius: 10px;
    position: relative; cursor: pointer; transition: background 0.2s;
  }
  .switch.on { background: #89b4fa; }
  .switch::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; background: #cdd6f4;
    border-radius: 50%; transition: transform 0.2s;
  }
  .switch.on::after { transform: translateX(16px); }
  .pill {
    background: #313244; border: 1px solid #45475a; border-radius: 14px;
    padding: 4px 10px; font-size: 11px; color: #a6adc8; cursor: pointer;
    transition: all 0.15s; user-select: none;
  }
  .pill:hover { border-color: #89b4fa; color: #cdd6f4; }
  .pill.active { background: #45475a; color: #cdd6f4; border-color: #89b4fa; }
  .pill .dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    margin-right: 5px; vertical-align: middle;
  }
  .preset-btn {
    flex: 1; background: #313244; border: 1px solid #45475a; border-radius: 8px;
    padding: 6px 0; color: #a6adc8; font-size: 11px; font-weight: 600;
    cursor: pointer; transition: all 0.15s; text-align: center;
  }
  .preset-btn:hover { border-color: #89b4fa; color: #cdd6f4; }
  .preset-btn.active { background: #45475a; color: #89b4fa; border-color: #89b4fa; }

  /* ─── View tab bar ─── */
  #view-tabs {
    position: fixed; top: 12px; left: 16px; z-index: 60;
    display: flex; gap: 4px;
  }
  #view-tabs a {
    background: rgba(49,50,68,0.85); border: 1px solid #45475a; border-radius: 14px;
    padding: 5px 14px; font-size: 12px; font-weight: 500;
    color: #a6adc8; text-decoration: none; cursor: pointer;
    transition: all 0.15s; user-select: none;
  }
  #view-tabs a:hover { border-color: #89b4fa; color: #cdd6f4; }
  #view-tabs a.active { background: #45475a; color: #89b4fa; border-color: #89b4fa; }

  /* ─── Live update indicator ─── */
  #live {
    position: fixed; top: 16px; left: 50%;
    transform: translateX(-50%); z-index: 50;
    font-size: 11px; color: #a6e3a1;
    opacity: 0; transition: opacity 0.3s;
    pointer-events: none;
  }
  #live.show { opacity: 1; }

  /* ─── Word spark animation ─── */
  @keyframes word-spark {
    0% { filter: brightness(1); transform: scale(1); }
    30% { filter: brightness(2.5); transform: scale(1.15); }
    100% { filter: brightness(1); transform: scale(1); }
  }
  .word-sparked { animation: word-spark 1.5s ease-out; }

  /* ─── Animate button + progress ─── */
  #animate-btn {
    position: fixed; bottom: 16px; right: 16px; z-index: 60;
    width: 40px; height: 40px; border-radius: 50%;
    background: rgba(49,50,68,0.85); border: 1px solid #45475a;
    color: #cdd6f4; font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.2s; line-height: 1;
  }
  #animate-btn:hover { background: #45475a; border-color: #89b4fa; }
  #animate-btn.playing { background: rgba(243,139,168,0.3); border-color: #f38ba8; color: #f38ba8; }
  #anim-progress {
    position: fixed; bottom: 16px; left: 50%;
    transform: translateX(-50%); z-index: 55;
    display: none; align-items: center; gap: 10px;
    background: rgba(30,30,46,0.9); border: 1px solid #45475a;
    border-radius: 16px; padding: 6px 16px;
    font-size: 11px; color: #a6adc8;
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  }
  #anim-progress.show { display: flex; }
  #anim-bar-wrap {
    width: 120px; height: 3px; background: #313244; border-radius: 2px; overflow: hidden;
  }
  #anim-bar {
    height: 100%; width: 0%; background: #89b4fa; border-radius: 2px;
    transition: width 0.1s linear;
  }
  #anim-date { min-width: 80px; text-align: center; }
  #anim-speed { font-size: 10px; color: #6c7086; cursor: pointer; user-select: none; }
  #anim-speed:hover { color: #cdd6f4; }
`;

// ─── Depth (3D) Page ─────────────────────────────────────────────

const DEPTH_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram depth</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
    height: 100vh;
  }
  #graph-3d { width: 100vw; height: 100vh; }

  #tooltip {
    position: fixed;
    display: none;
    background: rgba(49, 50, 68, 0.95);
    border: 1px solid #45475a;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    max-width: 360px;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  }
  #tooltip .name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  #tooltip .type { color: #a6adc8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  #tooltip .desc { margin-top: 6px; color: #bac2de; line-height: 1.4; }
  #tooltip .community { margin-top: 6px; color: #74c7ec; font-size: 11px; }
  #tooltip .time { margin-top: 6px; color: #a6adc8; font-size: 11px; }

  #stats-bar {
    position: fixed; bottom: 12px; left: 16px; z-index: 50;
    font-size: 11px; color: #585b70; pointer-events: none;
  }

  ${PANEL_CSS}
</style>
</head>
<body>
<div id="graph-3d"></div>
<div id="tooltip"></div>
<div id="view-tabs">
  <a href="/graph">Graph</a>
  <a class="active" href="/graph/depth">Depth</a>
  <a href="/graph/galaxy">Galaxy</a>
  <a href="/graph/words">Words</a>
</div>
<div id="live">updated</div>
<div id="stats-bar"><span id="stat-nodes">-</span> nodes &middot; <span id="stat-edges">-</span> edges &middot; Z = relevance</div>

<button id="animate-btn" title="Animate growth">&#x25B6;</button>
<div id="anim-progress"><span id="anim-date"></span><div id="anim-bar-wrap"><div id="anim-bar"></div></div><span id="anim-speed" title="Click to cycle speed">1x</span></div>

<button id="settings-toggle">&#x2026;</button>

<div id="settings-panel">
  <div class="panel-header">
    <h2>Depth view</h2>
    <div class="panel-header-actions">
      <button id="close-panel" title="Close">&times;</button>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Filters</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Min mentions <span class="val" id="threshold-val">5</span></div>
        <input type="range" id="threshold" min="1" max="50" value="5" />
      </div>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Display</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Node size <span class="val" id="node-size-val">1.0</span></div>
        <input type="range" id="node-size" min="2" max="30" value="10" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link opacity <span class="val" id="link-opacity-val">0.3</span></div>
        <input type="range" id="link-opacity" min="1" max="100" value="30" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link gradient <span class="val" id="link-gradient-val">50</span></div>
        <input type="range" id="link-gradient" min="0" max="100" value="50" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Z spread <span class="val" id="z-range-val">800</span></div>
        <input type="range" id="z-range" min="100" max="2000" value="800" />
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Forces</span></div>
    <div class="section-body">
      <div class="ctrl-row" style="gap:6px;margin-bottom:4px;display:flex">
        <button class="preset-btn active" id="preset-cluster">Cluster</button>
        <button class="preset-btn" id="preset-spread">Spread</button>
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Repel force <span class="val" id="repel-force-val">-40</span></div>
        <input type="range" id="repel-force" min="0" max="100" value="40" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link force <span class="val" id="link-force-val">0.30</span></div>
        <input type="range" id="link-force" min="0" max="100" value="30" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link distance <span class="val" id="link-distance-val">15</span></div>
        <input type="range" id="link-distance" min="5" max="100" value="15" />
      </div>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Behavior</span></div>
    <div class="section-body">
      <div class="ctrl-toggle">
        <span class="label">Auto-rotate</span>
        <div class="switch on" id="toggle-autorotate"></div>
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Rotate speed <span class="val" id="rotate-speed-val">5</span></div>
        <input type="range" id="rotate-speed" min="1" max="20" value="5" />
      </div>
      <div class="ctrl-toggle">
        <span class="label">Auto-zoom to changes</span>
        <div class="switch on" id="toggle-autozoom-3d"></div>
      </div>
    </div>
  </div>

</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
<script src="https://unpkg.com/3d-force-graph"></script>
<script>
// Panel logic
document.getElementById('settings-toggle').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('open');
});
document.getElementById('close-panel').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('open');
});
document.querySelectorAll('.section-header').forEach(hdr => {
  hdr.addEventListener('click', () => hdr.parentElement.classList.toggle('open'));
});

const TYPE_COLORS = {
  project:    '#f38ba8',
  tool:       '#89b4fa',
  technology: '#a6e3a1',
  person:     '#fab387',
  concept:    '#cba6f7',
  file:       '#6c7086',
  repo:       '#74c7ec',
};

let Z_RANGE = 800;
let mentionThreshold = 5;
let nodeSizeMult = 1.0;
let linkOpacity = 0.3;
let linkGradient = 0.5;
let forceRepel = -40;
let forceLinkDist = 15;
let forceLinkStr = 0.3;

const PRESETS_3D = {
  cluster:  { repel: -40, linkStr: 0.3, linkDist: 15 },
  spread:   { repel: -15, linkStr: 0.1, linkDist: 25 },
};
let allNodes = [], allLinks = [];
let graph;
let gradLinkMat;

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function formatAge(ts) {
  if (!ts) return 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  if (diff < 2592000) return Math.round(diff / 86400) + 'd ago';
  return Math.round(diff / 2592000) + 'mo ago';
}

// ─── Relevance Scoring ──────────────────────────────────────────
const DAY = 86400;
const RECENCY_HALF = 30 * DAY;   // 30-day half-life for access recency
const AGE_HALF = 90 * DAY;       // 90-day half-life for creation recency
const PULL_STRENGTH = 0.15;
const GRAVITY_PASSES = 3;

function computeRelevanceScores(filtered, links) {
  const now = Math.floor(Date.now() / 1000);

  // Build degree map from filtered links
  const degree = new Map();
  for (const n of filtered) degree.set(n.id, 0);
  for (const l of links) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (degree.has(s)) degree.set(s, degree.get(s) + 1);
    if (degree.has(t)) degree.set(t, degree.get(t) + 1);
  }

  // Find maxima for normalization
  let maxMentions = 1, maxDegree = 1, maxBridge = 0.001;
  for (const n of filtered) {
    if (n.mentionCount > maxMentions) maxMentions = n.mentionCount;
    if ((degree.get(n.id) || 0) > maxDegree) maxDegree = degree.get(n.id);
    if ((n.bridgeScore || 0) > maxBridge) maxBridge = n.bridgeScore;
  }

  const scores = new Map();
  for (const n of filtered) {
    const sinceActive = now - (n.lastActive || 0);
    const age = now - (n.firstSeen || n.lastActive || 0);
    const deg = degree.get(n.id) || 0;

    const recency    = Math.exp(-sinceActive / RECENCY_HALF);
    const creation   = Math.exp(-age / AGE_HALF);
    const mentions   = Math.log2((n.mentionCount || 0) + 1) / Math.log2(maxMentions + 1);
    const degScore   = Math.log2(deg + 1) / Math.log2(maxDegree + 1);
    const bridge     = (n.bridgeScore || 0) / maxBridge;

    const score = 0.30 * recency + 0.10 * creation + 0.25 * mentions + 0.15 * degScore + 0.20 * bridge;
    scores.set(n.id, score);
  }

  return { scores, degree };
}

function applyGravity(filtered, links, scores, degree, passes) {
  // Build adjacency list with link weights
  const adj = new Map();
  for (const n of filtered) adj.set(n.id, []);
  for (const l of links) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (adj.has(s) && adj.has(t)) {
      adj.get(s).push({ id: t, weight: l.weight || 1 });
      adj.get(t).push({ id: s, weight: l.weight || 1 });
    }
  }

  // Initialize Z from scores
  const zMap = new Map();
  for (const n of filtered) {
    zMap.set(n.id, (scores.get(n.id) || 0) * Z_RANGE);
  }

  for (let pass = 0; pass < passes; pass++) {
    for (const n of filtered) {
      const neighbors = adj.get(n.id);
      if (!neighbors || neighbors.length === 0) continue;

      const deg = degree.get(n.id) || 1;
      const inertia = 1 - 1 / (1 + Math.log2(deg));

      let weightSum = 0;
      let zWeighted = 0;
      for (const nb of neighbors) {
        const nbDeg = degree.get(nb.id) || 1;
        const w = Math.log2(nbDeg + 1) * nb.weight;
        zWeighted += zMap.get(nb.id) * w;
        weightSum += w;
      }

      if (weightSum > 0) {
        const neighborAvg = zWeighted / weightSum;
        const currentZ = zMap.get(n.id);
        const blend = PULL_STRENGTH * (1 - inertia);
        zMap.set(n.id, currentZ + (neighborAvg - currentZ) * blend);
      }
    }
  }

  return zMap;
}

function reRank(filtered, zMap) {
  // Sort by gravity-adjusted Z, then re-spread evenly across Z_RANGE
  const sorted = [...filtered].sort((a, b) => (zMap.get(a.id) || 0) - (zMap.get(b.id) || 0));
  const count = sorted.length || 1;
  for (let i = 0; i < sorted.length; i++) {
    sorted[i].fz = (i / (count - 1 || 1)) * Z_RANGE;
  }
}

function filterAndBuild() {
  const nodeSet = new Set();
  const filtered = allNodes.filter(n => {
    if (n.mentionCount < mentionThreshold) return false;
    nodeSet.add(n.id);
    return true;
  });
  const links = allLinks.filter(l => nodeSet.has(l.source) && nodeSet.has(l.target));

  document.getElementById('stat-nodes').textContent = filtered.length;
  document.getElementById('stat-edges').textContent = links.length;

  // 3-phase Z pipeline: relevance → gravity → re-rank
  const { scores, degree } = computeRelevanceScores(filtered, links);
  const zMap = applyGravity(filtered, links, scores, degree, GRAVITY_PASSES);
  reRank(filtered, zMap);

  // Stash degree on each node for the color system
  let maxDeg = 1;
  for (const n of filtered) {
    n.degree = degree.get(n.id) || 0;
    if (n.degree > maxDeg) maxDeg = n.degree;
  }
  // Log-scaled energy: 0 connections → 0, max connections → 1
  for (const n of filtered) {
    n.energy = Math.log2(n.degree + 1) / Math.log2(maxDeg + 1);
  }

  return { nodes: filtered, links };
}

Promise.all([
  fetch('/graph/depth/api/graph').then(r => r.json()),
  fetch('/graph/depth/api/threshold').then(r => r.json()),
]).then(([data, thresholdData]) => {
    mentionThreshold = thresholdData.value;
    document.getElementById('threshold').value = mentionThreshold;
    document.getElementById('threshold-val').textContent = mentionThreshold;

    allNodes = data.nodes;
    allLinks = data.links;

    const graphData = filterAndBuild();

    // Shared gradient shader for link lines — bright at endpoints, dim in middle
    gradLinkMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uOpacity: { value: linkOpacity }, uGradient: { value: linkGradient } },
      vertexShader: [
        'attribute float t;',
        'attribute vec3 vColor;',
        'varying float vT;',
        'varying vec3 fColor;',
        'void main() {',
        '  vT = t; fColor = vColor;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\\n'),
      fragmentShader: [
        'uniform float uOpacity;',
        'uniform float uGradient;',
        'varying float vT;',
        'varying vec3 fColor;',
        'void main() {',
        '  float fz = (1.0 - uGradient) * 0.5;',
        '  float dim = uGradient * uGradient;',
        '  float a;',
        '  if (fz < 0.001) { a = 1.0; }',
        '  else if (vT < fz) { a = mix(1.0, dim, vT / fz); }',
        '  else if (vT > 1.0 - fz) { a = mix(dim, 1.0, (vT - (1.0 - fz)) / fz); }',
        '  else { a = dim; }',
        '  a *= min(uGradient * 3.0, 1.0);',
        '  gl_FragColor = vec4(fColor, a * uOpacity);',
        '}',
      ].join('\\n'),
    });

    graph = ForceGraph3D({ controlType: 'orbit' })
      (document.getElementById('graph-3d'))
      .graphData(graphData)
      .backgroundColor('#0a0a14')
      .nodeColor(n => sparkNodeColor3D(n))
      .nodeVal(n => Math.max(0.3, Math.log2((n.mentionCount || 1) + 1) * 0.4 * nodeSizeMult))
      .nodeOpacity(0.85)
      .nodeLabel(null)
      .linkThreeObject(l => {
        const SEGS = 10;
        const colors = {
          uses:          [137,180,250],
          depends_on:    [243,139,168],
          related_to:    [203,166,247],
          part_of:       [166,227,161],
          configured_by: [250,179,135],
          solved_by:     [249,226,175],
        };
        const c = colors[l.type] || [69,71,90];
        const pts = SEGS + 1;
        const positions = new Float32Array(pts * 3);
        const tAttr = new Float32Array(pts);
        const colorAttr = new Float32Array(pts * 3);
        for (let i = 0; i < pts; i++) {
          tAttr[i] = i / SEGS;
          colorAttr[i*3]   = c[0] / 255;
          colorAttr[i*3+1] = c[1] / 255;
          colorAttr[i*3+2] = c[2] / 255;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('t', new THREE.BufferAttribute(tAttr, 1));
        geo.setAttribute('vColor', new THREE.BufferAttribute(colorAttr, 3));
        const line = new THREE.Line(geo, gradLinkMat);
        line.renderOrder = -1;
        return line;
      })
      .linkPositionUpdate((obj, { start, end }) => {
        const pos = obj.geometry.attributes.position;
        const arr = pos.array;
        const segs = (arr.length / 3) - 1;
        for (let i = 0; i <= segs; i++) {
          const f = i / segs;
          arr[i*3]   = start.x + (end.x - start.x) * f;
          arr[i*3+1] = start.y + (end.y - start.y) * f;
          arr[i*3+2] = start.z + (end.z - start.z) * f;
        }
        pos.needsUpdate = true;
        return true;
      })
      .linkWidth(0)
      .linkOpacity(1.0)
      .d3Force('charge', d3.forceManyBody().strength(forceRepel).distanceMax(300))
      .d3Force('link', d3.forceLink().id(d => d.id).distance(forceLinkDist).strength(l => Math.min((l.weight || 0.5) * forceLinkStr, forceLinkStr * 2)))
      .d3Force('z-pin', () => {
        const nodes = graph.graphData().nodes;
        for (const n of nodes) {
          if (n.fz != null) {
            n.vz = (n.vz || 0) * 0.1;
            n.z = n.z + (n.fz - n.z) * 0.1;
          }
        }
      })
      .onNodeHover(node => {
        document.getElementById('graph-3d').style.cursor = node ? 'pointer' : 'default';
        const tip = document.getElementById('tooltip');
        if (!node) { tip.style.display = 'none'; return; }
        let html = '<div class="name">' + esc(node.name) + '</div>';
        html += '<div class="type">' + node.type + ' &middot; ' + node.mentionCount + ' mentions</div>';
        if (node.description) html += '<div class="desc">' + esc(node.description) + '</div>';
        if (node.community) html += '<div class="community">' + esc(node.community) + '</div>';
        html += '<div class="time">Last active: ' + formatAge(node.lastActive) + '</div>';
        if (node.firstSeen) html += '<div class="time">First seen: ' + formatAge(node.firstSeen) + '</div>';
        if (node.bridgeScore > 0) html += '<div class="time">Bridge score: ' + node.bridgeScore.toFixed(3) + '</div>';
        tip.innerHTML = html;
        tip.style.display = 'block';
      })
      .onBackgroundClick(() => {
        document.getElementById('tooltip').style.display = 'none';
      })
      .warmupTicks(80)
      .cooldownTicks(200);

    document.addEventListener('mousemove', (e) => {
      const tip = document.getElementById('tooltip');
      if (tip.style.display === 'block') {
        tip.style.left = (e.clientX + 16) + 'px';
        tip.style.top = (e.clientY - 10) + 'px';
      }
    });

    // Fit camera to extents of visible nodes after simulation settles
    setTimeout(() => {
      const gd = graph.graphData();
      if (!gd.nodes.length) return;

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (const n of gd.nodes) {
        if (n.x == null) continue;
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
        const z = n.z || 0;
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      const spanX = maxX - minX;
      const spanY = maxY - minY;
      const spanZ = maxZ - minZ;
      const maxSpan = Math.max(spanX, spanY, spanZ, 1);

      // Distance needed to see the full extent (rough FOV estimate ~60deg)
      const dist = maxSpan * 1.2;

      graph.cameraPosition(
        { x: cx, y: cy - dist * 0.3, z: cz + dist },
        { x: cx, y: cy, z: cz },
        1500
      );
    }, 3000);
  });

// Controls
document.getElementById('threshold').addEventListener('input', (e) => {
  mentionThreshold = parseInt(e.target.value, 10);
  document.getElementById('threshold-val').textContent = mentionThreshold;
  if (graph) graph.graphData(filterAndBuild());
});

document.getElementById('node-size').addEventListener('input', (e) => {
  nodeSizeMult = parseInt(e.target.value, 10) / 10;
  document.getElementById('node-size-val').textContent = nodeSizeMult.toFixed(1);
  if (graph) graph.nodeVal(n => Math.max(0.3, Math.log2((n.mentionCount || 1) + 1) * 0.4 * nodeSizeMult));
});

document.getElementById('link-opacity').addEventListener('input', (e) => {
  linkOpacity = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-opacity-val').textContent = linkOpacity.toFixed(2);
  gradLinkMat.uniforms.uOpacity.value = linkOpacity;
});

document.getElementById('link-gradient').addEventListener('input', (e) => {
  linkGradient = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-gradient-val').textContent = e.target.value;
  gradLinkMat.uniforms.uGradient.value = linkGradient;
});

document.getElementById('z-range').addEventListener('input', (e) => {
  Z_RANGE = parseInt(e.target.value, 10);
  document.getElementById('z-range-val').textContent = Z_RANGE;
  if (graph) graph.graphData(filterAndBuild());
});

document.getElementById('repel-force').addEventListener('input', (e) => {
  forceRepel = -(parseInt(e.target.value, 10));
  document.getElementById('repel-force-val').textContent = forceRepel;
  if (graph) { graph.d3Force('charge').strength(forceRepel); graph.d3ReheatSimulation(); }
});

document.getElementById('link-force').addEventListener('input', (e) => {
  forceLinkStr = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-force-val').textContent = forceLinkStr.toFixed(2);
  if (graph) { graph.d3Force('link').strength(l => Math.min((l.weight || 0.5) * forceLinkStr, forceLinkStr * 2)); graph.d3ReheatSimulation(); }
});

document.getElementById('link-distance').addEventListener('input', (e) => {
  forceLinkDist = parseInt(e.target.value, 10);
  document.getElementById('link-distance-val').textContent = forceLinkDist;
  if (graph) { graph.d3Force('link').distance(forceLinkDist); graph.d3ReheatSimulation(); }
});

// Preset buttons
function applyPreset3D(name) {
  const p = PRESETS_3D[name];
  forceRepel = p.repel; forceLinkStr = p.linkStr; forceLinkDist = p.linkDist;
  document.getElementById('repel-force').value = Math.abs(p.repel);
  document.getElementById('repel-force-val').textContent = p.repel;
  document.getElementById('link-force').value = Math.round(p.linkStr * 100);
  document.getElementById('link-force-val').textContent = p.linkStr.toFixed(2);
  document.getElementById('link-distance').value = p.linkDist;
  document.getElementById('link-distance-val').textContent = p.linkDist;
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('preset-' + name).classList.add('active');
  if (graph) {
    graph.d3Force('charge').strength(forceRepel);
    graph.d3Force('link').distance(forceLinkDist).strength(l => Math.min((l.weight || 0.5) * forceLinkStr, forceLinkStr * 2));
    graph.d3ReheatSimulation();
  }
}
document.getElementById('preset-cluster').addEventListener('click', () => applyPreset3D('cluster'));
document.getElementById('preset-spread').addEventListener('click', () => applyPreset3D('spread'));

// ─── Spark color system (mirroring 2D) ─────────────────────────

const BG3D = [30, 30, 46];
const FADE_DURATION_3D = 60000;
const MIN_ENERGY_BLEND = 0.15;  // dimmest resting state (isolated nodes)
const MAX_ENERGY_BLEND = 0.95;  // brightest resting state (hub nodes)

function hexToRgb3D(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

const TYPE_RGB_3D = {};
for (const [k, hex] of Object.entries(TYPE_COLORS)) {
  TYPE_RGB_3D[k] = hexToRgb3D(hex);
}

// Compute resting color for a node based on its energy (degree-scaled 0-1)
function restingColor3D(type, energy) {
  const bright = TYPE_RGB_3D[type] || [136, 136, 136];
  const blend = MIN_ENERGY_BLEND + (MAX_ENERGY_BLEND - MIN_ENERGY_BLEND) * (energy || 0);
  return [
    Math.round(bright[0] * blend + BG3D[0] * (1 - blend)),
    Math.round(bright[1] * blend + BG3D[1] * (1 - blend)),
    Math.round(bright[2] * blend + BG3D[2] * (1 - blend)),
  ];
}

function sparkNodeColor3D(node) {
  const resting = restingColor3D(node.type, node.energy);
  if (!node.lastSpark) return 'rgb(' + resting.join(',') + ')';
  const age = Date.now() - node.lastSpark;
  if (age >= FADE_DURATION_3D) return 'rgb(' + resting.join(',') + ')';
  const t = age / FADE_DURATION_3D;
  const bright = TYPE_RGB_3D[node.type] || [136, 136, 136];
  // Spark always flashes to full bright, then fades to energy-based resting
  const r = Math.round(bright[0] + (resting[0] - bright[0]) * t);
  const g = Math.round(bright[1] + (resting[1] - bright[1]) * t);
  const b = Math.round(bright[2] + (resting[2] - bright[2]) * t);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// ─── Diff Polling (3D) ──────────────────────────────────────────

let lastDiffTimestamp3D = Math.floor(Date.now() / 1000);
let nodeMap3D = new Map();
let linkKey3D = new Set();
let autoZoom3D = localStorage.getItem('engram-autozoom-3d') !== 'false';
let lastAutoZoomTime3D = 0;
const AUTOZOOM_COOLDOWN = 5000;

function initLookups3D() {
  for (const n of allNodes) nodeMap3D.set(n.id, n);
  for (const l of allLinks) linkKey3D.add(l.source + '|' + l.target + '|' + l.type);
}

function pollDiff3D() {
  fetch('/graph/depth/api/diff?since=' + lastDiffTimestamp3D)
    .then(r => r.json())
    .then(mergeDiff3D)
    .catch(() => {});
}

function mergeDiff3D(diff) {
  if (!diff) return;
  lastDiffTimestamp3D = diff.timestamp;
  const sparkTime = Date.now();
  let changed = false;
  const newNodeIds = [];

  for (const n of diff.newNodes) {
    if (!nodeMap3D.has(n.id)) {
      n.lastSpark = sparkTime;
      n.lastActive = n.lastActive || 0;
      n.firstSeen = n.firstSeen || 0;
      n.bridgeScore = n.bridgeScore || 0;
      allNodes.push(n);
      nodeMap3D.set(n.id, n);
      newNodeIds.push(n.id);
      changed = true;
    }
  }

  for (const n of diff.updatedNodes) {
    const existing = nodeMap3D.get(n.id);
    if (existing) {
      existing.name = n.name;
      existing.description = n.description;
      existing.mentionCount = n.mentionCount;
      existing.community = n.community;
      existing.lastActive = n.lastActive || existing.lastActive;
      existing.firstSeen = n.firstSeen || existing.firstSeen;
      existing.bridgeScore = n.bridgeScore ?? existing.bridgeScore;
      existing.lastSpark = sparkTime;
      changed = true;
    }
  }

  for (const l of diff.newLinks) {
    const key = l.source + '|' + l.target + '|' + l.type;
    if (!linkKey3D.has(key)) {
      allLinks.push(l);
      linkKey3D.add(key);
      changed = true;
      const sn = nodeMap3D.get(l.source);
      const tn = nodeMap3D.get(l.target);
      if (sn) sn.lastSpark = sparkTime;
      if (tn) tn.lastSpark = sparkTime;
    }
  }

  for (const l of diff.updatedLinks) {
    for (const el of allLinks) {
      if (el.source === l.source && el.target === l.target && el.type === l.type) {
        el.weight = l.weight;
        el.context = l.context;
        changed = true;
        break;
      }
    }
  }

  if (changed && graph) {
    const gd = filterAndBuild();
    graph.graphData(gd);
    graph.nodeColor(n => sparkNodeColor3D(n));

    const live = document.getElementById('live');
    live.textContent = '+' + (diff.newNodes.length + diff.updatedNodes.length) + ' changes';
    live.classList.add('show');
    setTimeout(() => live.classList.remove('show'), 2000);

    // Auto-zoom to new nodes
    if (autoZoom3D && newNodeIds.length >= 2 && Date.now() - lastAutoZoomTime3D > AUTOZOOM_COOLDOWN) {
      setTimeout(() => {
        const gNodes = graph.graphData().nodes;
        const newNodes = newNodeIds.map(id => gNodes.find(n => n.id === id)).filter(n => n && n.x != null);

        if (newNodes.length >= 2) {
          let cx = 0, cy = 0, cz = 0;
          for (const n of newNodes) { cx += n.x; cy += n.y; cz += n.z || 0; }
          cx /= newNodes.length; cy /= newNodes.length; cz /= newNodes.length;

          let maxSpread = 0;
          for (const n of newNodes) {
            const dx = n.x - cx, dy = n.y - cy, dz = (n.z || 0) - cz;
            maxSpread = Math.max(maxSpread, Math.sqrt(dx*dx + dy*dy + dz*dz));
          }

          const dist = Math.max(maxSpread * 3, 200);
          graph.cameraPosition(
            { x: cx, y: cy - dist * 0.3, z: cz + dist },
            { x: cx, y: cy, z: cz },
            1200
          );
          lastAutoZoomTime3D = Date.now();
        }
      }, 500);
    }

    // Continue fade
    setTimeout(() => {
      if (graph) graph.nodeColor(n => sparkNodeColor3D(n));
    }, 1500);
  }
}

// Start polling after initial load
setTimeout(() => {
  initLookups3D();
  setInterval(pollDiff3D, 1500);
  if (graph) graph.nodeColor(n => sparkNodeColor3D(n));
}, 200);

// ─── Turntable Rotation ──────────────────────────────────────────

let autoRotateEnabled = true;
let autoRotateSpeed = 5; // degrees per second
let turntablePaused = false;
let idleTimer = null;
let turntableAngle = 0;
let lastTurntableTime = 0;

function getCentroid() {
  const gd = graph ? graph.graphData() : null;
  if (!gd || !gd.nodes.length) return { x: 0, y: 0, z: 0 };
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const n of gd.nodes) {
    if (n.x != null) { cx += n.x; cy += n.y; cz += n.z || 0; count++; }
  }
  if (count === 0) return { x: 0, y: 0, z: 0 };
  return { x: cx / count, y: cy / count, z: cz / count };
}

function turntableTick(now) {
  if (!graph || !autoRotateEnabled || turntablePaused) {
    lastTurntableTime = now;
    requestAnimationFrame(turntableTick);
    return;
  }

  if (!lastTurntableTime) lastTurntableTime = now;
  const dt = (now - lastTurntableTime) / 1000; // seconds
  lastTurntableTime = now;

  turntableAngle += autoRotateSpeed * dt * (Math.PI / 180); // convert deg/s to rad

  const cam = graph.cameraPosition();
  const center = getCentroid();

  // Vector from centroid to camera
  const dx = cam.x - center.x;
  const dz = (cam.z || 0) - center.z;
  const radius = Math.sqrt(dx * dx + dz * dz);

  if (radius > 0.1) {
    // Current angle in XZ plane around centroid
    const currentAngle = Math.atan2(dz, dx);
    const newAngle = currentAngle + autoRotateSpeed * dt * (Math.PI / 180);

    graph.cameraPosition({
      x: center.x + radius * Math.cos(newAngle),
      y: cam.y, // keep Y (height) unchanged
      z: center.z + radius * Math.sin(newAngle),
    });
  }

  requestAnimationFrame(turntableTick);
}

setTimeout(() => {
  if (!graph) return;

  // Pause on user interaction, resume after 5s idle
  const controls = graph.controls();
  if (controls) {
    controls.addEventListener('start', () => {
      turntablePaused = true;
      if (idleTimer) clearTimeout(idleTimer);
    });
    controls.addEventListener('end', () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { turntablePaused = false; }, 5000);
    });
  }

  requestAnimationFrame(turntableTick);
}, 500);

document.getElementById('toggle-autorotate').addEventListener('click', function() {
  this.classList.toggle('on');
  autoRotateEnabled = this.classList.contains('on');
});

document.getElementById('rotate-speed').addEventListener('input', (e) => {
  autoRotateSpeed = parseInt(e.target.value, 10);
  document.getElementById('rotate-speed-val').textContent = autoRotateSpeed;
});

document.getElementById('toggle-autozoom-3d').addEventListener('click', function() {
  this.classList.toggle('on');
  autoZoom3D = this.classList.contains('on');
  localStorage.setItem('engram-autozoom-3d', autoZoom3D);
});

if (!autoZoom3D) document.getElementById('toggle-autozoom-3d').classList.remove('on');

// ─── Growth Animation ────────────────────────────────────────────

let animating = false;
let animTime = 0;
let animMinTime = 0;
let animMaxTime = 0;
let animSpeed = 1;
const ANIM_SPEEDS = [1, 2, 5, 10, 20];
let animSpeedIdx = 0;
let animLastFrame = 0;
let animNodeOrder = [];
let animVisibleCount = 0;
let animSavedThreshold = 0;

const animBtn = document.getElementById('animate-btn');
const animProgress = document.getElementById('anim-progress');
const animBar = document.getElementById('anim-bar');
const animDate = document.getElementById('anim-date');
const animSpeedEl = document.getElementById('anim-speed');

function formatAnimDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function startAnimation() {
  // Animate within the current threshold — keeps node count manageable
  const thresholdFiltered = allNodes.filter(n => (n.mentionCount || 0) >= mentionThreshold);
  animNodeOrder = thresholdFiltered
    .filter(n => (n.firstSeen || 0) > 0)
    .sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
  if (animNodeOrder.length < 2) return;

  animMinTime = animNodeOrder[0].firstSeen;
  animMaxTime = animNodeOrder[animNodeOrder.length - 1].firstSeen;
  animTime = animMinTime;
  animVisibleCount = 0;
  animSavedThreshold = mentionThreshold;

  animating = true;
  animLastFrame = performance.now();
  animBtn.classList.add('playing');
  animBtn.innerHTML = '&#x25A0;';
  animProgress.classList.add('show');

  graph.graphData({ nodes: [], links: [] });
  requestAnimationFrame(animTickDepth);
}

function stopAnimation() {
  animating = false;
  animBtn.classList.remove('playing');
  animBtn.innerHTML = '&#x25B6;';
  animProgress.classList.remove('show');

  mentionThreshold = animSavedThreshold;
  document.getElementById('threshold').value = mentionThreshold;
  document.getElementById('threshold-val').textContent = mentionThreshold;
  graph.graphData(filterAndBuild());
}

function animTickDepth(now) {
  if (!animating) return;
  const dt = (now - animLastFrame) / 1000;
  animLastFrame = now;

  const BASE_DURATION = 45;
  const timeSpan = animMaxTime - animMinTime || 1;
  const timeScale = timeSpan / BASE_DURATION;
  animTime += dt * timeScale * animSpeed;

  if (animTime >= animMaxTime) {
    animTime = animMaxTime;
    animVisibleCount = animNodeOrder.length;
    animRebuildDepth();
    updateAnimUI();
    setTimeout(stopAnimation, 1500);
    return;
  }

  let newCount = animVisibleCount;
  while (newCount < animNodeOrder.length && (animNodeOrder[newCount].firstSeen || 0) <= animTime) {
    newCount++;
  }

  if (newCount > animVisibleCount) {
    const sparkTime = Date.now();
    for (let i = animVisibleCount; i < newCount; i++) {
      animNodeOrder[i].lastSpark = sparkTime;
    }
    animVisibleCount = newCount;
    animRebuildDepth();
  }

  updateAnimUI();
  requestAnimationFrame(animTickDepth);
}

function animRebuildDepth() {
  const visibleIds = new Set();
  for (let i = 0; i < animVisibleCount; i++) {
    visibleIds.add(animNodeOrder[i].id);
  }

  const filtered = animNodeOrder.slice(0, animVisibleCount);
  const links = allLinks.filter(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return visibleIds.has(s) && visibleIds.has(t);
  });

  // Depth relevance pipeline
  if (filtered.length > 0) {
    const { scores, degree } = computeRelevanceScores(filtered, links);
    const zMap = applyGravity(filtered, links, scores, degree, GRAVITY_PASSES);
    reRank(filtered, zMap);
    let maxDeg = 1;
    for (const n of filtered) {
      n.degree = degree.get(n.id) || 0;
      if (n.degree > maxDeg) maxDeg = n.degree;
    }
    for (const n of filtered) {
      n.energy = Math.log2(n.degree + 1) / Math.log2(maxDeg + 1);
    }
  }

  document.getElementById('stat-nodes').textContent = filtered.length;
  document.getElementById('stat-edges').textContent = links.length;

  graph.graphData({ nodes: filtered, links });
  graph.nodeColor(n => sparkNodeColor3D(n));
  setTimeout(() => { if (graph) graph.nodeColor(n => sparkNodeColor3D(n)); }, 1200);
}

function updateAnimUI() {
  const pct = ((animTime - animMinTime) / (animMaxTime - animMinTime || 1)) * 100;
  animBar.style.width = pct + '%';
  animDate.textContent = formatAnimDate(animTime);
}

animBtn.addEventListener('click', () => {
  if (animating) stopAnimation();
  else startAnimation();
});

animSpeedEl.addEventListener('click', () => {
  animSpeedIdx = (animSpeedIdx + 1) % ANIM_SPEEDS.length;
  animSpeed = ANIM_SPEEDS[animSpeedIdx];
  animSpeedEl.textContent = animSpeed + 'x';
});
</script>
</body>
</html>`;

// ─── Galaxy Page ─────────────────────────────────────────────────

const GALAXY_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram galaxy</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
    height: 100vh;
  }
  #graph-3d { width: 100vw; height: 100vh; }

  #tooltip {
    position: fixed;
    display: none;
    background: rgba(49, 50, 68, 0.95);
    border: 1px solid #45475a;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    max-width: 360px;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  }
  #tooltip .name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  #tooltip .type { color: #a6adc8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  #tooltip .desc { margin-top: 6px; color: #bac2de; line-height: 1.4; }
  #tooltip .community { margin-top: 6px; color: #74c7ec; font-size: 11px; }
  #tooltip .time { margin-top: 6px; color: #a6adc8; font-size: 11px; }

  #stats-bar {
    position: fixed; bottom: 12px; left: 16px; z-index: 50;
    font-size: 11px; color: #585b70; pointer-events: none;
  }

  ${PANEL_CSS}
</style>
</head>
<body>
<div id="graph-3d"></div>
<div id="tooltip"></div>
<div id="view-tabs">
  <a href="/graph">Graph</a>
  <a href="/graph/depth">Depth</a>
  <a class="active" href="/graph/galaxy">Galaxy</a>
  <a href="/graph/words">Words</a>
</div>
<div id="live">updated</div>
<div id="stats-bar"><span id="stat-nodes">-</span> nodes &middot; <span id="stat-edges">-</span> edges &middot; <span id="stat-hubs">-</span> systems</div>

<button id="animate-btn" title="Animate growth">&#x25B6;</button>
<div id="anim-progress"><span id="anim-date"></span><div id="anim-bar-wrap"><div id="anim-bar"></div></div><span id="anim-speed" title="Click to cycle speed">1x</span></div>

<button id="settings-toggle">&#x2026;</button>

<div id="settings-panel">
  <div class="panel-header">
    <h2>Galaxy view</h2>
    <div class="panel-header-actions">
      <button id="close-panel" title="Close">&times;</button>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Filters</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Min mentions <span class="val" id="threshold-val">5</span></div>
        <input type="range" id="threshold" min="1" max="50" value="5" />
      </div>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Galaxy</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Hub min degree <span class="val" id="hub-degree-val">15</span></div>
        <input type="range" id="hub-degree" min="5" max="50" value="15" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Disk flatness <span class="val" id="flatness-val">80</span></div>
        <input type="range" id="flatness" min="0" max="100" value="80" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">System spacing <span class="val" id="spacing-val">5</span></div>
        <input type="range" id="spacing" min="1" max="10" value="5" />
      </div>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Display</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Node size <span class="val" id="node-size-val">1.0</span></div>
        <input type="range" id="node-size" min="2" max="30" value="10" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link opacity <span class="val" id="link-opacity-val">0.3</span></div>
        <input type="range" id="link-opacity" min="1" max="100" value="30" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Link gradient <span class="val" id="link-gradient-val">50</span></div>
        <input type="range" id="link-gradient" min="0" max="100" value="50" />
      </div>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Behavior</span></div>
    <div class="section-body">
      <div class="ctrl-toggle">
        <span class="label">Auto-rotate</span>
        <div class="switch on" id="toggle-autorotate"></div>
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Rotate speed <span class="val" id="rotate-speed-val">5</span></div>
        <input type="range" id="rotate-speed" min="1" max="20" value="5" />
      </div>
    </div>
  </div>

</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
<script src="https://unpkg.com/3d-force-graph"></script>
<script>
// Panel logic
document.getElementById('settings-toggle').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('open');
});
document.getElementById('close-panel').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('open');
});
document.querySelectorAll('.section-header').forEach(hdr => {
  hdr.addEventListener('click', () => hdr.parentElement.classList.toggle('open'));
});

const TYPE_COLORS = {
  project:    '#f38ba8',
  tool:       '#89b4fa',
  technology: '#a6e3a1',
  person:     '#fab387',
  concept:    '#cba6f7',
  file:       '#6c7086',
  repo:       '#74c7ec',
};

let mentionThreshold = 5;
let hubMinDegree = 15;
let diskFlatness = 0.8;
let systemSpacing = 5;
let nodeSizeMult = 1.0;
let linkOpacity = 0.3;
let linkGradient = 0.5;

let allNodes = [], allLinks = [];
let graph;
let gradLinkMatGal;
let galaxyData = null; // result of classifyNodes + computeRotation

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function formatAge(ts) {
  if (!ts) return 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  if (diff < 2592000) return Math.round(diff / 86400) + 'd ago';
  return Math.round(diff / 2592000) + 'mo ago';
}

// ─── Hub Detection + Satellite Assignment ────────────────────────

function classifyNodes(filtered, links) {
  // Build adjacency + compute degree
  const adj = new Map();
  const degree = new Map();
  const weightedDegree = new Map();
  for (const n of filtered) {
    adj.set(n.id, []);
    degree.set(n.id, 0);
    weightedDegree.set(n.id, 0);
  }
  for (const l of links) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (adj.has(s) && adj.has(t)) {
      adj.get(s).push({ id: t, weight: l.weight || 1 });
      adj.get(t).push({ id: s, weight: l.weight || 1 });
      degree.set(s, (degree.get(s) || 0) + 1);
      degree.set(t, (degree.get(t) || 0) + 1);
      weightedDegree.set(s, (weightedDegree.get(s) || 0) + (l.weight || 1));
      weightedDegree.set(t, (weightedDegree.get(t) || 0) + (l.weight || 1));
    }
  }

  // Normalize values for hub scoring
  let maxDeg = 1, maxBridge = 0.001, maxMentions = 1;
  for (const n of filtered) {
    const d = degree.get(n.id) || 0;
    if (d > maxDeg) maxDeg = d;
    if ((n.bridgeScore || 0) > maxBridge) maxBridge = n.bridgeScore;
    if (n.mentionCount > maxMentions) maxMentions = n.mentionCount;
  }

  // hubScore = 0.5 * norm(degree) + 0.3 * norm(bridgeScore) + 0.2 * norm(mentions)
  const hubScore = new Map();
  for (const n of filtered) {
    const d = (degree.get(n.id) || 0) / maxDeg;
    const b = (n.bridgeScore || 0) / maxBridge;
    const m = n.mentionCount / maxMentions;
    hubScore.set(n.id, 0.5 * d + 0.3 * b + 0.2 * m);
  }

  // Select hubs: nodes with degree >= hubMinDegree, sorted by hubScore, capped at 50
  let hubs = filtered
    .filter(n => (degree.get(n.id) || 0) >= hubMinDegree)
    .sort((a, b) => (hubScore.get(b.id) || 0) - (hubScore.get(a.id) || 0))
    .slice(0, 50);

  const hubSet = new Set(hubs.map(h => h.id));

  // Assign satellites to hubs by affinity
  const hubOf = new Map(); // nodeId -> hubId
  const systemMembers = new Map(); // hubId -> Set<nodeId>
  const bridges = new Set();

  for (const h of hubs) {
    hubOf.set(h.id, h.id);
    systemMembers.set(h.id, new Set([h.id]));
  }

  // Compute affinity of each non-hub node to each hub
  for (const n of filtered) {
    if (hubSet.has(n.id)) continue;
    const neighbors = adj.get(n.id) || [];

    const affinities = new Map(); // hubId -> score
    for (const nb of neighbors) {
      if (hubSet.has(nb.id)) {
        affinities.set(nb.id, (affinities.get(nb.id) || 0) + nb.weight);
      }
    }

    // Add secondary affinity: 0.3 * edges to hub's other satellites
    // (deferred to second pass after initial assignment for efficiency)

    if (affinities.size > 0) {
      let bestHub = null, bestScore = -1, secondScore = 0;
      for (const [hid, score] of affinities) {
        if (score > bestScore) {
          secondScore = bestScore;
          bestScore = score;
          bestHub = hid;
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
      hubOf.set(n.id, bestHub);
      systemMembers.get(bestHub).add(n.id);

      // Bridge detection: secondary affinity > 40% of primary
      if (secondScore > bestScore * 0.4) {
        bridges.add(n.id);
      }
    }
  }

  // Fallback: unassigned nodes go to closest hub by community, then largest hub
  const largestHub = hubs.length > 0 ? hubs[0].id : null;
  for (const n of filtered) {
    if (hubOf.has(n.id)) continue;
    // Try community match
    let assigned = false;
    if (n.community) {
      for (const h of hubs) {
        if (h.community === n.community) {
          hubOf.set(n.id, h.id);
          systemMembers.get(h.id).add(n.id);
          assigned = true;
          break;
        }
      }
    }
    if (!assigned && largestHub) {
      hubOf.set(n.id, largestHub);
      systemMembers.get(largestHub).add(n.id);
    }
  }

  // Store degree on nodes
  for (const n of filtered) {
    n.degree = degree.get(n.id) || 0;
    n.isHub = hubSet.has(n.id);
    n.isBridge = bridges.has(n.id);
    n.hubId = hubOf.get(n.id) || null;
  }

  return { hubs, hubOf, bridges, degree, adj, systemMembers, hubSet };
}

// ─── Rotation Assignment ─────────────────────────────────────────

function computeRotation(systemMembers, adj, hubSet, filtered) {
  const nodeMap = new Map();
  for (const n of filtered) nodeMap.set(n.id, n);

  for (const [hubId, members] of systemMembers) {
    const satellites = [...members].filter(id => !hubSet.has(id));
    if (satellites.length === 0) {
      const h = nodeMap.get(hubId);
      if (h) h.diskNormal = { x: 0, y: 1, z: 0 };
      continue;
    }

    // Build intra-system neighbor sets
    const memberSet = new Set(members);
    const intraNeighbors = new Map();
    for (const sid of satellites) {
      const nbs = (adj.get(sid) || []).filter(nb => memberSet.has(nb.id)).map(nb => nb.id);
      intraNeighbors.set(sid, new Set(nbs));
    }

    // Compute pairwise Jaccard similarity
    function jaccard(a, b) {
      const setA = intraNeighbors.get(a) || new Set();
      const setB = intraNeighbors.get(b) || new Set();
      let inter = 0;
      for (const x of setA) if (setB.has(x)) inter++;
      const union = setA.size + setB.size - inter;
      return union === 0 ? 0 : inter / union;
    }

    // Greedy angular placement
    // Sort satellites by intra-system degree (descending)
    const satDegrees = satellites.map(id => ({
      id,
      deg: (intraNeighbors.get(id) || new Set()).size
    })).sort((a, b) => b.deg - a.deg);

    const placed = new Map(); // id -> angle
    const angleStep = (2 * Math.PI) / Math.max(satellites.length, 1);

    // Seed: highest-degree satellite at angle 0
    placed.set(satDegrees[0].id, 0);

    for (let i = 1; i < satDegrees.length; i++) {
      const sid = satDegrees[i].id;
      // Find most similar already-placed neighbor
      let bestSim = -1, bestAngle = 0;
      for (const [pid, pAngle] of placed) {
        const sim = jaccard(sid, pid);
        if (sim > bestSim) {
          bestSim = sim;
          bestAngle = pAngle;
        }
      }
      // Place near most similar, with offset to avoid overlap
      const offset = angleStep * (0.3 + 0.4 * (1 - bestSim));
      const sign = i % 2 === 0 ? 1 : -1;
      placed.set(sid, bestAngle + sign * offset);
    }

    // Store orbital angle on each satellite
    for (const [sid, angle] of placed) {
      const n = nodeMap.get(sid);
      if (n) n.orbitalAngle = angle;
    }

    // Compute per-system disk normal — each system gets a unique orientation
    // derived from a hash of the hubId so it's stable across rebuilds.
    // We want normals spread across the full sphere, not clustered near Y-up.
    const hubNode = nodeMap.get(hubId);

    // Hash hubId into two angles for spherical coordinates
    let h = 0;
    for (let ci = 0; ci < hubId.length; ci++) {
      h = ((h << 5) - h + hubId.charCodeAt(ci)) | 0;
    }
    // Use golden-ratio-based distribution for better spread across hubs
    const hubIndex = [...systemMembers.keys()].indexOf(hubId);
    const goldenAngle = 2.399963; // pi * (3 - sqrt(5))
    const theta = goldenAngle * hubIndex; // azimuthal — spreads evenly around Y
    const phi = Math.acos(1 - 2 * ((Math.abs(h) % 997) / 997)); // polar — uniform on sphere

    const diskNormal = {
      x: Math.sin(phi) * Math.cos(theta),
      y: Math.cos(phi),
      z: Math.sin(phi) * Math.sin(theta),
    };

    if (hubNode) hubNode.diskNormal = diskNormal;
  }
}

// ─── Gravitation computation ─────────────────────────────────────

function computeGravitation(filtered, links, hubOf, hubSet) {
  // Per satellite: gravitation = sum of edge weights to hub + 0.3 * edges to hub's other satellites
  const nodeMap = new Map();
  for (const n of filtered) nodeMap.set(n.id, n);

  for (const n of filtered) {
    if (hubSet.has(n.id)) {
      n.gravitation = 1.0; // hubs have max gravitation (they ARE the center)
      continue;
    }
    const myHub = hubOf.get(n.id);
    if (!myHub) { n.gravitation = 0.1; continue; }

    let directWeight = 0;
    let satelliteWeight = 0;
    for (const l of links) {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      const other = s === n.id ? t : t === n.id ? s : null;
      if (!other) continue;
      if (other === myHub) {
        directWeight += l.weight || 1;
      } else if (hubOf.get(other) === myHub) {
        satelliteWeight += l.weight || 1;
      }
    }
    n.gravitation = directWeight + 0.3 * satelliteWeight;
  }

  // Normalize gravitation
  let maxGrav = 0.001;
  for (const n of filtered) {
    if (!hubSet.has(n.id) && n.gravitation > maxGrav) maxGrav = n.gravitation;
  }
  for (const n of filtered) {
    if (!hubSet.has(n.id)) {
      n.gravitation = n.gravitation / maxGrav;
    }
  }
}

// ─── Energy color system (reuse from depth) ─────────────────────

const BG_GAL = [30, 30, 46];
const FADE_DURATION_GAL = 60000;
const MIN_ENERGY_BLEND_GAL = 0.15;
const MAX_ENERGY_BLEND_GAL = 0.95;

function hexToRgbGal(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

const TYPE_RGB_GAL = {};
for (const [k, hex] of Object.entries(TYPE_COLORS)) {
  TYPE_RGB_GAL[k] = hexToRgbGal(hex);
}

function restingColorGal(type, energy) {
  const bright = TYPE_RGB_GAL[type] || [136, 136, 136];
  const blend = MIN_ENERGY_BLEND_GAL + (MAX_ENERGY_BLEND_GAL - MIN_ENERGY_BLEND_GAL) * (energy || 0);
  return [
    Math.round(bright[0] * blend + BG_GAL[0] * (1 - blend)),
    Math.round(bright[1] * blend + BG_GAL[1] * (1 - blend)),
    Math.round(bright[2] * blend + BG_GAL[2] * (1 - blend)),
  ];
}

function sparkNodeColorGal(node) {
  const resting = restingColorGal(node.type, node.energy);
  if (!node.lastSpark) return 'rgb(' + resting.join(',') + ')';
  const age = Date.now() - node.lastSpark;
  if (age >= FADE_DURATION_GAL) return 'rgb(' + resting.join(',') + ')';
  const t = age / FADE_DURATION_GAL;
  const bright = TYPE_RGB_GAL[node.type] || [136, 136, 136];
  const r = Math.round(bright[0] + (resting[0] - bright[0]) * t);
  const g = Math.round(bright[1] + (resting[1] - bright[1]) * t);
  const b = Math.round(bright[2] + (resting[2] - bright[2]) * t);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// ─── Filter + Build ──────────────────────────────────────────────

function linkId(x) { return typeof x === 'object' ? x.id : x; }

function filterAndBuild() {
  const nodeSet = new Set();
  const filtered = allNodes.filter(n => {
    if (n.mentionCount < mentionThreshold) return false;
    nodeSet.add(n.id);
    return true;
  });
  const links = allLinks.filter(l => nodeSet.has(linkId(l.source)) && nodeSet.has(linkId(l.target)));

  // Classify into hub systems
  const classification = classifyNodes(filtered, links);
  galaxyData = classification;

  // Compute rotation vectors
  computeRotation(classification.systemMembers, classification.adj, classification.hubSet, filtered);

  // Compute gravitation
  computeGravitation(filtered, links, classification.hubOf, classification.hubSet);

  // Compute energy (degree-based brightness)
  let maxDeg = 1;
  for (const n of filtered) {
    if (n.degree > maxDeg) maxDeg = n.degree;
  }
  for (const n of filtered) {
    n.energy = Math.log2(n.degree + 1) / Math.log2(maxDeg + 1);
  }

  document.getElementById('stat-nodes').textContent = filtered.length;
  document.getElementById('stat-edges').textContent = links.length;
  document.getElementById('stat-hubs').textContent = classification.hubs.length;

  return { nodes: filtered, links };
}

// ─── Main Initialization ─────────────────────────────────────────

Promise.all([
  fetch('/graph/galaxy/api/graph').then(r => r.json()),
  fetch('/graph/galaxy/api/threshold').then(r => r.json()),
]).then(([data, thresholdData]) => {
  mentionThreshold = thresholdData.value;
  document.getElementById('threshold').value = mentionThreshold;
  document.getElementById('threshold-val').textContent = mentionThreshold;

  allNodes = data.nodes;
  allLinks = data.links;

  const graphData = filterAndBuild();

  // Shared gradient shader for Galaxy link lines
  gradLinkMatGal = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uOpacity: { value: linkOpacity }, uGradient: { value: linkGradient } },
    vertexShader: [
      'attribute float t;',
      'attribute vec3 vColor;',
      'attribute float dimFactor;',
      'varying float vT;',
      'varying vec3 fColor;',
      'varying float vDim;',
      'void main() {',
      '  vT = t; fColor = vColor; vDim = dimFactor;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}',
    ].join('\\n'),
    fragmentShader: [
      'uniform float uOpacity;',
      'uniform float uGradient;',
      'varying float vT;',
      'varying vec3 fColor;',
      'varying float vDim;',
      'void main() {',
      '  float fz = (1.0 - uGradient) * 0.5;',
      '  float dim = uGradient * uGradient;',
      '  float a;',
      '  if (fz < 0.001) { a = 1.0; }',
      '  else if (vT < fz) { a = mix(1.0, dim, vT / fz); }',
      '  else if (vT > 1.0 - fz) { a = mix(dim, 1.0, (vT - (1.0 - fz)) / fz); }',
      '  else { a = dim; }',
      '  a *= min(uGradient * 3.0, 1.0);',
      '  gl_FragColor = vec4(fColor, a * uOpacity * vDim);',
      '}',
    ].join('\\n'),
  });

  graph = ForceGraph3D({ controlType: 'orbit' })
    (document.getElementById('graph-3d'))
    .graphData(graphData)
    .backgroundColor('#0a0a14')
    .nodeThreeObject(node => {
      if (!node.isHub) return undefined;
      const group = new THREE.Group();
      const innerSize = Math.log2((node.degree || 1) + 1) * 2.0 * nodeSizeMult;
      const innerGeo = new THREE.SphereGeometry(innerSize, 16, 12);
      const col = TYPE_COLORS[node.type] || '#888888';
      const innerMat = new THREE.MeshLambertMaterial({ color: col, transparent: false });
      group.add(new THREE.Mesh(innerGeo, innerMat));
      const outerGeo = new THREE.SphereGeometry(innerSize * 1.6, 16, 12);
      const outerMat = new THREE.MeshLambertMaterial({
        color: col,
        transparent: true,
        opacity: 0.15,
      });
      group.add(new THREE.Mesh(outerGeo, outerMat));
      return group;
    })
    .nodeColor(n => sparkNodeColorGal(n))
    .nodeVal(n => {
      return Math.max(0.3, Math.log2((n.mentionCount || 1) + 1) * (n.isHub ? 1.5 : 0.4) * nodeSizeMult);
    })
    .nodeOpacity(0.85)
    .nodeLabel(null)
    .linkThreeObject(l => {
      const SEGS = 10;
      const colors = {
        uses:          [137,180,250],
        depends_on:    [243,139,168],
        related_to:    [203,166,247],
        part_of:       [166,227,161],
        configured_by: [250,179,135],
        solved_by:     [249,226,175],
      };
      const c = colors[l.type] || [69,71,90];
      // Intra-system vs inter-system dim factor
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      const sHub = galaxyData ? galaxyData.hubOf.get(s) : null;
      const tHub = galaxyData ? galaxyData.hubOf.get(t) : null;
      const dim = (sHub && sHub === tHub) ? 1.0 : 0.5;
      const pts = SEGS + 1;
      const positions = new Float32Array(pts * 3);
      const tAttr = new Float32Array(pts);
      const colorAttr = new Float32Array(pts * 3);
      const dimAttr = new Float32Array(pts);
      for (let i = 0; i < pts; i++) {
        tAttr[i] = i / SEGS;
        colorAttr[i*3]   = c[0] / 255;
        colorAttr[i*3+1] = c[1] / 255;
        colorAttr[i*3+2] = c[2] / 255;
        dimAttr[i] = dim;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('t', new THREE.BufferAttribute(tAttr, 1));
      geo.setAttribute('vColor', new THREE.BufferAttribute(colorAttr, 3));
      geo.setAttribute('dimFactor', new THREE.BufferAttribute(dimAttr, 1));
      const line = new THREE.Line(geo, gradLinkMatGal);
      line.renderOrder = -1;
      return line;
    })
    .linkPositionUpdate((obj, { start, end }) => {
      const pos = obj.geometry.attributes.position;
      const arr = pos.array;
      const segs = (arr.length / 3) - 1;
      for (let i = 0; i <= segs; i++) {
        const f = i / segs;
        arr[i*3]   = start.x + (end.x - start.x) * f;
        arr[i*3+1] = start.y + (end.y - start.y) * f;
        arr[i*3+2] = start.z + (end.z - start.z) * f;
      }
      pos.needsUpdate = true;
      return true;
    })
    .linkWidth(0)
    .linkOpacity(1.0)
    // Force 1: Variable-strength charge — hubs repel strongly to separate systems
    .d3Force('charge', d3.forceManyBody()
      .strength(n => n.isHub ? -400 * systemSpacing : -8)
      .distanceMax(1200)
    )
    // Force 2: Link force — only intra-system links participate in the simulation
    // Inter-system links are rendered visually but have zero force, allowing
    // hub repulsion to separate systems into distinct clusters.
    .d3Force('link', d3.forceLink().id(d => d.id)
      .distance(l => {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        const sHub = galaxyData ? galaxyData.hubOf.get(s) : null;
        const tHub = galaxyData ? galaxyData.hubOf.get(t) : null;
        return (sHub && sHub === tHub) ? 15 : 300;
      })
      .strength(l => {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        const sHub = galaxyData ? galaxyData.hubOf.get(s) : null;
        const tHub = galaxyData ? galaxyData.hubOf.get(t) : null;
        return (sHub && sHub === tHub) ? (l.weight || 0.5) * 0.3 : 0.002;
      })
    )
    // Force 6: Gentle centering
    .d3Force('center', d3.forceCenter(0, 0, 0).strength(0.003))
    // Custom forces: hub-repel + hub-attract + disk-flatten + orbital-align
    .d3Force('galaxy-custom', () => {
      if (!galaxyData) return;
      const nodes = graph.graphData().nodes;
      const nodeMap = new Map();
      for (const n of nodes) nodeMap.set(n.id, n);

      // Hub-to-hub repulsion: O(H^2) where H=50, ensures systems separate
      // Uses a minimum-distance threshold so hubs settle at a characteristic spacing
      const hubNodes = galaxyData.hubs.map(h => nodeMap.get(h.id)).filter(h => h && h.x != null);
      const minHubDist = 80 * systemSpacing; // desired minimum separation
      for (let i = 0; i < hubNodes.length; i++) {
        for (let j = i + 1; j < hubNodes.length; j++) {
          const a = hubNodes[i], b = hubNodes[j];
          const dx = (a.x || 0) - (b.x || 0);
          const dy = (a.y || 0) - (b.y || 0);
          const dz = (a.z || 0) - (b.z || 0);
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          if (dist >= minHubDist) continue; // only repel when too close
          // Spring-like push: stronger the closer they are to minDist
          const overlap = 1 - dist / minHubDist;
          const force = overlap * 8 * systemSpacing;
          const fx = dx / dist * force;
          const fy = dy / dist * force;
          const fz = dz / dist * force;
          a.vx = (a.vx || 0) + fx;
          a.vy = (a.vy || 0) + fy;
          a.vz = (a.vz || 0) + fz;
          b.vx = (b.vx || 0) - fx;
          b.vy = (b.vy || 0) - fy;
          b.vz = (b.vz || 0) - fz;
        }
      }

      for (const n of nodes) {
        if (n.isHub || !n.hubId) continue;
        const hub = nodeMap.get(n.hubId);
        if (!hub || hub.x == null) continue;

        // Force 3: Hub attraction — pull satellites toward their hub
        const dx = hub.x - (n.x || 0);
        const dy = hub.y - (n.y || 0);
        const dz = (hub.z || 0) - (n.z || 0);
        const grav = (n.gravitation || 0.1) * 0.15;
        n.vx = (n.vx || 0) + dx * grav;
        n.vy = (n.vy || 0) + dy * grav;
        n.vz = (n.vz || 0) + dz * grav;

        // Force 4: Disk flatten — push satellites toward consensus plane
        // Strength scales with off-plane distance: behaves like a spring
        // pulling nodes back to the disk plane
        if (hub.diskNormal && diskFlatness > 0) {
          const rx = (n.x || 0) - hub.x;
          const ry = (n.y || 0) - hub.y;
          const rz = (n.z || 0) - (hub.z || 0);
          const dn = hub.diskNormal;
          const dot = rx * dn.x + ry * dn.y + rz * dn.z;
          // Strong spring: 0.4 base * flatness, damping the normal-component velocity
          const flatForce = diskFlatness * 0.4;
          n.vx = (n.vx || 0) - dot * dn.x * flatForce;
          n.vy = (n.vy || 0) - dot * dn.y * flatForce;
          n.vz = (n.vz || 0) - dot * dn.z * flatForce;
        }

        // Force 5: Orbital alignment — connected satellites share plane
        if (n.orbitalAngle != null && galaxyData.adj) {
          const neighbors = galaxyData.adj.get(n.id) || [];
          for (const nb of neighbors) {
            const nbNode = nodeMap.get(nb.id);
            if (!nbNode || nbNode.hubId !== n.hubId || nbNode.isHub) continue;
            if (nbNode.orbitalAngle == null) continue;
            // Pull orbital angles toward each other
            const angleDiff = nbNode.orbitalAngle - n.orbitalAngle;
            const pull = Math.sin(angleDiff) * 0.005;
            n.orbitalAngle += pull;
          }
        }

        // Bridge nodes: pull toward weighted midpoint of their top-2 hubs
        if (n.isBridge && galaxyData.hubOf) {
          // Find secondary hub
          const neighbors = galaxyData.adj.get(n.id) || [];
          let secondHub = null, secondWeight = 0;
          for (const nb of neighbors) {
            if (galaxyData.hubSet.has(nb.id) && nb.id !== n.hubId) {
              if (nb.weight > secondWeight) {
                secondWeight = nb.weight;
                secondHub = nb.id;
              }
            }
          }
          if (secondHub) {
            const hub2 = nodeMap.get(secondHub);
            if (hub2 && hub2.x != null) {
              // Pull toward 60/40 weighted midpoint
              const mx = hub.x * 0.6 + hub2.x * 0.4;
              const my = hub.y * 0.6 + hub2.y * 0.4;
              const mz = (hub.z || 0) * 0.6 + (hub2.z || 0) * 0.4;
              n.vx = (n.vx || 0) + (mx - (n.x || 0)) * 0.02;
              n.vy = (n.vy || 0) + (my - (n.y || 0)) * 0.02;
              n.vz = (n.vz || 0) + (mz - (n.z || 0)) * 0.02;
            }
          }
        }
      }
    })
    .onNodeHover(node => {
      document.getElementById('graph-3d').style.cursor = node ? 'pointer' : 'default';
      const tip = document.getElementById('tooltip');
      if (!node) { tip.style.display = 'none'; return; }
      let html = '<div class="name">' + esc(node.name) + '</div>';
      html += '<div class="type">' + node.type + ' &middot; ' + node.mentionCount + ' mentions</div>';
      if (node.description) html += '<div class="desc">' + esc(node.description) + '</div>';
      if (node.community) html += '<div class="community">' + esc(node.community) + '</div>';
      html += '<div class="time">Last active: ' + formatAge(node.lastActive) + '</div>';
      if (node.firstSeen) html += '<div class="time">First seen: ' + formatAge(node.firstSeen) + '</div>';
      if (node.isHub) html += '<div class="time" style="color:#f9e2af">Hub node (degree: ' + node.degree + ')</div>';
      if (node.hubId && !node.isHub) html += '<div class="time">System: ' + esc(node.hubId.slice(0,20)) + '</div>';
      if (node.orbitalAngle != null) html += '<div class="time">Orbital angle: ' + (node.orbitalAngle * 180 / Math.PI).toFixed(1) + '&deg;</div>';
      if (node.gravitation != null && !node.isHub) html += '<div class="time">Gravitation: ' + node.gravitation.toFixed(2) + '</div>';
      if (node.isBridge) html += '<div class="time" style="color:#a6e3a1">Bridge node</div>';
      tip.innerHTML = html;
      tip.style.display = 'block';
    })
    .onBackgroundClick(() => {
      document.getElementById('tooltip').style.display = 'none';
    })
    .warmupTicks(120)
    .cooldownTicks(300);

  document.addEventListener('mousemove', (e) => {
    const tip = document.getElementById('tooltip');
    if (tip.style.display === 'block') {
      tip.style.left = (e.clientX + 16) + 'px';
      tip.style.top = (e.clientY - 10) + 'px';
    }
  });

  // Fit camera after simulation settles
  setTimeout(() => {
    const gd = graph.graphData();
    if (!gd.nodes.length) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const n of gd.nodes) {
      if (n.x == null) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      const z = n.z || 0;
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const maxSpan = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    const dist = maxSpan * 1.2;

    graph.cameraPosition(
      { x: cx, y: cy - dist * 0.3, z: cz + dist },
      { x: cx, y: cy, z: cz },
      1500
    );
  }, 3500);
});

// ─── Settings Controls ───────────────────────────────────────────

document.getElementById('threshold').addEventListener('input', (e) => {
  mentionThreshold = parseInt(e.target.value, 10);
  document.getElementById('threshold-val').textContent = mentionThreshold;
  if (graph) graph.graphData(filterAndBuild());
});

document.getElementById('hub-degree').addEventListener('input', (e) => {
  hubMinDegree = parseInt(e.target.value, 10);
  document.getElementById('hub-degree-val').textContent = hubMinDegree;
  if (graph) graph.graphData(filterAndBuild());
});

document.getElementById('flatness').addEventListener('input', (e) => {
  diskFlatness = parseInt(e.target.value, 10) / 100;
  document.getElementById('flatness-val').textContent = parseInt(e.target.value, 10);
  if (graph) graph.d3ReheatSimulation();
});

document.getElementById('spacing').addEventListener('input', (e) => {
  systemSpacing = parseInt(e.target.value, 10);
  document.getElementById('spacing-val').textContent = systemSpacing;
  if (graph) {
    graph.d3Force('charge').strength(n => n.isHub ? -400 * systemSpacing : -8);
    graph.d3ReheatSimulation();
  }
});

document.getElementById('node-size').addEventListener('input', (e) => {
  nodeSizeMult = parseInt(e.target.value, 10) / 10;
  document.getElementById('node-size-val').textContent = nodeSizeMult.toFixed(1);
  if (graph) {
    graph.nodeVal(n => {
      if (n.isHub) return 0;
      return Math.max(0.3, Math.log2((n.mentionCount || 1) + 1) * 0.4 * nodeSizeMult);
    });
  }
});

document.getElementById('link-opacity').addEventListener('input', (e) => {
  linkOpacity = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-opacity-val').textContent = linkOpacity.toFixed(2);
  gradLinkMatGal.uniforms.uOpacity.value = linkOpacity;
});

document.getElementById('link-gradient').addEventListener('input', (e) => {
  linkGradient = parseInt(e.target.value, 10) / 100;
  document.getElementById('link-gradient-val').textContent = e.target.value;
  gradLinkMatGal.uniforms.uGradient.value = linkGradient;
});

// ─── Diff Polling (Galaxy) ───────────────────────────────────────

let lastDiffTimestampGal = Math.floor(Date.now() / 1000);
let nodeMapGal = new Map();
let linkKeyGal = new Set();

function initLookupsGal() {
  for (const n of allNodes) nodeMapGal.set(n.id, n);
  for (const l of allLinks) linkKeyGal.add(l.source + '|' + l.target + '|' + l.type);
}

function pollDiffGal() {
  fetch('/graph/galaxy/api/diff?since=' + lastDiffTimestampGal)
    .then(r => r.json())
    .then(mergeDiffGal)
    .catch(() => {});
}

function mergeDiffGal(diff) {
  if (!diff) return;
  lastDiffTimestampGal = diff.timestamp;
  const sparkTime = Date.now();
  let changed = false;

  for (const n of diff.newNodes) {
    if (!nodeMapGal.has(n.id)) {
      n.lastSpark = sparkTime;
      n.lastActive = n.lastActive || 0;
      n.firstSeen = n.firstSeen || 0;
      n.bridgeScore = n.bridgeScore || 0;
      allNodes.push(n);
      nodeMapGal.set(n.id, n);
      changed = true;
    }
  }

  for (const n of diff.updatedNodes) {
    const existing = nodeMapGal.get(n.id);
    if (existing) {
      existing.name = n.name;
      existing.description = n.description;
      existing.mentionCount = n.mentionCount;
      existing.community = n.community;
      existing.lastActive = n.lastActive || existing.lastActive;
      existing.firstSeen = n.firstSeen || existing.firstSeen;
      existing.bridgeScore = n.bridgeScore ?? existing.bridgeScore;
      existing.lastSpark = sparkTime;
      changed = true;
    }
  }

  for (const l of diff.newLinks) {
    const key = l.source + '|' + l.target + '|' + l.type;
    if (!linkKeyGal.has(key)) {
      allLinks.push(l);
      linkKeyGal.add(key);
      changed = true;
      const sn = nodeMapGal.get(l.source);
      const tn = nodeMapGal.get(l.target);
      if (sn) sn.lastSpark = sparkTime;
      if (tn) tn.lastSpark = sparkTime;
    }
  }

  for (const l of diff.updatedLinks) {
    for (const el of allLinks) {
      if (linkId(el.source) === l.source && linkId(el.target) === l.target && el.type === l.type) {
        el.weight = l.weight;
        el.context = l.context;
        changed = true;
        break;
      }
    }
  }

  if (changed && graph) {
    const gd = filterAndBuild();
    graph.graphData(gd);
    graph.nodeColor(n => sparkNodeColorGal(n));

    const live = document.getElementById('live');
    live.textContent = '+' + (diff.newNodes.length + diff.updatedNodes.length) + ' changes';
    live.classList.add('show');
    setTimeout(() => live.classList.remove('show'), 2000);

    setTimeout(() => {
      if (graph) graph.nodeColor(n => sparkNodeColorGal(n));
    }, 1500);
  }
}

// Start polling after initial load
setTimeout(() => {
  initLookupsGal();
  setInterval(pollDiffGal, 1500);
  if (graph) graph.nodeColor(n => sparkNodeColorGal(n));
}, 200);

// ─── Turntable Rotation ──────────────────────────────────────────

let autoRotateEnabled = true;
let autoRotateSpeed = 5;
let turntablePaused = false;
let idleTimer = null;
let lastTurntableTime = 0;

function getCentroidGal() {
  const gd = graph ? graph.graphData() : null;
  if (!gd || !gd.nodes.length) return { x: 0, y: 0, z: 0 };
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const n of gd.nodes) {
    if (n.x != null) { cx += n.x; cy += n.y; cz += n.z || 0; count++; }
  }
  if (count === 0) return { x: 0, y: 0, z: 0 };
  return { x: cx / count, y: cy / count, z: cz / count };
}

function turntableTickGal(now) {
  if (!graph || !autoRotateEnabled || turntablePaused) {
    lastTurntableTime = now;
    requestAnimationFrame(turntableTickGal);
    return;
  }

  if (!lastTurntableTime) lastTurntableTime = now;
  const dt = (now - lastTurntableTime) / 1000;
  lastTurntableTime = now;

  const cam = graph.cameraPosition();
  const center = getCentroidGal();

  const dx = cam.x - center.x;
  const dz = (cam.z || 0) - center.z;
  const radius = Math.sqrt(dx * dx + dz * dz);

  if (radius > 0.1) {
    const currentAngle = Math.atan2(dz, dx);
    const newAngle = currentAngle + autoRotateSpeed * dt * (Math.PI / 180);

    graph.cameraPosition({
      x: center.x + radius * Math.cos(newAngle),
      y: cam.y,
      z: center.z + radius * Math.sin(newAngle),
    });
  }

  requestAnimationFrame(turntableTickGal);
}

setTimeout(() => {
  if (!graph) return;

  const controls = graph.controls();
  if (controls) {
    controls.addEventListener('start', () => {
      turntablePaused = true;
      if (idleTimer) clearTimeout(idleTimer);
    });
    controls.addEventListener('end', () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { turntablePaused = false; }, 5000);
    });
  }

  requestAnimationFrame(turntableTickGal);
}, 500);

document.getElementById('toggle-autorotate').addEventListener('click', function() {
  this.classList.toggle('on');
  autoRotateEnabled = this.classList.contains('on');
});

document.getElementById('rotate-speed').addEventListener('input', (e) => {
  autoRotateSpeed = parseInt(e.target.value, 10);
  document.getElementById('rotate-speed-val').textContent = autoRotateSpeed;
});

// ─── Growth Animation ────────────────────────────────────────────

let animating = false;
let animTime = 0;
let animMinTime = 0;
let animMaxTime = 0;
let animSpeed = 1;
const ANIM_SPEEDS = [1, 2, 5, 10, 20];
let animSpeedIdx = 0;
let animLastFrame = 0;
let animNodeOrder = [];
let animVisibleCount = 0;
let animSavedThreshold = 0;
let animLastClassify = 0;
let animLastClassifyTime = 0;

const animBtn = document.getElementById('animate-btn');
const animProgress = document.getElementById('anim-progress');
const animBar = document.getElementById('anim-bar');
const animDate = document.getElementById('anim-date');
const animSpeedEl = document.getElementById('anim-speed');

function formatAnimDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function startAnimation() {
  // Animate within the current threshold — keeps node count manageable
  const thresholdFiltered = allNodes.filter(n => (n.mentionCount || 0) >= mentionThreshold);
  animNodeOrder = thresholdFiltered
    .filter(n => (n.firstSeen || 0) > 0)
    .sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
  if (animNodeOrder.length < 2) return;

  animMinTime = animNodeOrder[0].firstSeen;
  animMaxTime = animNodeOrder[animNodeOrder.length - 1].firstSeen;
  animTime = animMinTime;
  animVisibleCount = 0;
  animSavedThreshold = mentionThreshold;
  animLastClassify = 0; // throttle tracker

  animating = true;
  animLastFrame = performance.now();
  animBtn.classList.add('playing');
  animBtn.innerHTML = '&#x25A0;'; // square = stop
  animProgress.classList.add('show');

  // Start with empty graph
  graph.graphData({ nodes: [], links: [] });
  requestAnimationFrame(animTick);
}

function stopAnimation() {
  animating = false;
  animBtn.classList.remove('playing');
  animBtn.innerHTML = '&#x25B6;'; // triangle = play
  animProgress.classList.remove('show');

  // Restore normal view
  mentionThreshold = animSavedThreshold;
  document.getElementById('threshold').value = mentionThreshold;
  document.getElementById('threshold-val').textContent = mentionThreshold;
  graph.graphData(filterAndBuild());
}

function animTick(now) {
  if (!animating) return;
  const dt = (now - animLastFrame) / 1000;
  animLastFrame = now;

  // Compress full time span into ~45 seconds at 1x
  const BASE_DURATION = 45;
  const timeSpan = animMaxTime - animMinTime || 1;
  const timeScale = timeSpan / BASE_DURATION;
  animTime += dt * timeScale * animSpeed;

  if (animTime >= animMaxTime) {
    animTime = animMaxTime;
    // Let it settle on the final frame, then stop
    animVisibleCount = animNodeOrder.length;
    animRebuild();
    updateAnimUI();
    setTimeout(stopAnimation, 1500);
    return;
  }

  // Check if new nodes should appear
  let newCount = animVisibleCount;
  while (newCount < animNodeOrder.length && (animNodeOrder[newCount].firstSeen || 0) <= animTime) {
    newCount++;
  }

  if (newCount > animVisibleCount) {
    // Spark newly appearing nodes
    const sparkTime = Date.now();
    for (let i = animVisibleCount; i < newCount; i++) {
      animNodeOrder[i].lastSpark = sparkTime;
    }
    animVisibleCount = newCount;
    animRebuild();
  }

  updateAnimUI();
  requestAnimationFrame(animTick);
}

function animRebuild() {
  // Build visible set from animation order
  const visibleIds = new Set();
  for (let i = 0; i < animVisibleCount; i++) {
    visibleIds.add(animNodeOrder[i].id);
  }

  const filtered = animNodeOrder.slice(0, animVisibleCount);
  const links = allLinks.filter(l => {
    const s = linkId(l.source);
    const t = linkId(l.target);
    return visibleIds.has(s) && visibleIds.has(t);
  });

  // Throttle galaxy reclassification: every 30 nodes or 500ms
  const now = performance.now();
  const shouldClassify = filtered.length > 0 && links.length > 0 &&
    (animVisibleCount - (animLastClassify || 0) >= 30 || now - (animLastClassifyTime || 0) > 500 || animVisibleCount === animNodeOrder.length);
  if (shouldClassify) {
    const classification = classifyNodes(filtered, links);
    galaxyData = classification;
    computeRotation(classification.systemMembers, classification.adj, classification.hubSet, filtered);
    computeGravitation(filtered, links, classification.hubOf, classification.hubSet);
    animLastClassify = animVisibleCount;
    animLastClassifyTime = now;
  }

  // Compute energy
  let maxDeg = 1;
  for (const n of filtered) { if ((n.degree || 0) > maxDeg) maxDeg = n.degree; }
  for (const n of filtered) {
    n.energy = Math.log2((n.degree || 0) + 1) / Math.log2(maxDeg + 1);
  }

  document.getElementById('stat-nodes').textContent = filtered.length;
  document.getElementById('stat-edges').textContent = links.length;
  document.getElementById('stat-hubs').textContent = galaxyData ? galaxyData.hubs.length : 0;

  graph.graphData({ nodes: filtered, links });
  graph.nodeColor(n => sparkNodeColorGal(n));

  // Refresh spark colors after glow period
  setTimeout(() => { if (graph) graph.nodeColor(n => sparkNodeColorGal(n)); }, 1200);
}

function updateAnimUI() {
  const pct = ((animTime - animMinTime) / (animMaxTime - animMinTime || 1)) * 100;
  animBar.style.width = pct + '%';
  animDate.textContent = formatAnimDate(animTime);
}

animBtn.addEventListener('click', () => {
  if (animating) stopAnimation();
  else startAnimation();
});

animSpeedEl.addEventListener('click', () => {
  animSpeedIdx = (animSpeedIdx + 1) % ANIM_SPEEDS.length;
  animSpeed = ANIM_SPEEDS[animSpeedIdx];
  animSpeedEl.textContent = animSpeed + 'x';
});
</script>
</body>
</html>`;

// ─── Words Cloud Page ────────────────────────────────────────────

const WORDS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>engram words</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e1e2e;
    color: #cdd6f4;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #cloud { width: 100vw; height: 100vh; }

  #tooltip {
    position: fixed;
    display: none;
    background: #313244;
    border: 1px solid #45475a;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 13px;
    pointer-events: none;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }

  #stats-bar {
    position: fixed; bottom: 12px; left: 16px; z-index: 50;
    font-size: 11px; color: #585b70; pointer-events: none;
  }

  ${PANEL_CSS}
</style>
</head>
<body>
<div id="cloud"></div>
<div id="tooltip"></div>
<div id="view-tabs">
  <a href="/graph">Graph</a>
  <a href="/graph/depth">Depth</a>
  <a href="/graph/galaxy">Galaxy</a>
  <a class="active" href="/graph/words">Words</a>
</div>
<div id="live">updated</div>
<div id="stats-bar"><span id="stat-words">-</span> words from episodic memory</div>

<button id="settings-toggle">&#x2026;</button>

<div id="settings-panel">
  <div class="panel-header">
    <h2>Word cloud</h2>
    <div class="panel-header-actions">
      <button id="close-panel" title="Close">&times;</button>
    </div>
  </div>

  <div class="section open">
    <div class="section-header"><span class="arrow">&#x25B6;</span><span class="section-title">Display</span></div>
    <div class="section-body">
      <div class="ctrl-row">
        <div class="ctrl-label">Word count <span class="val" id="word-count-val">200</span></div>
        <input type="range" id="word-count" min="50" max="400" value="200" />
      </div>
      <div class="ctrl-row">
        <div class="ctrl-label">Min frequency <span class="val" id="min-freq-val">3</span></div>
        <input type="range" id="min-freq" min="1" max="20" value="3" />
      </div>
    </div>
  </div>

</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3-cloud/1.2.7/d3.layout.cloud.min.js"></script>
<script>
// Panel logic
document.getElementById('settings-toggle').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('open');
});
document.getElementById('close-panel').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('open');
});
document.querySelectorAll('.section-header').forEach(hdr => {
  hdr.addEventListener('click', () => hdr.parentElement.classList.toggle('open'));
});

const PALETTE = [
  '#f38ba8', '#89b4fa', '#a6e3a1', '#fab387', '#cba6f7',
  '#74c7ec', '#f9e2af', '#94e2d5', '#f2cdcd', '#b4befe',
  '#eba0ac', '#89dceb',
];

let wordData = [];
let wordCount = 200;

function renderCloud(words) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (words.length === 0) return;
  const maxCount = words[0].count;
  const minCount = words[words.length - 1].count;

  const fontScale = d3.scaleSqrt()
    .domain([minCount, maxCount])
    .range([10, Math.min(width, height) / 7]);

  const container = document.getElementById('cloud');
  container.innerHTML = '';

  d3.layout.cloud()
    .size([width, height])
    .words(words.map((d, i) => ({
      text: d.text,
      size: fontScale(d.count),
      count: d.count,
      ci: i,
    })))
    .padding(3)
    .rotate(() => {
      const r = Math.random();
      if (r < 0.65) return 0;
      if (r < 0.85) return 90;
      return (~~(Math.random() * 5) - 2) * 15;
    })
    .font('-apple-system, system-ui, sans-serif')
    .fontWeight(d => d.size > fontScale(maxCount) * 0.6 ? '700' : d.size > fontScale(maxCount) * 0.3 ? '600' : '400')
    .fontSize(d => d.size)
    .spiral('archimedean')
    .on('end', (drawn) => {
      const svg = d3.select('#cloud').append('svg')
        .attr('width', width)
        .attr('height', height);

      const g = svg.append('g')
        .attr('transform', 'translate(' + width / 2 + ',' + height / 2 + ')');

      g.selectAll('text')
        .data(drawn)
        .enter().append('text')
        .style('font-size', d => d.size + 'px')
        .style('font-family', '-apple-system, system-ui, sans-serif')
        .style('font-weight', d => d.weight || '400')
        .style('fill', d => PALETTE[d.ci % PALETTE.length])
        .style('cursor', 'default')
        .style('opacity', 0)
        .style('transition', 'opacity 0.2s')
        .attr('text-anchor', 'middle')
        .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')rotate(' + d.rotate + ')')
        .text(d => d.text)
        .transition()
        .delay((d, i) => i * 3)
        .duration(400)
        .style('opacity', 0.88);

      g.selectAll('text')
        .on('mouseover', function(event, d) {
          d3.select(this)
            .style('opacity', 1)
            .attr('transform', 'translate(' + d.x + ',' + d.y + ')rotate(' + d.rotate + ')scale(1.1)');
          const tip = document.getElementById('tooltip');
          tip.innerHTML = '<strong>' + esc(d.text) + '</strong> &mdash; ' + d.count + ' mentions';
          tip.style.display = 'block';
          tip.style.left = (event.clientX + 12) + 'px';
          tip.style.top = (event.clientY - 8) + 'px';
        })
        .on('mousemove', function(event) {
          const tip = document.getElementById('tooltip');
          tip.style.left = (event.clientX + 12) + 'px';
          tip.style.top = (event.clientY - 8) + 'px';
        })
        .on('mouseout', function(event, d) {
          d3.select(this)
            .style('opacity', 0.88)
            .attr('transform', 'translate(' + d.x + ',' + d.y + ')rotate(' + d.rotate + ')');
          document.getElementById('tooltip').style.display = 'none';
        });
    })
    .start();

  document.getElementById('stat-words').textContent = words.length;
}

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

// ─── Word count tracking for pulse highlights ───────────────────
const lastWordCounts = new Map();
let lastRelayoutTime = 0;
const RELAYOUT_INTERVAL = 60000;

function load(isInitial) {
  fetch('/graph/words/api/words?limit=' + wordCount)
    .then(r => r.json())
    .then(data => {
      wordData = data;
      renderCloud(data);
      // Initialize word count tracking
      if (isInitial) {
        for (const w of data) lastWordCounts.set(w.text, w.count);
      }
      lastRelayoutTime = Date.now();
    });
}

function pollWords() {
  fetch('/graph/words/api/words?limit=' + wordCount)
    .then(r => r.json())
    .then(data => {
      const changedWords = [];
      const newWords = [];

      for (const w of data) {
        const prev = lastWordCounts.get(w.text);
        if (prev == null) {
          newWords.push(w.text);
        } else if (w.count > prev) {
          changedWords.push(w.text);
        }
        lastWordCounts.set(w.text, w.count);
      }

      if (changedWords.length > 0 || newWords.length > 0) {
        // Show live indicator
        const live = document.getElementById('live');
        const total = changedWords.length + newWords.length;
        live.textContent = '+' + total + ' word' + (total !== 1 ? 's' : '') + ' changed';
        live.classList.add('show');
        setTimeout(() => live.classList.remove('show'), 2000);

        // Pulse existing changed words
        const allText = document.querySelectorAll('#cloud svg text');
        for (const el of allText) {
          const text = el.textContent;
          if (changedWords.includes(text)) {
            el.classList.remove('word-sparked');
            void el.offsetWidth; // force reflow
            el.classList.add('word-sparked');
          }
        }

        // Re-layout periodically or if new words appeared
        if (newWords.length > 0 && Date.now() - lastRelayoutTime > RELAYOUT_INTERVAL) {
          wordData = data;
          renderCloud(data);
          lastRelayoutTime = Date.now();
          // Apply spark to new words after re-layout
          setTimeout(() => {
            const allText2 = document.querySelectorAll('#cloud svg text');
            for (const el of allText2) {
              if (newWords.includes(el.textContent)) {
                el.classList.add('word-sparked');
              }
            }
          }, 500);
        }
      }
    })
    .catch(() => {});
}

document.getElementById('word-count').addEventListener('input', (e) => {
  wordCount = parseInt(e.target.value, 10);
  document.getElementById('word-count-val').textContent = wordCount;
});
document.getElementById('word-count').addEventListener('change', () => load(false));

document.getElementById('min-freq').addEventListener('change', () => load(false));

window.addEventListener('resize', () => {
  if (wordData.length > 0) renderCloud(wordData);
});

load(true);
setInterval(pollWords, 10000);
</script>
</body>
</html>`;

serve();
