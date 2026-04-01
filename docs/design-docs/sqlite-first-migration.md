<!-- Verified: 2026-04-01 -->

# SQLite-First Data Architecture

## Status

All three phases are complete.

- Phase 1 (dual-write): Shipped. Hooks wrote to both SQLite and JSONL.
- Phase 2 (cut over reads): Shipped. Dashboard reads SQLite, SSE invalidation uses WAL watcher.
- Phase 3 (drop JSONL writes): Complete. JSONL writes removed from hooks, ingestors, and normalization. SQLite is the sole write target. Existing JSONL files are retained on disk but only cover pre-cutover history. Post-cutover recovery requires `selftune export` snapshots or SQLite backups; the materializer alone cannot reconstruct post-cutover state from passive JSONL retention.

## Problem

JSONL-as-source-of-truth caused:

- **9.5s dashboard load times** — materializer re-reading 370MB of JSONL on every request cycle
- **7-file change propagation** on schema changes (JSONL write, schema def, materializer, types, dashboard contract, route handler, tests)
- **Dual data paths** (JSONL tables vs SQLite tables) causing wrong-table bugs when queries hit stale materialized data
- **Stale dashboard data** — 15–30s TTL caches layered on top of the materializer masked the real latency

## Solution

3-phase incremental migration that inverts the data architecture from JSONL-first to SQLite-first.

**Phase 1: Dual-Write** — Hooks INSERT into SQLite alongside JSONL appends via `localdb/direct-write.ts`. Zero risk: additive only, fully reversible.

**Phase 2: Cut Over Reads** (Shipped) — Dashboard reads SQLite directly. WAL-based SSE invalidation is live — `fs.watchFile()` monitors the SQLite WAL file for changes and triggers SSE broadcasts. Legacy/export JSONL backfill now lives behind the explicit `selftune recover` command rather than dashboard startup side effects.

**Phase 3: Drop JSONL Writes** (Complete) — Hooks no longer append to JSONL files. SQLite is the sole write target. JSONL writes were removed from all hooks (`hooks/*.ts`), platform ingestors (`ingestors/*.ts`), and the normalization pipeline. Existing JSONL files remain on disk but only contain pre-cutover history. For post-cutover disaster recovery, use `selftune export` to snapshot SQLite to JSONL, or back up the SQLite database directly. The materializer can still rebuild from JSONL but only covers data written before Phase 3.

## Architecture

Data flow (before):

```
Hook → JSONL append → [15s wait] → Materializer reads JSONL → SQLite → Dashboard
```

Data flow (after Phase 2 — shipped):

```
Hook → SQLite INSERT (via direct-write.ts) → WAL watcher → SSE broadcast → Dashboard
```

## Design Decisions

**DB Singleton (`localdb/db.ts`):** `getDb()` returns a shared connection. Avoids ~0.5ms open/close overhead per write. `_setTestDb()` allows test injection with `:memory:` databases.

**Prepared Statement Cache (`localdb/direct-write.ts`):** `WeakMap<Database, Map<string, Statement>>` caches parsed SQL per DB instance. ~10x faster for repeated inserts (hooks, batch ingestors).

**Fail-Open Writes:** All `direct-write.ts` functions catch errors internally. Hooks must never block the host agent — a failed SQLite write logs a warning and continues.

**JSONL Fallback for Tests:** Functions like `readAuditTrail()` fall back to JSONL when a non-default path is provided, preserving test isolation without requiring `_setTestDb()` everywhere.

**Two New Tables:** `queries` and `improvement_signals` were previously JSONL-only. Now first-class SQLite tables with dedup indexes.

**Route Extraction:** `dashboard-server.ts` split from 1205 → 549 lines. 7 route handlers extracted to `cli/selftune/routes/`.

## Files Created

| File                                   | Purpose                                      |
| -------------------------------------- | -------------------------------------------- |
| `cli/selftune/localdb/direct-write.ts` | Fail-open insert functions for all 11 tables |
| `cli/selftune/export.ts`               | SQLite → JSONL export command                |
| `cli/selftune/routes/*.ts`             | 7 extracted route handlers + index           |

## Files Modified

78 files changed, 2033 insertions, 1533 deletions. Key areas:

| Area                  | Files                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| Hooks                 | All hook handlers (`hooks/*.ts`) — dual-write path                         |
| Ingestors             | All platform adapters — dual-write path                                    |
| Evolution             | `evolution/*.ts` — read from SQLite, write via direct-write                |
| Orchestrate + Grading | `orchestrate.ts`, `grading/*.ts` — SQLite reads                            |
| Dashboard             | `dashboard-server.ts`, SQLite-backed routes, transitional SSE invalidation |
| CI                    | Workflow updated for new test structure                                    |

## Impact

| Metric                          | Before        | After                      |
| ------------------------------- | ------------- | -------------------------- |
| Dashboard load (first call)     | 9.5s          | 86ms                       |
| Dashboard load (subsequent)     | ~2s (TTL hit) | 15ms                       |
| Data latency (hook → dashboard) | 15–30s        | <1s (WAL-only SSE shipped) |
| Schema change propagation       | 7 files       | 4 files                    |
| Test delta                      | baseline      | +2 passing, -2 failures    |

## Limitations

- Historical data prior to Phase 1 requires an explicit `selftune recover` backfill
- `selftune export --since DATE` is supported for date-range filtering; per-skill filtering is not yet implemented
- JSONL files remain on disk for disaster recovery; the materializer can rebuild SQLite from them if needed

## Related

- [Live Dashboard SSE](live-dashboard-sse.md) — SSE implementation that consumes the SQLite WAL watcher
- [System Overview](system-overview.md) — Overall system architecture
