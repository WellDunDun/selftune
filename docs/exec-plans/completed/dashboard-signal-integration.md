# Execution Plan: Dashboard Signal Integration

**Status:** Planned
**Created:** 2026-03-15
**Goal:** Surface improvement signal data throughout the dashboard so operators can see what triggered evolution, which signals are pending, and how signal-reactive orchestration affected skill health.

---

## Executive Summary

The real-time signal detection system (improvement_signals.jsonl) captures corrections ("why didn't you use X?"), explicit requests ("please use the commit skill"), and manual invocations. The orchestrator reads these signals and boosts priority for affected skills. But the dashboard has zero visibility into this data — operators can't see pending signals, signal-driven evolutions, or consumed signal history.

This plan adds signal data to the full dashboard pipeline: schema → materialization → queries → contract → API → UI.

---

## Current State

- `improvement_signals.jsonl` written by prompt-log hook, consumed by orchestrate
- `orchestrate_runs.jsonl` persists run reports but doesn't include signal metadata
- Dashboard shows orchestrate runs but not signal context (why a skill was prioritized)
- No SQLite table for signals
- No API endpoint for signal data
- No UI components reference signals

## Target State

- Dashboard overview shows pending signal count and recent signal activity
- Per-skill report shows signal history (which corrections led to which evolutions)
- Orchestrate runs panel shows signal boost per skill action
- Signal data materialized into SQLite for fast queries

---

## Implementation

### Phase 1: Backend (schema + materialization + contract)

**Files:**

| File                                  | Change                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `cli/selftune/localdb/schema.ts`      | Add `improvement_signals` table                                                            |
| `cli/selftune/localdb/materialize.ts` | Read `SIGNAL_LOG`, insert into signals table                                               |
| `cli/selftune/localdb/queries.ts`     | Add signal count/history queries                                                           |
| `cli/selftune/dashboard-contract.ts`  | Add signal fields to `OverviewPayload`, `SkillReportResponse`, `OrchestrateRunSkillAction` |
| `cli/selftune/dashboard-server.ts`    | Query and expose signal data in existing endpoints                                         |

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS improvement_signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  query           TEXT,
  signal_type     TEXT NOT NULL,
  mentioned_skill TEXT,
  consumed        INTEGER DEFAULT 0,
  consumed_at     TEXT,
  consumed_by_run TEXT
);
```

**Contract additions:**

```typescript
// OverviewPayload
pending_signals?: number;

// SkillSummary
pending_signal_count?: number;

// OrchestrateRunSkillAction
signal_count?: number;
signal_boost?: number;
```

### Phase 2: Orchestrate run enrichment

**File:** `cli/selftune/orchestrate.ts`

Add to `OrchestrateRunSkillAction`:

- `signal_count` — number of signals that boosted this skill
- `signal_boost` — total priority boost from signals

These are already computed during candidate selection but not persisted.

### Phase 3: Frontend

**Files:**

| File                                                           | Change                          |
| -------------------------------------------------------------- | ------------------------------- |
| `apps/local-dashboard/src/types.ts`                            | Import new signal fields        |
| `apps/local-dashboard/src/pages/Overview.tsx`                  | Show pending signal count badge |
| `apps/local-dashboard/src/pages/SkillReport.tsx`               | Show signal history timeline    |
| `apps/local-dashboard/src/components/OrchestrateRunsPanel.tsx` | Show signal boost per skill     |

---

## Workstreams (3 parallel agents)

**Agent A:** Schema + materialization + queries (backend data layer)
**Agent B:** Contract + server endpoints (API layer)
**Agent C:** Frontend components (UI layer, depends on A+B)

---

## Verification

1. `bun run lint` passes
2. `bun test` passes (add tests for signal queries)
3. Dashboard overview shows pending signal count
4. Per-skill report shows signal history
5. Orchestrate runs show signal boost metadata
6. Materialization handles empty/missing signal log gracefully

---

## Dependencies

- Requires: signal detection system (shipped in `57dc28e`)
- Blocked by: nothing
- Blocks: nothing (additive feature)

## Estimated Effort

- Phase 1 (backend): 2 hours
- Phase 2 (enrichment): 30 minutes
- Phase 3 (frontend): 2 hours
- Total: ~4.5 hours with parallel agents
