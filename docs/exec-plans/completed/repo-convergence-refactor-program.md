<!-- Verified: 2026-04-10 -->

# Execution Plan: Repo Convergence Refactor Program

**Status:** Completed
**Created:** 2026-04-09
**Goal:** Increase shipping velocity, reduce drift, and simplify the selftune OSS codebase by converging duplicated authority surfaces rather than rewriting the product.

---

## Executive Summary

selftune does not have a single “bad architecture” problem. It has a **convergence problem**.

Today, the repo still allows multiple partially-correct stories about the same behavior:

- description evolution still flows through the judge-centric path in `cli/selftune/evolution/validate-proposal.ts`
- body/routing evolution already prefer replay via `cli/selftune/evolution/evolve-body.ts`
- docs describe the evolution system at a higher level than the concrete split between those paths
- the orchestrator, read-model queries, CLI help, workflow docs, and dashboard payload shapes are all individually reasonable, but not governed by one authoritative source

That is why audits drift, why large files keep growing, and why shipping a correct change often requires touching many surfaces by hand.

The right move is not “rewrite the repo.” The right move is:

1. reduce the number of places where behavior is defined
2. split oversized choke-point files by domain
3. generate or contract-test human-facing docs from code where possible
4. delete transitional paths once replacements are stable
5. reduce the public product surface instead of adding more commands, paths, and flags

If executed well, this should produce:

- materially faster changes in eval/evolution/monitoring
- less code in the OSS CLI surface
- better runtime efficiency in hot paths
- fewer incorrect audits and stale docs

## Progress Update (2026-04-09)

Completed milestones:

- Phase 0 stabilization gate is closed. The shipped `evolve`, `watch`, and
  `eval generate` surface now matches docs/help closely enough to start
  structural cleanup.
- Phase 1 Cut 1 is complete. Description evolution and body/routing evolution
  now share a validation contract and one replay-first/judge-fallback policy.
- Phase 1 Cuts 2 and 3 are complete for the highest-drift commands.
  `eval generate`, `evolve`, `watch`, and `orchestrate` now share command
  metadata, and parity tests cover CLI help, workflow docs, quick reference,
  and site docs.
- Phase 2 Target B has started and the first low-risk extraction wave is
  complete. `orchestrate.ts` now delegates locks, signals, candidate planning,
  reporting, replay-option synthesis, and CLI parsing/JSON serialization to domain modules under
  `cli/selftune/orchestrate/`.
- Phase 2 Target B Wave 2 is now complete. The evolve loop, post-deploy grade
  baseline write, and watch-after-deploy path are extracted into
  `orchestrate/execute.ts`, leaving `orchestrate.ts` as a thinner coordinator.
- Phase 2 Target B Wave 3 is now complete. Result assembly, signal
  consumption, run-report persistence, and cron-run persistence moved into
  `orchestrate/finalize.ts`.
- Phase 2 Target B Wave 4 is now complete. Dependency resolution, pre-run
  sync/status/candidate preparation, cross-skill overlap detection, auto-grade
  preparation, and non-blocking post-run upload/relay side effects moved out
  of `orchestrate.ts` into dedicated modules.
- Phase 2 Target C Wave 1 is now complete. The first operational query domains
  are extracted behind `localdb/queries.ts`, with `json`, `cron`,
  `monitoring`, and `staging` submodules now owning those read paths.
- Phase 2 Target C Waves 2 and 3 are now complete. Evolution, trust,
  execution, dashboard/report, pagination, and raw reader paths are extracted
  into dedicated query modules, and `localdb/queries.ts` is now a thin barrel
  that preserves the existing import surface.

What changed in the current orchestrator wave:

- extracted `orchestrate/locks.ts`
- extracted `orchestrate/signals.ts`
- extracted `orchestrate/plan.ts`
- extracted `orchestrate/report.ts`
- extracted `orchestrate/execute.ts` for replay-option construction
- extracted `orchestrate/cli.ts` for CLI parsing, validation, help rendering,
  and machine-readable output shaping
- expanded `orchestrate/execute.ts` to own evolve execution, post-deploy grade
  baseline writes, and watch handling for recent/fresh deployments
- extracted `orchestrate/finalize.ts` for summary assembly and run persistence
- extracted `orchestrate/runtime.ts` for dependency resolution, default readers,
  skill-path discovery, and lazy command loading
- extracted `orchestrate/prepare.ts` for sync/status preparation, auto-grade
  orchestration, signal intake, candidate logging, and overlap detection
- extracted `orchestrate/post-run.ts` for alpha upload and contribution relay
  side effects
- preserved the public `orchestrate.ts` entrypoint and existing test imports
- restored the deterministic autonomy proof by making its injected evolve path
  opt out of host replay explicitly instead of accidentally depending on the
  live Claude runtime path
- fixed the hidden catch-path bug where failed orchestrate runs could mask the
  original error while attempting to write the cron failure record

- Phase 3.1 is complete. First deletion + performance pass:
  - deleted `validateProposalSequential()` (~140 lines) and archived the
    deterministic-routing-validation plan to completed/
  - deleted `writeCanonicalExport()`, dead re-exports from grade-session.ts,
    orphaned query barrel exports (`getActiveSessionCount`, `getRecentActivity`)
  - cached `autoGradeTopUngraded` data reads outside the per-skill loop
    (was O(n) full-table scans, now 1 read)
  - reused queryRecords/auditEntries in post-autograde recompute
  - added composite index `(proposal_id, phase)` on replay_entry_results
  - fixed stale `validateProposalSequential` reference in evolution-pipeline.md

- Phase 3.2 is complete. Explicit optional limits were added to raw reader
  paths, while default callers remain unbounded to preserve export/recovery
  semantics. Hot paths should pass scoped limits where they are reading
  operational windows rather than complete history.
- Phase 3.3 is complete. Removed compatibility wrappers with zero consumers:
  - dead type re-exports from validate-routing.ts (RoutingReplayRunnerInput,
    RoutingReplayRunner, RoutingValidationOptions)
  - deprecated `logPath` field from RollbackOptions (never passed by any caller)
  - Intentionally kept: `recent_invocations` in dashboard-contract.ts (12 consumers
    across frontend, API, and tests), `writeSkillUsageToDb` (16 active callers),
    JSONL path constants (used by recovery/export), `--serve` dashboard alias (low-risk)

Phase 3 is now complete. Exit criteria met:
  - measurable code deletion across Phases 3.1–3.3
  - command/docs drift covered by parity tests from Phase 1
  - eval/evolution/monitoring changes require fewer touchpoints via shared
    validation contract and domain-split orchestrate/queries modules

Plan moved to completed/. Future deeper velocity work should be defined as a
new Phase 4 plan with narrower surface-area reduction goals.

---

## Why This Matters

The repo is already proving the problem in practice.

### Example 1: Partially Correct Gap Analysis

The recent eval-system audit was directionally useful, but partially wrong because the repo still presents multiple valid-looking authority surfaces:

- `cli/selftune/evolution/validate-proposal.ts` remains judge-centric for description evolution
- `cli/selftune/evolution/evolve-body.ts` already auto-builds replay fixtures and uses replay-first validation for body/routing evolution
- `docs/design-docs/evolution-pipeline.md` describes the pipeline broadly enough that a reader can miss the distinction

The result is not “someone failed to read carefully.” The result is that the repo makes it too easy to be locally right and globally wrong.

### Example 2: Oversized Choke Points

Two files dominate change-risk:

- `cli/selftune/orchestrate.ts` is lock manager, signal intake, candidate selector, report formatter, auto-grader, orchestrator, and CLI entrypoint
- `cli/selftune/localdb/queries.ts` is the read-model layer for dashboard payloads, reports, analytics, trust views, upload staging, replay inspection, cron, and grading baselines

These files are not just large. They are the places where new work gets dumped because they already “own the thing.”

### Example 3: Product Surface Drift

The actual product surface for agent users is spread across:

- CLI flags and behavior
- `skill/SKILL.md`
- `skill/workflows/*.md`
- design docs
- tests

Some drift checks already exist, but they do not yet cover the repo’s most expensive human misunderstanding failures.

---

## What Success Looks Like

This program succeeds if, after refactoring:

1. one person can answer “how does eval/evolution validation work?” from one authoritative implementation path
2. one change to a command or workflow behavior updates docs/help mechanically or is blocked by tests
3. adding a new dashboard/report query does not require editing a 2400-line warehouse module
4. orchestrator policy changes do not require navigating one 1600-line file
5. old transitional modules are actually removed instead of preserved indefinitely

---

## First Principles

### 1. Converge Before Optimizing

Do not micro-optimize duplicated logic. First remove the duplicate decision paths.

### 2. Split By Domain, Not By “Utility”

A large module should be split into stable product domains, not into vague helper buckets.

### 3. Product Surface Must Have An Authority

CLI behavior, workflow docs, and user-facing help should either be generated from the same source or contract-tested against each other.

### 4. Transitional Paths Must Expire

Any temporary compatibility layer needs a stated deletion condition.

### 5. Refactor For Human Throughput First

The biggest gains here are not CPU gains. They are:

- faster correct edits
- lower audit error rate
- less context load per change

### 6. One Canonical Path Per Job

For recurring product behavior, there should be one blessed runtime path.

Current policy direction:

- `orchestrate` is the primary runtime path
- `evolve`, `watch`, and `eval generate` remain available, but should be
  treated as operator/debug tools unless they are the canonical flow for a job

### 7. Default Behavior Beats Exposed Strategy

If a flag only exists because implementation authority is fragmented, it is a
refactor smell. Public flags should express user intent, not internal strategy.

### 8. No New Surface While Reality Is Unstable

Do not add more commands, expert paths, or mode flags while docs and shipped
behavior still disagree on the current surface.

---

## Immediate Prerequisite: Stabilize The Shipped Surface

Before Phase 1 starts, the repo needs a short stabilization wave. The audit
found that several capabilities are documented as if they are shipped, but are
only partially wired:

- description replay validation is not reachable from the real `evolve` or
  `orchestrate` surface without injected test seams
- replay-backed description validation drops evidence needed by Pareto
  selection and audit/evidence persistence
- grade watch ignores the proposal-scoped baselines orchestrate writes
- `watch` documents grade-watch flags that the CLI does not parse
- `eval generate --blend` can silently emit an empty file for log-sparse skills

This matters because refactoring on top of these mismatches would preserve the
ambiguity we are trying to eliminate.

### Stabilization Exit Criteria

1. Docs and help only describe behavior reachable from the real public surface.
2. Replay-backed description validation works from the shipped path or is
   explicitly hidden or removed from the public surface.
3. Grade-watch compares the correct deployment baselines.
4. `watch` flag docs and CLI parsing match exactly.
5. `--blend` has explicit zero-log behavior and cannot silently write `[]`.

---

## Opinionated Product-Surface Policy

This program should be more opinionated than the current repo posture.

### Canonical Surface

- `orchestrate` is the default “make the system better” command
- `evolve`, `watch`, and `eval generate` should remain focused subcommands, not
  parallel product stories with their own drifting policy

### Surface Reduction Rules

- no new top-level commands in this program unless they replace an existing one
- no new public mode flags unless they are required for correctness or
  debugging during migration
- if an “advanced” flag mainly exposes implementation detail, move it behind a
  dev-only path or remove it
- every public flag must have:
  - one owning command definition
  - one workflow doc entry
  - one contract test proving parity

---

## High-Leverage Refactor Targets

### Target A: Validation/Evolution Convergence

**Current problem**

Validation behavior is split across:

- `evolution/validate-proposal.ts`
- `evolution/validate-body.ts`
- `evolution/validate-routing.ts`
- `evolution/engines/judge-engine.ts`
- `evolution/engines/replay-engine.ts`
- orchestration logic in both `evolve.ts` and `evolve-body.ts`

This is the clearest example of a domain with multiple partially authoritative flows.

**Refactor goal**

Create one validation engine contract with:

- explicit mode selection
- one result/provenance shape
- one replay/judge fallback policy
- one integration point per evolution target

**Expected benefit**

- lower drift between description and body/routing evolution
- easier audits
- fewer validation bugs
- fewer duplicated tests

### Target B: Orchestrator Decomposition

**Current problem**

`orchestrate.ts` mixes policy, execution, reporting, and CLI concerns.

**Refactor goal**

Split into:

- `orchestrate/plan.ts`
- `orchestrate/execute.ts`
- `orchestrate/report.ts`
- `orchestrate/signals.ts`
- `orchestrate/locks.ts`
- a thin CLI entrypoint

**Expected benefit**

- faster change isolation
- simpler testing
- easier policy review
- reduced merge conflicts

**Progress**

- Wave 1 complete: lock management, signal ingestion, candidate planning,
  reporting, replay-option synthesis, and CLI parsing are extracted behind the
  existing entrypoint.
- Wave 2 complete: evolve execution, post-deploy grading, and watch handling
  moved into `orchestrate/execute.ts`.
- Wave 3 complete: result assembly and run persistence moved into
  `orchestrate/finalize.ts`.
- Wave 4 complete: dependency resolution moved into `orchestrate/runtime.ts`,
  pre-run preparation into `orchestrate/prepare.ts`, and non-blocking upload
  and relay side effects into `orchestrate/post-run.ts`.
- Remaining work: keep `orchestrate.ts` as the composition layer, and shift
  the next large-file decomposition effort to `localdb/queries.ts`.

### Target C: Read-Model Query Decomposition

**Current problem**

`localdb/queries.ts` is the entire SQLite read warehouse.

**Refactor goal**

Split by domain:

- `localdb/queries/dashboard.ts`
- `localdb/queries/evolution.ts`
- `localdb/queries/monitoring.ts`
- `localdb/queries/staging.ts`
- `localdb/queries/trust.ts`
- `localdb/queries/cron.ts`
- `localdb/queries/json.ts`

**Expected benefit**

- smaller review surfaces
- clearer ownership
- easier performance profiling on hot query paths

**Progress**

- Wave 1 complete: `localdb/queries.ts` now delegates JSON parsing, cron-run
  queries, monitoring/replay/grading queries, and staging/upload queries to
  `localdb/queries/{json,cron,monitoring,staging}.ts`.
- Wave 2 complete: evolution audit/evidence, pending proposal, orchestrate-run,
  trust/attention, and execution-enrichment queries moved into
  `localdb/queries/{evolution,trust,execution}.ts`.
- Wave 3 complete: dashboard/report payload builders, cursor pagination, and
  low-level raw read helpers moved into `localdb/queries/{dashboard,raw}.ts`.
- Result: `localdb/queries.ts` is now a thin barrel that preserves the
  existing import surface while the actual query logic is split by domain.

### Target D: Product Surface Unification

**Current problem**

The agent-facing product is defined across code and markdown manually.

**Refactor goal**

Move command metadata into structured definitions and use that to drive:

- CLI help output
- quick reference docs
- workflow flag tables where possible
- drift tests where generation is not appropriate

**Expected benefit**

- less doc drift
- fewer stale examples
- lower onboarding cost for new contributors

### Target E: Transitional Path Deletion

**Current problem**

The repo preserves old and new paths together for too long.

**Refactor goal**

Add deletion checkpoints for:

- old validation call sites
- legacy query exports no longer used
- compatibility-only wrappers
- stale docs that describe superseded flows

**Expected benefit**

- codebase actually gets smaller
- less confusion during audits

---

## Three Phases

## Phase 0: Surface Stabilization

**Goal:** make the current product surface true before restructuring it.

**Duration:** 2-5 days  
**Risk:** Low  
**Expected leverage:** Very high

### Scope

1. Fix code/docs/help mismatches in `evolve`, `watch`, and `eval generate`
2. Make replay-backed description validation either real or explicitly not public
3. Make grade-watch compare the baselines it claims to use
4. Add contract tests around command/help/workflow parity
5. Freeze new public surface area for eval/evolution/monitoring during this wave

### Exit Criteria

- audit findings on the shipped surface are resolved or intentionally removed
- docs stop describing injected test seams as product behavior
- command/help/workflow parity tests exist for the most drift-prone commands

---

## Phase 1: Authority Cleanup

**Goal:** make it possible to answer “what is the system doing?” without archaeology.

**Duration:** 1-2 weeks  
**Risk:** Low-Medium  
**Expected leverage:** Very high

### Scope

1. Define one validation-mode/result contract for eval/evolution.
2. Make one module the authority for command metadata where feasible.
3. Add contract tests for the highest-drift surfaces.
4. Mark transitional modules with explicit deletion intent.
5. Reduce public strategy flags where the new authority surface makes them unnecessary

### First 4 Cuts

#### Cut 0: Surface Reduction Pass

Decide which flags remain public after stabilization and which become internal
or disappear entirely. The target is fewer user-visible ways to do the same
job, not better documentation for every duplicated path.

#### Cut 1: Validation Contract Extraction

Create a small typed contract module for:

- validation mode selection
- validation provenance
- before/after result shape
- replay availability policy

Then make `evolve.ts` and `evolve-body.ts` consume it.

#### Cut 2: Command Metadata Registry

Create a structured registry for commands most prone to drift first:

- `eval generate`
- `evolve`
- `watch`
- `orchestrate`

Use it to drive help text and quick-reference output.

#### Cut 3: Drift Tests Over Generation

Where generation is too invasive, add tests that fail when:

- CLI flags differ from workflow docs
- quick reference differs from registered command metadata
- docs claim replay/judge behavior that code does not implement

#### Cut 4: Canonical Runtime Handoff

Make the command metadata and docs reflect one blessed runtime story:

- `orchestrate` for recurring improvement
- focused subcommands for debugging or operator intervention
- fewer policy decisions exposed as flags

### Exit Criteria

- eval/evolution docs stop being able to drift silently
- one person can trace validation behavior without reading five modules
- first command registry is live for the highest-value commands
- the public surface is smaller or stricter than before, not merely better documented

---

## Phase 2: Domain Extraction

**Goal:** reduce change blast radius in the largest modules.

**Duration:** 2-4 weeks  
**Risk:** Medium  
**Expected leverage:** High

### Scope

1. Split orchestrator by domain
2. Split localdb query layer by domain
3. Stabilize package-level boundaries for those domains
4. Remove dead re-export layers after migration

### Workstreams

#### Orchestrator Split

Move from one large file to:

- planning and candidate policy
- execution runner
- watch integration
- reporting/summary formatting
- CLI parsing

#### Query Layer Split

Extract query groups into domain modules while preserving a compatibility barrel temporarily.

#### Ownership Rules

Each extracted domain gets:

- a small README or header comment describing authority
- tests colocated by domain
- explicit “imports allowed from here” boundaries where sensible

### Exit Criteria

- `orchestrate.ts` is mostly a thin entrypoint
- `queries.ts` is mostly a barrel or removed entirely
- domain-level tests replace giant file-level intuition

---

## Phase 3: Deletion, Performance, and Shipping Speed

**Goal:** cash in the convergence work by removing dead code and simplifying hot paths.

**Duration:** 1-3 weeks  
**Risk:** Medium  
**Expected leverage:** High

### Scope

1. remove compatibility wrappers proven unused
2. simplify hot-path query and validation execution
3. reduce LLM calls where the converged design makes it obvious
4. tighten review and release procedures around the new authority surfaces

### Performance Focus Areas

- replay/judge selection should avoid unnecessary duplicate work
- query modules should expose obvious hotspots for caching or SQL tightening
- command/docs generation should remove manual maintenance work

### Velocity Focus Areas

- fewer files per feature change
- less need for tribal knowledge
- smaller PRs with clearer ownership

### Exit Criteria

- measurable code deletion, not only movement
- command/docs drift incidents materially reduced
- feature changes in eval/evolution/monitoring require fewer touchpoints

---

## Expected Outcomes

These are directional, not contractual:

### Code Size

- OSS CLI surface reduced by roughly 15-25% after transitional deletion

### Runtime

- modest but real performance gains in eval/evolution and query hot paths
- likely more benefit from reduced duplicated calls than from low-level tuning

### Shipping Velocity

- 2x faster correct iteration in eval/evolution/monitoring is plausible
- repo-wide gains depend on whether transitional paths are actually removed

### Trustworthiness

- lower probability of partially-correct architecture audits
- lower probability of shipping doc/behavior mismatch

---

## Risks

### Risk 1: Endless Refactor With No Product Gain

Mitigation:

- phase gates must require deletion and product-facing simplification, not just file movement

### Risk 2: Over-Abstracting The CLI

Mitigation:

- only centralize metadata that already exists in multiple hand-maintained forms
- prefer deleting flags over abstracting every flag forever

### Risk 3: Compatibility Layers Become Permanent

Mitigation:

- every temporary barrel/wrapper gets an owner and a deletion checkpoint

### Risk 4: Query Splits Become A New Maze

Mitigation:

- split by stable domains only
- preserve a small top-level index with explicit export intent

---

## Things We Should Not Do

1. Do not rewrite the repo around a new framework.
2. Do not pause product work for a giant architectural branch.
3. Do not split files without first deciding authority boundaries.
4. Do not generate every doc blindly; use tests where generation would make the UX worse.
5. Do not keep old and new paths alive indefinitely “just in case.”

---

## Suggested Starting Sequence

If we only do the highest-leverage start, do this:

1. finish the stabilization wave and stop docs/help from overstating shipped behavior
2. reduce the public surface to one canonical runtime story per job
3. extract the validation contract and unify description/body/routing decision policy
4. add a command metadata registry for `eval generate`, `evolve`, `watch`, and `orchestrate`
5. split `orchestrate.ts` into plan/execute/report/cli
6. split `localdb/queries.ts` into domain modules
7. delete transitional wrappers immediately after migration

That sequence should deliver most of the trust and velocity gain without destabilizing the whole repo.

---

## Final Assessment

Yes, a repo-wide refactor can substantially improve selftune.

But the high-return version is not “make everything cleaner.” It is:

- converge authority
- split choke points by domain
- mechanize or test the product surface
- delete transitional code aggressively

That is the path most likely to increase shipping velocity, reduce code, improve performance where it matters, and prevent the kind of partially-correct system understanding we just encountered.
