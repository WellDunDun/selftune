# Local Dashboard SPA — Handoff

## Architecture

React SPA built with Vite + TypeScript that consumes the **SQLite-backed v2 API endpoints** from the dashboard server. The server materializes JSONL logs into a local SQLite database (`~/.selftune/selftune.db`) and serves pre-aggregated query results.

### Data flow

```
JSONL logs → materializeIncremental() → SQLite → getOverviewPayload() / getSkillReportPayload() → /api/v2/* → SPA
```

## What is implemented

- **Two routes**:
  - `/` — Overview with KPIs, skill health grid (from `getSkillsList()`), evolution feed, unmatched queries
  - `/skills/:name` — Per-skill drilldown with usage stats, invocation records, evolution evidence, pending proposals
- **Data layer**: fetches from v2 endpoints backed by SQLite materialized queries
  - `GET /api/v2/overview` — combined `getOverviewPayload()` + `getSkillsList()`
  - `GET /api/v2/skills/:name` — `getSkillReportPayload()` + evolution audit + pending proposals
- **Live updates**: 15-second polling interval (replaced old SSE approach)
- **Loading/error/empty/not-found states** on every route
- **Design tokens**: matches existing dashboard CSS

## How to run

```bash
# Terminal 1: Start the dashboard server
selftune dashboard --port 7888

# Terminal 2: Start the SPA dev server (proxies /api to port 7888)
cd apps/local-dashboard
bun install
bunx vite
# → opens at http://localhost:5199
```

## What was rebased / changed

- **SPA types**: Rewritten to match `queries.ts` payload shapes (`OverviewResponse`, `SkillReportResponse`, `SkillSummary`, `EvidenceEntry`)
- **API layer**: Now calls `/api/v2/overview` and `/api/v2/skills/:name` instead of `/api/data` + `/api/evaluations/:name`
- **SSE removed**: Replaced with 15s polling (SQLite reads are cheap, SSE was complex)
- **Overview page**: Uses `SkillSummary[]` from `getSkillsList()` for skill cards (pre-aggregated pass rate, check count, sessions)
- **Skill report page**: Single fetch to v2 endpoint instead of parallel overview + evaluations fetch. Shows evidence entries, evolution audit history per skill
- **Hooks**: Simplified — `useOverview` polls, `useSkillReport` does single fetch with stale-request guard

## What now uses SQLite / materialized queries

- **Overview**: `getOverviewPayload(db)` for evolution, unmatched queries, pending proposals, counts; `getSkillsList(db)` for per-skill aggregated stats
- **Skill report**: `getSkillReportPayload(db, skillName)` for usage stats, recent invocations, evidence; direct SQL for evolution audit + pending proposals per skill
- **Server**: `materializeIncremental(db)` runs at startup and refreshes every 15s on v2 endpoint access

## What still depends on old dashboard code

- The old v1 endpoints (`/api/data`, `/api/events`, `/api/evaluations/:name`) still work and are used by the legacy `dashboard/index.html`
- Badge endpoints (`/badge/:name`) and report HTML endpoints (`/report/:name`) use the old `computeStatus` + JSONL reader path
- Action endpoints (`/api/actions/*`) are unchanged

## What remains before this can become default

1. **Serve built SPA from dashboard-server**: Route `/` to serve `apps/local-dashboard/dist/` (move old dashboard to `/legacy/`)
2. **Regression detection**: The SQLite layer doesn't compute regression detection yet — `deriveStatus()` currently only uses pass rate + check count. Add a `regression_detected` column to skill summaries when the monitoring snapshot computation moves to SQLite.
3. **Monitoring snapshot migration**: Move `computeMonitoringSnapshot()` logic into the SQLite materializer or a query helper (window sessions, false negative rate, baseline comparison)
4. **Actions integration**: Wire up watch/evolve/rollback buttons in the SPA to `/api/actions/*`
5. **Migrate badge/report endpoints**: Switch to SQLite-backed queries
6. **Production build**: Add `build:dashboard` script to root package.json
