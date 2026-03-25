# Execution Plan: Dashboard Data Integrity Recovery

<!-- Verified: 2026-03-18 -->

**Status:** In Progress  
**Created:** 2026-03-18  
**Goal:** Eliminate mixed-freshness dashboard behavior, prevent rebuild-driven data loss, isolate tests from real operator stores, and make it obvious which codebase and datastore a running dashboard is actually using.

## Status Update — 2026-03-18

This recovery plan has partially executed.

**Landed already:**

- runtime identity now exposes repo-root `workspace_root`, git SHA, DB/log/config paths, watcher mode, and process mode
- the dashboard UI now shows a runtime footer
- the dashboard footer and Status page now warn explicitly when live invalidation is still in legacy JSONL watcher mode
- the dev probe uses `localhost` again and no longer rewrites `bun.lock`
- the app-local dashboard `dev` flow now waits for backend health before starting Vite, reducing startup proxy noise
- env-overridable storage roots now cover config/log/Claude/OpenClaw paths
- rebuild preflight now blocks lossy rebuilds and reports SQLite-only row counts
- doctor now includes an integrity warning about the current JSONL-backed dashboard freshness contract

**Still open from this plan:**

- backup symmetry for `evolution_audit`, `evolution_evidence`, and `orchestrate_runs`
- WAL-driven SSE freshness instead of JSONL watcher invalidation
- clearer overview timeline semantics
- doctor/integrity diagnostics beyond the current trust-floor slice

This plan should now be treated as a partially completed recovery plan, not as untouched future work.

---

## Executive Summary

selftune is currently in an inconsistent hybrid state:

- some streams still dual-write to SQLite + JSONL
- some streams write only to SQLite
- full rebuild still deletes tables and repopulates from JSONL
- the dashboard SSE layer still watches JSONL files, not the SQLite WAL
- tests and proof harnesses can touch the real `~/.selftune` / `~/.claude` stores
- runtime identity is too opaque, so `selftune dashboard`, `bun run dev`, and a globally linked `selftune` binary can look like “the same dashboard” while actually coming from different processes or workspaces

That combination produces exactly the class of failures we just saw:

- fresh telemetry with stale evolution activity
- recent rows visible in one server and not another
- rebuilds that can silently discard SQLite-only rows
- test/proof activity polluting the real local store

This plan fixes the safety issues first, then closes the architecture/documentation gap.

---

## Current Failure Modes

### 1. Rebuild is not lossless

- `cli/selftune/localdb/materialize.ts` deletes `evolution_audit`, `evolution_evidence`, and `orchestrate_runs` during full rebuild
- current `cli/selftune/evolution/audit.ts`, `cli/selftune/evolution/evidence.ts`, and `cli/selftune/orchestrate.ts` write to SQLite directly
- rebuild still rehydrates those tables from `~/.claude/*.jsonl`

Result:

- if SQLite contains newer rows than JSONL, rebuild can discard real data

### 2. Dashboard freshness is split across two mental models

- `cli/selftune/dashboard-server.ts` materializes once at startup
- `refreshV2Data()` and `refreshV2DataImmediate()` are no-ops
- SSE invalidation still watches `TELEMETRY_LOG`, `QUERY_LOG`, and `EVOLUTION_AUDIT_LOG`, not the SQLite WAL
- docs in `docs/design-docs/live-dashboard-sse.md` and `docs/design-docs/sqlite-first-migration.md` describe a more complete SQLite/WAL model than the current runtime actually implements

Result:

- the dashboard feels “real-time” for some flows but still depends on legacy file activity for invalidation
- operator expectations do not match the actual code path

### 3. The homepage activity panel is narrower than it looks

- `cli/selftune/localdb/queries.ts` builds overview timeline data from `evolution_audit`
- the right-rail activity UI in `packages/ui/src/components/ActivityTimeline.tsx` renders that audit-backed data
- recent `evolution_evidence` rows are not enough to make the overview timeline look fresh

Result:

- the page can show fresh session telemetry and stale “latest evolution” at the same time

### 4. Runtime identity is too opaque

- `selftune dashboard --port 3141` and `bun run dev` can run different backend processes
- the historical `127.0.0.1` probe mismatch created false negatives on IPv6-localhost setups; the probe is now fixed, but process clarity still matters
- `/api/health` now exposes runtime identity, but operators still need broader freshness/integrity diagnostics
- a global `npm link` can point `selftune` at a different workspace than the one the operator thinks is live

Result:

- operators cannot quickly tell which checkout, backend, DB, or log store they are looking at

### 5. Tests and proof harnesses are not hermetic enough

- constants resolve directly to `homedir()` paths in `cli/selftune/constants.ts`
- proof and integration tests can exercise real appenders unless they override dependencies correctly
- recent local-store pollution matched temp `selftune-blog-proof-*` paths from `tests/blog-proof/seo-audit-evolve.test.ts`

Result:

- test/proof data can leak into real operator dashboards

### 6. CLI/operator guidance is inconsistent

- the nonexistent `selftune rebuild-db` guidance was removed from code paths
- the remaining operator task is to keep docs aligned around the export-first recovery flow

Result:

- recovery guidance still needs active maintenance right when the operator most needs trustworthy instructions

---

## Target State

- every persisted stream has one clearly defined durability strategy
- destructive rebuild is either lossless or blocked
- tests cannot touch the real local store
- dashboard health clearly identifies runtime, workspace, DB path, log path, and watcher mode
- `selftune dashboard` and `bun run dev` expose the same backend truth when pointed at the same store
- real evolutions appear in the dashboard within one refresh cycle
- docs describe the architecture that is actually shipping

---

## Execution Order

Work in this order. Do not start with UI tweaks.

### Phase 0: Protect Real Data and Expose Runtime Identity

**Status:** Mostly complete

**Priority:** Critical  
**Effort:** Small  
**Risk:** Low

**Files:**

- `cli/selftune/dashboard-server.ts`
- `cli/selftune/dashboard-contract.ts`
- `packages/ui/src/types.ts`
- `apps/local-dashboard/src/pages/Overview.tsx`
- `package.json`
- `apps/local-dashboard/vite.config.ts`

**Changes:**

1. Expand `/api/health` to include:
   - workspace root
   - git SHA
   - DB path
   - log directory
   - watcher mode (`jsonl` vs `sqlite-wal`)
   - process mode (`standalone`, `dev-server`)
   - listening host/port
2. Surface the same runtime identity in the dashboard UI, at least in a compact debug footer or operator panel.
3. Fix the `dev` script probe to use `localhost`, not `127.0.0.1`.
4. Make the `dev` script wait for backend health before letting the frontend proxy race it.
5. Add an explicit warning in health/UI if the dashboard is still using JSONL watcher mode.

**Acceptance Criteria:**

- an operator can answer “which workspace/codebase is this server running?” from the UI or `/api/health`
- `bun run dev` no longer false-fails on IPv6-localhost setups
- startup race on `5199` is reduced to at most a brief initial retry, not a confusing multi-error burst

---

### Phase 1: Make Tests and Proof Harnesses Hermetic

**Status:** Substantially complete for path isolation; CI/store-touch guard still optional follow-on

**Priority:** Critical  
**Effort:** Medium  
**Risk:** Low

**Files:**

- `cli/selftune/constants.ts`
- test helpers under `tests/`
- `tests/blog-proof/seo-audit-evolve.test.ts`
- `tests/autonomy-proof.test.ts`
- `tests/evolution/*.test.ts`
- sandbox harness scripts if needed

**Changes:**

1. Introduce environment-overridable storage roots, for example:
   - `SELFTUNE_HOME`
   - `SELFTUNE_CONFIG_DIR`
   - `SELFTUNE_LOG_DIR`
2. Make all constants derive from those overrides first, then fall back to `homedir()`.
3. Update proof/integration tests to run with temp directories for both config and logs.
4. Add a shared test helper that creates and tears down isolated temp stores.
5. Add a CI/test guard that fails if any test touches the real `~/.selftune` or `~/.claude` paths.

**Acceptance Criteria:**

- running blog-proof or autonomy-proof tests leaves the real local dashboard data unchanged
- tests can still use real appenders, but only against temp stores
- local developers can inspect a temp test DB/log dir after a failure

---

### Phase 2: Make Rebuild and Backup Semantics Honest

**Status:** Started

**Priority:** Critical  
**Effort:** Medium  
**Risk:** Medium

**Files:**

- `cli/selftune/localdb/materialize.ts`
- `cli/selftune/localdb/db.ts`
- `cli/selftune/evolution/audit.ts`
- `cli/selftune/evolution/evidence.ts`
- `cli/selftune/orchestrate.ts`
- `cli/selftune/export.ts`
- `cli/selftune/index.ts`
- relevant tests under `tests/localdb/`, `tests/evolution/`, `tests/dashboard/`

**Decision:**

Short-term, restore backup symmetry for the streams that rebuild currently assumes are recoverable from JSONL:

- `evolution_audit`
- `evolution_evidence`
- `orchestrate_runs`

Long-term, remove that compatibility bridge only after rebuild no longer depends on JSONL for those tables.

**Changes:**

1. Add a rebuild preflight that compares SQLite max timestamps vs JSONL max timestamps per stream. Completed.
2. Refuse destructive rebuild when SQLite is newer for protected tables unless the operator explicitly forces it. Completed.
3. Reintroduce JSONL backup writes for audit/evidence/orchestrate rows so current backup/rebuild claims become true again.
4. Either implement a real `selftune rebuild-db` command with the safety checks, or remove every user-facing reference to it until it exists.
5. Add tests proving:
   - rebuild aborts on lossy inputs
   - backup JSONL stays in sync for protected streams
   - export/rebuild round-trips preserve recent rows

**Acceptance Criteria:**

- rebuild cannot silently discard recent SQLite-only rows
- protected streams are recoverable from backup again
- operator-facing guidance matches the actual available command surface

---

### Phase 3: Finish the Dashboard Freshness Contract

**Priority:** High  
**Effort:** Medium  
**Risk:** Medium

**Files:**

- `cli/selftune/dashboard-server.ts`
- `cli/selftune/localdb/db.ts`
- `cli/selftune/localdb/queries.ts`
- `docs/design-docs/live-dashboard-sse.md`
- `docs/design-docs/sqlite-first-migration.md`
- dashboard route tests

**Changes:**

1. Replace JSONL file watchers with SQLite WAL watching in the live server.
2. Keep startup materialization only as historical backfill, not as part of “freshness.”
3. Remove no-op refresh indirection once watcher mode is coherent.
4. Add a targeted test that proves a direct SQLite write triggers SSE and a subsequent fresh overview fetch.
5. Update the design docs to match the shipped implementation exactly.

**Acceptance Criteria:**

- SSE invalidation is triggered by SQLite writes, not JSONL file changes
- the dashboard’s freshness path matches the architecture docs
- live updates do not depend on evolution audit JSONL specifically

---

### Phase 4: Make the Overview Timeline Semantics Explicit

**Priority:** High  
**Effort:** Small  
**Risk:** Low

**Files:**

- `cli/selftune/localdb/queries.ts`
- `packages/ui/src/components/ActivityTimeline.tsx`
- `apps/local-dashboard/src/pages/Overview.tsx`
- `cli/selftune/evolution/evolve.ts`
- `cli/selftune/evolution/evolve-body.ts`
- tests for overview queries and timeline rendering

**Decision:**

Do not paper over missing audit rows by automatically treating all evidence as timeline activity.

Fix the invariants first:

- real evolution flows that should appear in the operator timeline must emit audit rows consistently
- evidence-only flows may exist, but must be explicitly labeled as such

**Changes:**

1. Audit the evolve/orchestrate paths to ensure `created`, `validated`, `deployed`, and rollback-worthy events always emit audit entries.
2. Add a dashboard indicator explaining whether the overview timeline is “audit activity” or a broader “evolution activity” feed.
3. Only after invariants are fixed, decide whether to add a separate evidence activity panel or merge sources intentionally.

**Acceptance Criteria:**

- a real autonomous evolution produces timeline-visible activity within one refresh cycle
- proof/test evidence does not masquerade as production timeline history
- operators can tell what the overview timeline is actually showing

---

### Phase 5: Add Data-Integrity Diagnostics and Recovery Tools

**Priority:** Medium  
**Effort:** Medium  
**Risk:** Medium

**Files:**

- `cli/selftune/observability.ts`
- `cli/selftune/status.ts`
- `cli/selftune/dashboard-server.ts`
- optional repair utility/command

**Changes:**

1. Add doctor checks for:
   - DB newer than JSONL
   - JSONL newer than DB
   - missing protected backup streams
   - test/temp skill paths in production tables
   - watcher mode mismatch vs docs
2. Add a compact integrity section to the dashboard doctor view.
3. Consider an opt-in repair tool for reconstructable audit rows from evidence, but only after:
   - tests are isolated
   - runtime identity is visible
   - repair filters out temp/test paths

**Acceptance Criteria:**

- operators can detect drift before data disappears
- any repair path is explicit and conservative

---

## Verification Matrix

### Runtime parity

1. Start `selftune dashboard --port 3141 --no-open`
2. Start `bun run dev`
3. Compare:
   - `/api/health`
   - `/api/v2/overview`
   - `/api/v2/orchestrate-runs`
4. Confirm both backends report the same:
   - workspace root
   - git SHA
   - DB path
   - latest telemetry timestamp
   - latest evolution audit timestamp

### Rebuild safety

1. Seed SQLite with newer protected rows than JSONL
2. Attempt rebuild
3. Verify rebuild aborts with a clear diagnostic
4. Enable explicit force only in a controlled test and verify the warning is unmistakable

### Test isolation

1. Snapshot row counts in the real `~/.selftune/selftune.db`
2. Run proof/integration tests
3. Verify real counts are unchanged
4. Verify temp store contains the expected new rows instead

### Freshness

1. Perform a direct SQLite write to a watched table
2. Verify SSE broadcasts an update
3. Verify the overview fetch reflects the new row
4. Run a real `selftune evolve` / `selftune orchestrate` flow against a temp skill and verify the overview timeline updates

---

## Scope Boundaries

This plan is not:

- a UI redesign
- a generalized event-sourcing rewrite
- a cloud-sync architecture change

This plan is specifically about making the current local operator system trustworthy.

---

## Recommended First PR Split

1. Runtime identity + `dev` health-check fix
2. Test storage isolation
3. Rebuild safety + protected-stream backup restoration
4. SQLite WAL SSE cutover
5. Timeline semantics + doctor integrity checks

That order reduces the chance of losing more operator data while the deeper cleanup is still in flight.
