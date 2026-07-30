<!-- Verified: 2026-07-23 -->

# Execution Plan: Incremental Report Aggregation

**Status:** Phase 1 complete; ingest-time rollups deferred
**Created:** 2026-07-18
**Goal:** Replace full-history JavaScript folds in the skill-intelligence and portfolio reports with ingest-time SQL aggregates, so report cost stops growing linearly with session history.

## Executive Summary

The July 2026 dashboard performance work (materialized report caches computed
in a subprocess, artifact persistence, payload capping, upload retention)
removed report computation from the request path. It did not change how the
reports are computed: `analyzeSkillIntelligence` still loads every session,
query, and observation row into JavaScript and folds over the whole corpus on
each refresh. On the dogfood database (~11k sessions, ~19k queries, ~84k
execution facts) one refresh costs ~5-6s of CPU and gigabytes of transient
allocation inside the report worker. That cost grows with history forever;
the subprocess only hides it.

Two reference systems point at the fix. Raindrop Workshop (the closest
architectural analog: local-first, bun + SQLite) computes every dashboard
aggregate in SQL — views with correlated subqueries, `SUM`/`COUNT`/`GROUP BY`
pushed to the engine — and never materializes raw history into JS. Latitude
(1000x scale, ClickHouse) rolls spans into per-trace and per-session summary
rows incrementally at insert time, so dashboard reads fold over rolled-up
aggregates, not raw events. Both patterns port to SQLite directly.

Target state: report refresh cost is proportional to _new_ data since the
last refresh, not to total history, and peak memory in the report worker
drops by an order of magnitude.

## Why This Exists

- `packages/skill-intelligence/src/analyze.ts` receives full materialized
  arrays (`sessions`, `observations`, `queries`) and computes classification,
  co-usage, evidence, and suggestion discovery in JS.
- `packages/runtime/skill-intelligence/index.ts` (`loadSkillIntelligence`)
  and `catalog-expansions.ts` assemble those arrays from whole-table queries
  (`querySessionTelemetry(db)` with no limit, etc.).
- The retention plan bounds upload plumbing, but session history itself is
  product data and should keep growing; the analytics must become sublinear
  in it instead.

## Non-Goals

- No change to thresholds or the shipped `SkillIntelligenceReport` contract.
  Raw project-signal and prompt evidence may be sampled or length-bounded
  before analysis so the implementation can enforce a fixed memory budget.
- No new storage engine. SQLite remains the local store
  (validated 2026-07-18 against Workshop/Latitude; see git history).
- No cloud-side changes.

## Design

### Phase 1 — Push pure aggregations into SQL (low risk, high yield)

Identify the folds in `analyze.ts` that are pure counts/sums/groupings and
replace their JS implementations with SQL, keeping the same intermediate
shapes so downstream logic is untouched:

- observation counts and triggered counts per skill id
- observed-query distinct counts per skill
- co-usage pair counts per session (`GROUP BY session_id, skill_id` with a
  self-join, replacing the nested Map loop)
- path usage counts (`pathCounts`)

**Implementation notes (2026-07-18):** Phase 1 keeps observation trust
filtering in JavaScript because the system-prefix and meta/internal-marker
predicates are JavaScript string semantics and must not be duplicated in SQL.
The report path instead column-trims session telemetry and streams the trusted,
deduplicated observation rows through one runtime-side pass that prepares the
per-skill and per-session evidence consumed by the pure analysis package;
co-usage remains a small derivation from the pre-grouped session skill ids.

Each replacement lands with a differential test: run old JS fold and new SQL
query against the same seeded fixture DB and assert identical outputs. The
existing indexes must be audited for the grouped/filtered columns
(`skill_usage`, `queries`, `session_telemetry`); add covering indexes via the
standard migration path where the query plan shows table scans.

Exit criteria: report worker peak RSS below 500MB on the dogfood DB;
`analyzeSkillIntelligence` no longer receives the full observations array.

### Phase 1b — hot-loop memoization (2026-07-18)

CPU profiling after Phase 1 showed that full-history count and co-usage folds
were not among the report worker's top hot spots at the current dogfood scale.
The dominant costs were repeated category-term normalization, repeated slot
regex evaluation across expansion profiles, and project-signal normalization.
Phase 1b precomputes padded category search tokens, normalizes each category
candidate text once per classification, and memoizes catalog candidate scores
for logically identical capability slots within one expansion invocation.
Project-signal normalization was verified to already run once per invocation,
outside the profile loop, so no additional hoist was necessary.

### Phase 1c — bounded report evidence and worker composition (2026-07-23)

A fresh dogfood profile showed that the remaining peak was not the count or
co-usage folds. The worker spent most of its CPU enumerating ancestor
directories, then materialized about 57MB of session query text and 60MB of
joined prompt text before creating several normalized copies. It also loaded
the portfolio, synthesis, library, and control-plane report modules even when
only Skill Intelligence was requested.

The completed bounded-read slice:

- ignores deleted historical workspaces and probes only the known registry
  placements instead of enumerating every ancestor directory;
- keeps all session timing, workspace, and error headers, but materializes
  query text only for the newest 500 sessions used by project signals;
- applies the same 500-session window to project-signal evidence;
- transfers at most 4,096 characters of prompt evidence per observation from
  SQLite while retaining compact full-query identities for deduplication and
  exact distinct counting where the complete query is available;
- interns duplicate installed-skill content and classifies each unique content
  version once while retaining the full installed package inventory; and
- dynamically imports only the module graph for the selected report.

On the 2026-07-23 dogfood database (12,734 session rows, 5,417 skill
invocations, 18,976 prompts), the identical worker command moved from 13.87s,
1,586MiB maximum RSS, and 1,200MiB peak physical footprint to 4.10s, 471MiB
maximum RSS, and 389MiB peak physical footprint. The resulting report retained
the full installed/classified inventory (243/244) and continued to produce 3
suggestions and 2 catalog expansions; the live analyzed-session count advanced
from 901 to 904 during verification. This satisfies the Phase 1 memory exit
criterion without introducing another storage engine or rollup tables.

### Phase 1d — dependency-scoped refresh and retention recovery (2026-07-23)

The report worker is now a hard isolation boundary: a worker failure retains
the last successful materialized artifact and is retried on the next refresh
tick instead of falling back to the long-lived dashboard daemon. Each report
uses table-specific append/update cursors, so upload-queue bookkeeping no
longer refreshes every heavyweight view. Cache versions are recorded after a
successful computation, preventing Skill Intelligence's own learned-snapshot
write from scheduling another report.

Dashboard reactivity now treats Skill Intelligence as a separate resource.
Healthy server-sent events replace the one-minute Library and Portfolio polls;
Skill Intelligence keeps a five-minute correctness poll because ordinary WAL
events intentionally omit that expensive report. Disconnected event streams
fall back to the original one-minute cadence.

Upload maintenance now recovers expired `sending` leases and prunes canonical
staging only behind a `staging_max_seq`-backed delivery watermark. Upgrades do
not trust the legacy `canonical` enqueue cursor: a separate
`staging_enqueued` cursor safely replays historical staging, allowing remote
deduplication to prove delivery before local retention removes data.

### Phase 2 — Ingest-time rollup tables (structural) — Deferred

Profiling shows the count and co-usage folds do not register among the top hot
spots at the current scale. The storage and consistency complexity of rollup
tables is therefore deferred until profiling shows those folds materially
contributing to report CPU or memory again.

Add per-skill and per-session aggregate tables maintained at write time by
the existing canonical writers (`normalization.ts` /
`writeSkillCheckToDb`), Latitude-style but as plain SQLite upserts:

- `skill_usage_rollup(skill_id, day, observed, triggered, invoked, distinct_queries_hll TEXT)`
  — daily grain; distinct-count kept exact per day and summed as an
  approximation across days, or recomputed exactly for the small set of
  skills where precision matters.
- `session_skill_rollup(session_id, skill_id, first_seen_at, last_seen_at, uses)`
  — feeds co-usage and evidence without scanning observations.

Rules learned from Latitude's materialized views apply: rollups are
insert-time only, so a one-time backfill migration seeds them from history
(`INSERT ... SELECT ... GROUP BY`), and the report reader must tolerate the
rollup lagging the raw tables by one write (reads take `MAX(rowid)` guards
or accept the same staleness the report cache already accepts).

Classification text analysis (`categoryForSkill` regex matching over skill
content and query text) stays in JS — it is not an aggregation — but Phase 1
means it receives per-skill pre-grouped rows.

Exit criteria: a refresh on a DB with N new sessions since the last refresh
touches O(N) raw rows; full-history scans remain only in the backfill
migration and a `--rebuild` escape hatch.

### Phase 3 — Retire the fold entry points — Deferred

Fold retirement is deferred with Phase 2: current profiles do not identify
the count or co-usage folds as top hot spots. Revisit this phase when measured
report cost demonstrates that full-history folds have become material.

Once rollups serve the report, delete the whole-table query paths
(`querySessionTelemetry` unbounded call sites in report assembly) and cap the
remaining raw-row reads (e.g. recent-session windows for suggestion
evidence, matching the 500-session window `relevantProfiles` already uses).

## Risks

- **Dual-maintenance drift:** rollups can silently diverge from raw tables.
  Mitigation: a `selftune doctor` check recomputes a sampled rollup slice
  from raw data and compares; CI runs the differential tests from Phase 1.
- **Write-path cost:** hooks now forward to the daemon, so rollup upserts
  add work to the daemon queue, not the agent turn; budget <1ms per event
  (single upsert per rollup table, measured in tests).
- **Backfill duration:** one-time `INSERT ... SELECT` over 84k facts is
  seconds; run it inside the existing migration gate.

## Sequencing and Ownership

Phase 1 is independently shippable and should go first (it also shrinks the
report worker memory that motivated the subprocess). Phases 2 and 3 are
deferred until profiling makes the full-history folds material. If Phase 2 is
reactivated, review the rollup schema against
`docs/design-docs/sqlite-first-migration.md` ownership rules before
implementation. That implementation is a good fit for Codex delegation once
the schema and differential-test fixtures are frozen; the schema freeze and
the doctor-check design need human review.

## References

- Workshop aggregation pattern: `runs_with_hints` view, `getRunOutline`
  (raindrop-ai/workshop `src/db/schema.ts`, `src/db.ts`).
- Latitude incremental rollups and TTL retention:
  `packages/platform/db-clickhouse/clickhouse/migrations/clustered/`
  (latitude-dev/latitude-llm), esp. materialized traces/sessions and
  plan-aware retention.
- Tech-debt tracker TD-015 (move `computeMonitoringSnapshot()` into a
  SQLite materializer) is subsumed by Phase 1 of this plan.
