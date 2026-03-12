# Local Dashboard SPA — Handoff

## What is implemented

- **React SPA** at `apps/local-dashboard/` with Vite + TypeScript
- **Two routes**:
  - `/` — Overview with KPIs, skill health grid, evolution feed, unmatched queries
  - `/skills/:name` — Per-skill drilldown with pass rate, invocation breakdown, evaluation records, evolution history
- **Data layer**: fetches from existing `/api/data` and `/api/evaluations/:skillName` endpoints
- **Live updates**: SSE connection for real-time data after initial load
- **Loading/error/empty states**: visible spinner, retry button, empty data messages on every route
- **Design tokens**: matches the existing dashboard's CSS variables exactly
- **No external dependencies** beyond React, React Router, and Vite

## How to run

```bash
# Terminal 1: Start the existing dashboard server
selftune dashboard --port 7888

# Terminal 2: Start the SPA dev server (proxies /api to port 7888)
cd apps/local-dashboard
bun install
bunx vite
# → opens at http://localhost:5199
```

## What still depends on old dashboard code

- The API layer (`/api/data`, `/api/events`, `/api/evaluations/:skillName`) is served by the existing `dashboard-server.ts` — this SPA is a frontend-only replacement
- The Vite dev server proxies all `/api/*` calls to the old server at port 7888
- Badge endpoints (`/badge/:name`) and report HTML endpoints (`/report/:name`) are not reimplemented (they're standalone and still work via the old server)

## What remains to make it default

1. **Serve built SPA from dashboard-server**: Add a route in `dashboard-server.ts` that serves `apps/local-dashboard/dist/` for the new SPA path (e.g., `/v2/` or make it the new `/`)
2. **Add to workspace package.json**: Add `apps/*` to the workspace config if you want integrated builds
3. **Actions integration**: The watch/evolve/rollback action buttons from the old dashboard are not yet wired up in the SPA — add fetch calls to `/api/actions/*`
4. **SQLite materializer**: When the chiang-mai workspace delivers the SQLite layer, replace `fetchOverview()` with a query against the materialized DB for faster loads
5. **Production build script**: Add a `build:dashboard` script to root package.json
