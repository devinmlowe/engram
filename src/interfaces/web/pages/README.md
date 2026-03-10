# Web Pages

HTML template generators for the four visualization modes. Each file exports a function returning a complete HTML document string with embedded JavaScript and CSS.

## In Scope

- HTML document generation with D3.js / Three.js visualization code
- Client-side JavaScript for interactivity (zoom, pan, filter, search)
- Catppuccin Mocha theme and shared styling

## Out of Scope

- Server-side data queries (see [data/](../data/))
- API route handling (see [routes/](../routes/))

## Contains

- `graph.html.ts` — D3 force-directed Canvas graph (threshold slider, type filters, search)
- `depth.html.ts` — Three.js 3D graph visualization
- `galaxy.html.ts` — Orbital mechanics visualization
- `words.html.ts` — D3 word cloud with frequency hover
- `shared-css.ts` — Catppuccin Mocha theme and shared style constants

## See Also

- [web/](../) — Parent web server module
- [routes/](../routes/) — Routes that serve these pages
