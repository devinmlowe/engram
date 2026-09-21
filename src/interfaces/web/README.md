# Web

HTTP server for interactive knowledge graph visualization and dream pipeline control. Serves at `localhost:3001` (`PORT`); every page polls its own `api/diff` route for live changes.

## In Scope

- Node `http` server: a map of JSON routes, a map of pre-rendered pages, `/api/health` and `POST /graph/api/dream/start`
- Four visualization modes (force graph, 3D depth, galaxy, word cloud) plus terminal-optimized views
- WAL watcher that resets the per-process caches (word frequencies, auto-threshold) when the database changes
- Dream pipeline triggering and status tracking

## Out of Scope

- Core search and memory operations (see [interfaces/shared/](../shared/))
- Graph analysis logic (see [graph/](../../graph/))
- Database schema (see [_core/db/](../../_core/db/))

## Contains

- `server.ts` — Configuration (`PORT`, `ENGRAM_BIND`/`HOST`, `ENGRAM_WEB_TOKEN`), route tables, WAL watcher
- `auth-gate.ts` — Bearer / cookie / `?token=` gate; `/api/health` stays open
- `data/` — Database query helpers for visualization data
  - `graph-queries.ts` — Entity/relationship graph data, diff since a timestamp, auto-threshold, communities
  - `word-queries.ts` — Word frequency aggregation from episodic data
- `pages/` — HTML template generators (TypeScript string templates)
  - `graph.html.ts` — D3 force-directed Canvas graph
  - `depth.html.ts` — Three.js 3D graph visualization
  - `galaxy.html.ts` — Orbital mechanics visualization
  - `words.html.ts` — D3 word cloud
  - `terminal/` — SVG views for carbonyl and other terminal browsers
  - `shared-css.ts`, `theme.ts` — Everforest theme and shared styles
  - `shared-js.ts`, `spark-colors.ts`, `diff-polling.ts`, `growth-animation.ts`, `relevance.ts`, `three-helpers.ts`, `terminal/treemap.ts` — client-side JS shared by several pages, returned as strings the templates interpolate
- `routes/` — The one handler with process state
  - `dream.ts` — Dream status (tails the daemon's `dream.log`) and the detached `engram dream` spawn

## Routes

| Path | Body |
|---|---|
| `/`, `/graph`, `/graph/depth`, `/graph/galaxy`, `/graph/words`, `/terminal[/graph]`, `/terminal/depth`, `/terminal/words`, `/terminal/communities` | Pre-rendered HTML (trailing slash accepted; `/depth` and `/words` redirect) |
| `/api/graph`, `/graph/api/graph`, `/graph/depth/api/graph`, `/graph/galaxy/api/graph` | `{ nodes, links }` — every view gets the same node shape |
| `/api/threshold`, `/graph/api/threshold`, `/graph/depth/api/threshold`, `/graph/galaxy/api/threshold` | `{ value, nodes, edges, edgePct }` |
| `/graph/api/diff`, `/graph/depth/api/diff`, `/graph/galaxy/api/diff` (`?since=<unix>`) | `{ timestamp, newNodes, updatedNodes, newLinks, updatedLinks }` |
| `/graph/api/dream/status`, `POST /graph/api/dream/start` | Dream state; `409` when a dream is already running |
| `/graph/words/api/words?limit=N` | `[{ text, count }]` |
| `/api/communities` | Latest-generation topic clusters |
| `/api/health` | `{ status, uptime, nodes, edges, communities }`; `503` when the DB cannot be read |

## Service lifecycle

The visualizer itself is a portable foreground Node process. The macOS launcher is [`scripts/install-visualizer.sh`](../../../scripts/install-visualizer.sh); Windows uses the built-in per-user Task Scheduler adapter [`scripts/install-visualizer.ps1`](../../../scripts/install-visualizer.ps1), which runs [`scripts/run-visualizer.ps1`](../../../scripts/run-visualizer.ps1). Both paths keep the default bind at `127.0.0.1`, use `/api/health` for liveness, and write logs under the engram data directory.

## See Also

- [interfaces/](../) — Parent interfaces module
- [launchd/com.engram.visualizer.plist](../../../launchd/com.engram.visualizer.plist) — Keep-alive service
- [scripts/install-visualizer.sh](../../../scripts/install-visualizer.sh) — Service installation
