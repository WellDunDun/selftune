# Execution Plan: Local SQLite Materialization and App Data Layer

<!-- Verified: 2026-03-12 -->

**Status:** Active  
**Created:** 2026-03-12  
**Goal:** Use SQLite as a local indexed/materialized view layer on top of selftune’s raw JSONL source-of-truth logs so the local app can be fast, credible, and simple to reason about.

---

## Executive Summary

selftune’s raw JSONL logs remain the right source of truth for:

- telemetry capture
- transcript/source replay
- repair overlays
- append-only local durability

They are not the right structure for serving a good local product experience directly.

SQLite via `bun:sqlite` is the right local materialization layer because it gives us:

- fast indexed reads
- a simple single-file local store
- WAL-backed write safety
- zero extra network services
- a much cleaner foundation for overview/report queries

The architecture is now:

- **JSONL = truth**
- **SQLite = local indexed/materialized view**
- **SPA = local user experience**

---

## Why SQLite Is Now Justified

The old dashboard path showed the limits of raw-log-first serving:

- repeated large file scans and joins
- poor cold-start performance
- heavy live payloads
- fragile drilldown UX

SQLite solves the UX/product problem without replacing the telemetry model.

This is not a move to “database-first telemetry.” It is a local query/materialization layer on top of append-only source logs.

---

## What Has Already Landed

`#42` introduced the first SQLite local materialization layer.

That means the work now is not “decide whether to use SQLite.”  
The work now is:

1. stabilize the local DB schema and materialization flow
2. make overview/report queries first-class
3. move the local app to those queries
4. retire the old heavy dashboard path as the primary UX

---

## Data Model Role

SQLite should hold the structured local data needed for:

- overview page
- per-skill report page
- evolution evidence and version history
- summary/report payloads consumed by the local app

Likely source domains:

- sessions
- prompts
- skill invocations
- execution facts
- evidence
- optional materialized aggregates for overview/report

The exact schema can evolve, but its role should stay narrow:

- indexed cache/materialized view
- local query surface
- not the authority for telemetry capture

---

## Architectural Rules

### 1. JSONL remains authoritative

If a conflict exists between raw logs and SQLite materialization, the raw logs win.

### 2. Materialization must be rebuildable

It should always be possible to rebuild the local DB from source-truth logs.

### 3. Local app queries should be explicit

Do not let the app depend on giant generic payloads. Prefer query helpers and routes that match the UX:

- `OverviewPayload`
- `SkillReportPayload`

### 4. SQLite should stay local-only for now

Do not make the local DB the cloud contract. Cloud stays based on canonical telemetry + DB projections.

---

## Immediate Work

### 1. Stabilize overview/report query helpers

The local data layer should explicitly support:

- overview KPI/status/skill-card payload
- single-skill report payload

### 2. Move the SPA onto SQLite-backed data

The React local app should stop depending primarily on the old dashboard server’s heavy data path.

### 3. Keep the old dashboard path only as compatibility

Do not optimize it indefinitely. Keep it as fallback until the new path is trustworthy.

### 4. Keep source-truth sync first

Any materialization flow must still start from fresh source-truth sync/repair data.

---

## Open Questions

### How incremental should local materialization be?

Short term:

- correctness and simplicity matter more than perfect incrementalism

Later:

- add incremental rebuilds/checkpoints where safe and justified

### How much of the old dashboard server should remain?

Short term:

- enough to support the new app and compatibility mode

Long term:

- the new local app should be the default experience

---

## What This Enables

If this path is completed, selftune gains:

- fast local overview loads
- fast skill drilldowns
- simpler local UX architecture
- cleaner alignment between local and cloud payload semantics
- a better demo path on real machine data

That is why this work is now core to shipping, not optional polish.
