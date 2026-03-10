# Web Data

Database query helpers that extract visualization-ready data from the engram database. These provide the data layer for web API routes.

## In Scope

- SQLite queries producing JSON-serializable data for API responses
- Data aggregation and filtering for visualization consumption

## Out of Scope

- HTTP routing (see [routes/](../routes/))
- HTML rendering (see [pages/](../pages/))

## Contains

- `graph-queries.ts` — Entity and relationship queries for graph visualizations
- `word-queries.ts` — Word frequency aggregation from episodic conversation data

## See Also

- [web/](../) — Parent web server module
- [routes/](../routes/) — API routes that consume these queries
