# Web Routes

The one route module that carries process state. Plain JSON routes and pages are tables in [`../server.ts`](../server.ts).

## In Scope

- Dream pipeline trigger (detached `engram dream` child process) and status (dream_runs table + the daemon's `dream.log` tail)

## Out of Scope

- Data queries (see [data/](../data/))
- HTML generation (see [pages/](../pages/))
- Routing, health and auth (see [`../server.ts`](../server.ts) and [`../auth-gate.ts`](../auth-gate.ts))

## Contains

- `dream.ts` — `getDreamStatus` (`/graph/api/dream/status`), `startDream` (`POST /graph/api/dream/start`), `resolveEngramCli` / `dreamSpawnCommand` (how the CLI is spawned)

## See Also

- [web/](../) — Parent web server module
- [data/](../data/) — Query helpers consumed by these routes
- [pages/](../pages/) — HTML templates served by page routes
