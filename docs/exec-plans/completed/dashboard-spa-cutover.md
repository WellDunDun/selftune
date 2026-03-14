# Execution Plan: Dashboard SPA Cutover

<!-- Verified: 2026-03-14 -->

**Status:** Completed  
**Completed:** 2026-03-14  
**Goal:** Retire the legacy embedded-HTML dashboard runtime and make the SPA + v2 dashboard server path the supported local experience.

---

## What Landed

- The React SPA became the supported local dashboard UI.
- `selftune dashboard` now starts the SPA-backed dashboard server directly.
- The legacy `dashboard/index.html` runtime was removed.
- Legacy v1 dashboard routes were removed from `cli/selftune/dashboard-server.ts`:
  - `/legacy/`
  - `/api/data`
  - `/api/events`
  - `/api/evaluations/:name`
- The shared dashboard payload contract was centralized in `cli/selftune/dashboard-contract.ts`.
- Dashboard docs and sandbox coverage were updated to the SPA/server model.

## Resulting Product Shape

The supported dashboard path is now:

```text
selftune dashboard
  -> dashboard server
    -> /api/v2/overview
    -> /api/v2/skills/:name
    -> SPA at /
```

Supporting routes that still remain on the server:

- `/badge/:name`
- `/report/:name`
- `/api/actions/*`

## Follow-Through That Is Still Separate

This cutover did not complete every dashboard-adjacent migration. Remaining follow-up belongs to other active plans:

- move more report/badge/status semantics onto the same v2 data model
- continue improving SPA latency and UX polish
- finish the release/install proof against the published package

## Verification

The cutover was validated with:

- focused dashboard server tests
- badge/report route tests
- sandbox dashboard HTTP smoke coverage

The only remaining sandbox failure at completion time was the unrelated pre-existing `hook: skill-eval` issue.
