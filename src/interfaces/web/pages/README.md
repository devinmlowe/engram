# Web Pages

HTML template generators for the four visualization modes. Each file exports a function returning a complete HTML document string with embedded JavaScript and CSS. Client-side code that more than one page needs lives in small modules that return a JS (or CSS) string for the page to interpolate.

## In Scope

- HTML document generation with D3.js / Three.js visualization code
- Client-side JavaScript for interactivity (zoom, pan, filter, search)
- Everforest Hard Dark theme and shared styling

## Out of Scope

- Server-side data queries (see [data/](../data/))
- API route handling (see [routes/](../routes/))

## Contains

- `graph.html.ts` — D3 force-directed Canvas graph (threshold slider, type filters, search, dream control, settings guide generated from the hint tables)
- `depth.html.ts` — Three.js 3D graph visualization
- `galaxy.html.ts` — Orbital mechanics visualization
- `words.html.ts` — D3 word cloud with frequency hover
- `theme.ts` — Everforest colour constants, `TYPE_COLORS`, `REL_COLORS`, `PALETTE`, `hexToRgb`
- `shared-css.ts` — Settings panel, view tabs, live indicator and growth-animation controls
- `shared-js.ts` — `esc`, `formatAge`, `linkId`; settings panel toggle
- `spark-colors.ts` — Type/relationship RGB tables and the energy-blend + spark-fade node colours (graph, depth, galaxy, terminal depth)
- `diff-polling.ts` — `startDiffPolling(prefix, onChanged)`: merges `api/diff` results into the page's nodes and links (graph, depth, galaxy)
- `growth-animation.ts` — `setupGrowthAnimation(show, restore)`: replays node arrival by `firstSeen` (graph, depth, galaxy)
- `relevance.ts` — `computeRelevanceScores` (depth, terminal depth)
- `three-helpers.ts` — Gradient link shader, camera fit, turntable rotation, spark colour refresh (depth, galaxy)

### Terminal-Optimized (`terminal/`)

Versions of the visualizations optimized for terminal browsers (carbonyl). These use SVG instead of Canvas/WebGL, pre-stabilized layouts, click-based interaction, and high-contrast monospace styling. Served at `/terminal/graph`, `/terminal/depth`, `/terminal/words`, `/terminal/communities`.

- `terminal/graph.html.ts` — SVG force-directed graph with click-to-inspect info panel
- `terminal/depth.html.ts` — 2D relevance depth view (Y-axis = relevance, color = connectivity energy)
- `terminal/words.html.ts` — Word-frequency treemap with toggleable frequency table
- `terminal/communities.html.ts` — Topic-cluster treemap coloured from `PALETTE`, shaded by coherence
- `terminal/treemap.ts` — `renderTreemap(container, items, opts)` shared by the two treemap pages
- `terminal/shared-css.ts` — High-contrast terminal CSS (monospace, solid colors, no blur)

## See Also

- [web/](../) — Parent web server module
- [routes/](../routes/) — Routes that serve these pages
