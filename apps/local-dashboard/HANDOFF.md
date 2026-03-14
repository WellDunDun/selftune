# Local Dashboard SPA — Handoff

## Architecture

React SPA built with Vite + TypeScript that consumes the **SQLite-backed v2 API endpoints** from the dashboard server. The server materializes JSONL logs into a local SQLite database (`~/.selftune/selftune.db`) and serves pre-aggregated query results.

### Data flow

```text
JSONL logs → materializeIncremental() → SQLite → getOverviewPayload() / getSkillReportPayload() → /api/v2/* → SPA
```

## What is implemented

- **Two routes**:
  - `/` — Overview with KPI section cards (with info tooltips), skill health grid with status filters (healthy/warning/critical/unknown), evolution feed (ActivityTimeline), unmatched queries, onboarding banner (dismissible, localStorage-persisted)
  - `/skills/:name` — Per-skill drilldown with usage stats (with info tooltips), invocation records, EvidenceViewer (collapsible evidence entries with markdown rendering, context banner), EvolutionTimeline (vertical timeline with pass-rate deltas, lifecycle legend), pending proposals, tab descriptions via hover tooltips
- **UX helpers**: `InfoTip` component for glossary tooltips on all metrics, lifecycle legend in evolution timeline, evidence context banner, onboarding flow for first-time users
- **Data layer**: TanStack Query (`@tanstack/react-query`) with smart caching, fetching from v2 endpoints backed by SQLite materialized queries
  - `GET /api/v2/overview` — combined `getOverviewPayload()` + `getSkillsList()`
  - `GET /api/v2/skills/:name` — `getSkillReportPayload()` + evolution audit + pending proposals
- **Live updates**: 15-second polling interval via TanStack Query `refetchInterval` (replaced old SSE approach)
- **Caching**: `staleTime` of 10s (overview) / 30s (skill report) for instant back-navigation; `gcTime` of 5 minutes; automatic background refetch on window focus
- **Loading/error/empty/not-found states** on every route
- **UI framework**: shadcn/ui components with dark/light theme toggle, TanStack Table for data grids
- **Design**: selftune branding, collapsible sidebar, Tailwind v4

## How to run

```bash
# From repo root
bun run dev
# → if 7888 is free, starts dashboard server on 7888 and SPA dev server on http://localhost:5199
# → if 7888 is already in use, reuses that dashboard server and starts only the SPA dev server

# Or run manually:
# Terminal 1: Start the dashboard server
selftune dashboard --port 7888 --no-open

# Terminal 2: Start the SPA dev server (proxies /api to port 7888)
cd apps/local-dashboard
bun install
bunx vite
# → opens at http://localhost:5199
```

## What was rebased / changed

- **SPA types**: Rewritten to match `queries.ts` payload shapes (`OverviewResponse`, `SkillReportResponse`, `SkillSummary`, `EvidenceEntry`)
- **API layer**: Calls `/api/v2/overview` and `/api/v2/skills/:name`
- **SSE removed**: Replaced with 15s polling (SQLite reads are cheap, SSE was complex)
- **Overview page**: Uses `SkillSummary[]` from `getSkillsList()` for skill cards (pre-aggregated pass rate, check count, sessions)
- **Skill report page**: Single fetch to v2 endpoint instead of parallel overview + evaluations fetch. Shows evidence entries, evolution audit history per skill
- **Hooks**: Migrated to TanStack Query — `useOverview` uses `useQuery` with `refetchInterval`, `useSkillReport` uses `useQuery` with smart retry (skips retry on 404). Manual polling, request deduplication, and stale-request guards replaced by TanStack Query built-ins.

## Query optimizations

- **Pending proposals**: Replaced `NOT IN` subquery + JS `Set` dedup with `LEFT JOIN + IS NULL + GROUP BY` in both `queries.ts` and `dashboard-server.ts`
- **Evidence query bounded**: Added `LIMIT 200` to `getSkillReportPayload()` evidence query (was unbounded)
- **Indexes**: 16 indexes defined in `schema.ts` covering all frequent filter/join columns (`skill_name`, `session_id`, `proposal_id`, `timestamp`, `query+triggered`)

## What now uses SQLite / materialized queries

- **Overview**: `getOverviewPayload(db)` for evolution, unmatched queries, pending proposals, counts; `getSkillsList(db)` for per-skill aggregated stats
- **Skill report**: `getSkillReportPayload(db, skillName)` for usage stats, recent invocations, evidence; direct SQL for evolution audit + pending proposals per skill
- **Server**: `materializeIncremental(db)` runs at startup and refreshes every 15s on v2 endpoint access

## What still depends on old dashboard code

- Badge endpoints (`/badge/:name`) and report HTML endpoints (`/report/:name`) still use the status/evidence JSONL path rather than SQLite-backed view models
- Action endpoints (`/api/actions/*`) are unchanged

## What remains before this can become default

1. ~~**Serve built SPA from dashboard-server**~~: Done — `/` serves the SPA
2. ~~**Production build**~~: Done — `bun run build:dashboard` in root package.json
3. **Regression detection**: The SQLite layer doesn't compute regression detection yet — `deriveStatus()` currently only uses pass rate + check count. Add a `regression_detected` column to skill summaries when the monitoring snapshot computation moves to SQLite.
4. **Monitoring snapshot migration**: Move `computeMonitoringSnapshot()` logic into the SQLite materializer or a query helper (window sessions, false negative rate, baseline comparison)
5. **Actions integration**: Wire up watch/evolve/rollback buttons in the SPA to `/api/actions/*`
6. **Migrate badge/report endpoints**: Switch to SQLite-backed queries
