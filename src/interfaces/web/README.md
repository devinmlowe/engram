# Web

HTTP server for interactive knowledge graph visualization and dream pipeline control. Serves at `localhost:3001` with real-time updates via Server-Sent Events.

## In Scope

- Express HTTP server with static and API routes
- Four visualization modes (force graph, 3D depth, galaxy, word cloud)
- Real-time SSE updates watching SQLite WAL changes
- Dream pipeline triggering and status tracking

## Out of Scope

- Core search and memory operations (see [interfaces/shared/](../shared/))
- Graph analysis logic (see [graph/](../../graph/))
- Database schema (see [_core/db/](../../_core/db/))

## Contains

- `server.ts` — Express server setup, route mounting, SSE initialization
- `data/` — Database query helpers for visualization data
  - `graph-queries.ts` — Entity/relationship graph data queries
  - `word-queries.ts` — Word frequency aggregation from episodic data
- `pages/` — HTML template generators (TypeScript string templates)
  - `graph.html.ts` — D3 force-directed Canvas graph
  - `depth.html.ts` — Three.js 3D graph visualization
  - `galaxy.html.ts` — Orbital mechanics visualization
  - `words.html.ts` — D3 word cloud
  - `shared-css.ts` — Catppuccin Mocha theme and shared styles
- `routes/` — Express route handlers
  - `graph.ts` — Graph API and page routes
  - `words.ts` — Word cloud API and page routes
  - `dream.ts` — Dream pipeline status and trigger endpoints
  - `sse.ts` — Server-Sent Events for real-time updates

## See Also

- [interfaces/](../) — Parent interfaces module
- [launchd/com.engram.visualizer.plist](../../../launchd/com.engram.visualizer.plist) — Keep-alive service
- [scripts/install-visualizer.sh](../../../scripts/install-visualizer.sh) — Service installation
