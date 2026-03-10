# Web Routes

Express route handlers for web visualization API and page endpoints.

## In Scope

- API endpoints returning JSON data for visualization clients
- Page endpoints serving HTML visualization views
- SSE endpoint for real-time database change notifications
- Dream pipeline trigger and status endpoints

## Out of Scope

- Data queries (see [data/](../data/))
- HTML generation (see [pages/](../pages/))

## Contains

- `graph.ts` — Graph page and API routes (`/graph`, `/graph/api/graph`)
- `words.ts` — Word cloud page and API routes (`/words`, `/words/api/words`)
- `dream.ts` — Dream status and trigger endpoints (`/api/dream/status`, `/api/dream/start`)
- `sse.ts` — Server-Sent Events for real-time WAL-watching updates

## See Also

- [web/](../) — Parent web server module
- [data/](../data/) — Query helpers consumed by these routes
- [pages/](../pages/) — HTML templates served by page routes
