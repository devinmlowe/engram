# Phase 4: Decompose graph-server.ts

**Master plan:** [MASTER-PLAN.md](./MASTER-PLAN.md)
**Status:** Not started
**Branch:** `phase-4/decompose-graph-server` (from `refactor/src-extraction`)

## Entry Criteria

- [x] Phases 2 and 3 complete and merged to integration branch
- [x] All 693 tests pass on `refactor/src-extraction`

## Objective

Break the 4,970-line `graph-server.ts` monolith into focused modules. Separate server-side logic (routes, DB queries, SSE, dream management) from client-side assets (HTML pages with inline JS/CSS). Route DB access through the DAL where possible.

After this phase, `graph-server.ts` no longer exists as a single file. Each route handler is under 300 lines. DB access goes through `_core/db/` or domain APIs.

## Current State (Post-Phases 1-3)

`src/interfaces/web/graph-server.ts` (4,970 lines) contains:

**Server-side code (lines 1-725):**
- Database queries: `getGraphData()`, `getStats()`, `computeOptimalThreshold()`, `getGraphDiff()`, `getDepthGraphData()`
- Dream management: `getDreamStatus()`, `startDream()`, dream process lifecycle
- Word frequency: `getWordFrequencies()` with stop words
- SSE: client tracking, broadcast
- HTTP router: 15+ routes dispatched via URL parsing
- Server lifecycle: listen, SIGINT handling

**Client-side pages (lines 726-4970):**
- Graph page (~1,100 lines): D3 Canvas force-directed graph, zoom, tooltips, settings, filters, growth animation, diff polling
- Depth/3D page (~1,000 lines): Three.js 3D visualization, turntable rotation, relevance scoring
- Galaxy page (~1,300 lines): Orbital mechanics, hub detection, satellite assignment, energy color system
- Words page (~450 lines): D3 word cloud
- Shared CSS/panel components (~200 lines)

## Tasks

### Task 4.1: Create web module directory structure

```
src/interfaces/web/
  server.ts           ← HTTP server + router (replaces graph-server.ts)
  routes/
    graph.ts          ← /graph/api/* handlers
    words.ts          ← /words/api/* handlers
    dream.ts          ← /graph/api/dream/* handlers
    sse.ts            ← SSE client management + broadcast
  data/
    graph-queries.ts  ← getGraphData, getGraphDiff, getDepthGraphData, computeOptimalThreshold, getStats
    word-queries.ts   ← getWordFrequencies, STOP_WORDS
  pages/
    graph.html.ts     ← graph page HTML+JS+CSS as template literal export
    depth.html.ts     ← 3D depth page
    galaxy.html.ts    ← galaxy page
    words.html.ts     ← words cloud page
    shared-css.ts     ← shared panel CSS
```

**Test:** Directory structure exists. No functional changes yet.

### Task 4.2: Extract data query modules

Create `src/interfaces/web/data/graph-queries.ts`:
- `getGraphData(db)` — entities + relationships + clusters
- `getGraphDiff(db, since)` — incremental graph changes
- `getDepthGraphData(db)` — 3D graph with community metadata
- `computeOptimalThreshold(db)` — dynamic mention threshold
- `getStats(db)` — entity/relationship/memory counts

Create `src/interfaces/web/data/word-queries.ts`:
- `STOP_WORDS` set
- `getWordFrequencies(db, limit)` — word frequency from exchanges

These functions should use DAL helpers from `_core/db/` where appropriate (simple SELECTs). Keep complex queries (JOINs, aggregations, COLLATE) as raw SQL with DAL connection access.

**Test:** Unit tests for query functions with seeded test data. All return correct shapes.

### Task 4.3: Extract SSE module

Create `src/interfaces/web/routes/sse.ts`:
- `sseClients` set management
- `addSseClient(res)` / `removeSseClient(res)`
- `broadcastUpdate(db)` — push graph data to all connected clients
- SSE response header setup

**Test:** SSE client tracking works correctly.

### Task 4.4: Extract dream management

Create `src/interfaces/web/routes/dream.ts`:
- `getDreamStatus(db)` — read dream state from DB + dream.log
- `startDream()` — spawn dream child process
- Dream process lifecycle management (dreamProcess, exit/error handlers)
- Route handlers for `/graph/api/dream/status` and `/graph/api/dream/start`

Use dream domain's public interface where possible. The current implementation spawns `npx tsx cli/index.ts dream --verbose` as a child process — update the path to `src/interfaces/cli/index.ts` (or better, import the dream daemon directly).

**Test:** Dream status returns correct shape. Dream start spawns process correctly.

### Task 4.5: Extract route handlers

Create `src/interfaces/web/routes/graph.ts`:
- Handlers for `/graph/api/graph`, `/graph/api/events`, `/graph/api/diff`, `/graph/api/threshold`
- Handlers for `/depth/api/graph`, `/galaxy/api/graph`
- Each handler is a function taking `(req, res, db)` and returning void

Create `src/interfaces/web/routes/words.ts`:
- Handler for `/words/api/words`
- Server-side cache logic (1-minute cache)

**Test:** Route handlers return correct content-type and status codes.

### Task 4.6: Extract HTML page templates

Create page template files that export the HTML string:

- `src/interfaces/web/pages/graph.html.ts` — export function `graphPage(): string`
- `src/interfaces/web/pages/depth.html.ts` — export function `depthPage(): string`
- `src/interfaces/web/pages/galaxy.html.ts` — export function `galaxyPage(): string`
- `src/interfaces/web/pages/words.html.ts` — export function `wordsPage(): string`
- `src/interfaces/web/pages/shared-css.ts` — export function `sharedPanelCss(): string`

Each page function returns the complete HTML document as a template literal. The inline JS/CSS stays as-is within the template (no separate bundling — keep it simple).

**Test:** Each page function returns a string containing expected markers (DOCTYPE, canvas/svg elements, etc.).

### Task 4.7: Create new server.ts router

Create `src/interfaces/web/server.ts`:
- Import route handlers from `routes/`
- Import page templates from `pages/`
- URL-based routing (same as current but delegating to handler modules)
- WAL file watcher for SSE triggers
- Server lifecycle (listen, SIGINT)
- Under 300 lines

**Test:** Server starts, serves pages, handles API routes.

### Task 4.8: Remove graph-server.ts

- Delete `src/interfaces/web/graph-server.ts`
- Update any references (launchd plists, scripts, package.json) to point to `server.ts`
- Update `launchd/com.engram.visualizer.plist` if it exists
- Update any scripts that reference the old file

**Test:** Full suite green. No references to `graph-server.ts` remain.

### Task 4.9: Final verification

- Run full test suite
- Verify no route handler exceeds 300 lines
- Verify all DB access goes through DAL or domain APIs
- Verify dream triggering path is updated
- Count total lines of largest file (target: under 300)

## Agent Assignment

| Task | Notes |
|------|-------|
| 4.1 | Directory creation — trivial |
| 4.2 | Data queries — extract + add DAL usage where appropriate |
| 4.3 | SSE module — small, self-contained |
| 4.4 | Dream management — needs path updates for new CLI location |
| 4.5 | Route handlers — moderate, many routes |
| 4.6 | HTML templates — largest task by lines moved, but mechanical |
| 4.7 | Router — the new entry point, imports everything else |
| 4.8 | Cleanup — remove old file, update references |
| 4.9 | Verification — static analysis + tests |

Tasks 4.1 first. Then 4.2-4.6 (extractions, can partially overlap). Then 4.7 (compose new server). Then 4.8-4.9 (cleanup).

## Test Strategy

- After each task: run `npx vitest run --dir tests` — all tests must pass
- New web-specific tests for query functions and route handlers
- Final check: no file exceeds 300 lines (excluding HTML template literals which are data, not logic)

## Exit Criteria

- [ ] All 693+ tests pass
- [ ] `graph-server.ts` no longer exists
- [ ] No route handler exceeds 300 lines of server-side logic
- [ ] All DB access goes through `_core/db/` or domain APIs
- [ ] Dream triggering uses updated CLI path or direct domain import
- [ ] HTML pages extracted to separate template files
- [ ] SSE, dream management, and data queries are separate modules

## Next Phase

This is the final phase. Upon exit criteria met: merge `phase-4/decompose-graph-server` → `refactor/src-extraction`. Then run final integration testing and merge `refactor/src-extraction` → `main`.
