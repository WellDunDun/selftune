# Execution Plan: Alpha Simplification Program

**Status:** Proposed  
**Created:** 2026-03-19  
**Goal:** Reduce coordination tax during alpha by freezing optional breadth, deleting redundant architecture, and converging on one narrow happy path that is easier to ship, debug, and maintain.

## Problem Statement

selftune is moving slowly because too many changes cross too many unsettled boundaries.

Today the project is simultaneously acting as:

- a local agent skill
- a telemetry/normalization pipeline
- a dashboard/operator surface
- a cloud product with auth, uploads, and analysis

That would be manageable if the boundaries were settled. They are not.

The current drag comes from unresolved duplication and partial migrations:

- JSONL vs SQLite vs cloud as “source of truth”
- browser auth vs API auth vs alpha auth
- local product vs cloud product
- agent-facing docs vs CLI behavior
- primary platform vs experimental platforms

The result is that a small feature often becomes:

- CLI work
- workflow doc work
- local schema work
- dashboard contract work
- cloud ingest work
- operator semantics work

This is why progress feels slow.

## Principle

For alpha, selftune should optimize for:

- one primary platform
- one local runtime path
- one cloud auth model
- one ingest path
- one explanation of what the system is doing

Everything else should be frozen, deferred, or explicitly downgraded to experimental.

## Target Alpha Shape

### Keep

- Claude Code as the primary alpha platform
- SQLite as the local runtime/query store
- cloud upload to the main cloud API + Neon
- Neon Auth as the canonical user/session model
- product-owned upload credentials tied to cloud users
- one dashboard path that reflects the actual current system
- the agent-first skill surface for the primary workflows

### Freeze

- Codex/OpenCode/OpenClaw architecture work
- new dashboard surfaces that do not help alpha learning
- new eval/evolution sophistication that is not required for current alpha decisions
- new auth variants
- new ingestion backends

### Delete or Defer

- runtime dependence on JSONL watchers
- duplicate auth stacks
- stale workflows/docs for unsupported paths
- ambiguous “source of truth” language
- optional architecture branches that are not serving the current alpha

## Simplification Decisions

### Decision 1: One Primary Platform

**Decision:** Claude Code is the only first-class platform during alpha.

Implications:

- Claude Code paths get active maintenance
- Codex/OpenCode/OpenClaw remain explicitly experimental
- no new architectural work should be justified by experimental adapters during alpha

Follow-through:

- mark non-Claude adapters as frozen for alpha
- stop routing roadmap-critical decisions through multi-platform generality

### Decision 2: SQLite-Primary Local Runtime

**Decision:** SQLite is the only local runtime/query source of truth.

Implications:

- dashboard reads from SQLite
- local status/doctor/report queries read from SQLite
- JSONL remains backup/export/input material, not runtime truth

Follow-through:

- no runtime freshness logic should depend on JSONL watchers
- JSONL becomes archival/recovery/input material only
- docs must stop implying equal status between JSONL and SQLite

### Decision 3: One Cloud Ingest Path

**Decision:** Alpha data goes to the main cloud API and Neon. No parallel worker/D1 path for alpha.

Implications:

- one remote store
- one auth boundary
- one operator query surface

Follow-through:

- remove or freeze sidecar remote-ingest experiments for alpha
- keep `telemetry-contract` authoritative, but keep ingestion concentrated in one backend

### Decision 4: One Cloud Auth Story

**Decision:** Neon Auth owns user/session identity. Upload credentials are product-owned credentials tied to those cloud users.

Implications:

- alpha users are cloud users
- local alpha identity becomes cached state, not source of truth
- browser auth and upload auth resolve into one user/org graph

Follow-through:

- do not keep a parallel direct Better Auth product auth stack
- do not assume custom Better Auth plugin paths are the right long-term boundary just because Neon Auth uses Better Auth under the hood

### Decision 5: One Honest Dashboard Story

**Decision:** The dashboard must clearly say what it is showing and what freshness model it uses.

Implications:

- no mixed implicit semantics
- no “recent activity” labels when the data source is actually older audit-only state
- no mystery backend/process identity

Follow-through:

- preserve runtime identity and watcher-mode indicators
- prefer explicit labels over ambiguous aggregation

## Concrete Cut List

### Cut Now

- New platform-generalization work for non-Claude adapters
- Additional D1/worker architecture for alpha telemetry
- Auth work that preserves both Neon Auth and a second product auth stack
- Dashboard features that depend on unresolved semantics

### Cut Soon

- JSONL-driven runtime invalidation
- stale workflow instructions for removed or legacy paths
- duplicate contract definitions where one package should be authoritative

### Keep Investing In

- upload reliability
- operator review tools
- marginal-case analysis
- auth unification
- data integrity
- agent-facing workflow accuracy

## Execution Phases

### Phase 0: Freeze Optional Breadth

**Priority:** Critical  
**Effort:** Small  
**Risk:** Low

Actions:

- mark non-Claude platform work as frozen for alpha
- mark sidecar remote-ingest experiments as out of scope for alpha
- stop accepting roadmap arguments that depend on multi-platform breadth

Completion criteria:

- active plans stop assuming equal investment across platforms
- open work is framed around the Claude Code alpha path

### Phase 1: Remove Duplicate Authority

**Priority:** Critical  
**Effort:** Medium  
**Risk:** Medium

Actions:

- converge auth around the cloud-auth unification plan
- continue the SQLite-primary cleanup
- remove stale source-of-truth language in docs

Completion criteria:

- one answer for “where is local truth?”
- one answer for “who is the user?”
- one answer for “where does alpha data go?”

### Phase 2: Delete Obsolete Paths

**Priority:** High  
**Effort:** Medium  
**Risk:** Medium

Actions:

- remove dead or misleading commands/docs
- remove runtime dependencies on transitional code paths once replacements are proven
- archive or explicitly label experimental modules instead of pretending they are near-equal peers

Completion criteria:

- fewer paths to do the same thing
- fewer stale docs
- fewer “temporary” branches still in the critical path

### Phase 3: Tighten the Alpha Kernel

**Priority:** Critical  
**Effort:** Medium  
**Risk:** Low

Define the alpha kernel as the only thing that must feel great:

- init/enroll
- observe
- upload
- inspect
- label marginal cases
- improve core skill behavior

Everything else is secondary until the kernel is fast and trustworthy.

Completion criteria:

- a new alpha user can be onboarded quickly
- uploads are trustworthy
- Daniel can inspect real data quickly
- the core improvement loop is understandable

## Success Metrics

- A typical alpha-facing change touches fewer subsystems than it does today.
- The team can explain local truth, cloud truth, and auth truth in one sentence each.
- The number of “experimental but still on the critical path” modules goes down.
- The time from bug discovery to confident fix gets shorter.
- The number of plan/doc/code mismatches drops materially.

## Anti-Goals

Do not use this plan as justification for:

- another broad rewrite
- new generic abstractions
- new cross-platform frameworks
- more architecture before deleting old architecture

The point is subtraction, not sophistication.

## Related Plans

- [alpha-rollout-data-loop-plan.md](/Users/danielpetro/conductor/workspaces/selftune/miami/docs/exec-plans/active/alpha-rollout-data-loop-plan.md)
- [cloud-auth-unification-for-alpha.md](/Users/danielpetro/conductor/workspaces/selftune/miami/docs/exec-plans/active/cloud-auth-unification-for-alpha.md)
- [dashboard-data-integrity-recovery.md](/Users/danielpetro/conductor/workspaces/selftune/miami/docs/exec-plans/active/dashboard-data-integrity-recovery.md)
