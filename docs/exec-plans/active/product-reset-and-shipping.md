# Execution Plan: Product Reset and Shipping Priorities

<!-- Verified: 2026-03-14 -->

**Status:** Active  
**Created:** 2026-03-12  
**Goal:** Align selftune around the actual post-merge architecture and the shortest credible path to a fast, trustworthy, shippable product.

---

## Executive Summary

selftune is no longer blocked by telemetry architecture. It is now blocked by **product shape and UX**.

Recent merged work changed the baseline:

- `#38` hardened source-truth telemetry and repair paths
- `#39` merged the local dashboard SPA
- `#40` added the first orchestrator core loop
- `#41` made generic scheduling the primary posture and OpenClaw cron optional
- `#42` added a local SQLite materialization layer
- `#43` improved sync progress and tightened noisy query filtering
- `#44` removed the legacy dashboard runtime and made the SPA/server path authoritative

That means the next phase should optimize for:

1. **Trustworthy source-truth sync**
2. **A fast, demoable local app on top of materialized local data**
3. **A clear orchestrated loop that evolves, validates, and watches skills**

The architecture does not need a rewrite. It needs a narrower product story and a better local user experience.

---

## What Changed Since The Earlier Audit

The earlier architecture audit was directionally right about pruning, orchestration, and avoiding over-scoping. It is now outdated in two areas:

### 1. SQLite is now justified

Earlier guidance argued against SQLite. That was reasonable when the local UX still looked like a lightweight HTML dashboard.

It is no longer reasonable after real-machine proof showed:

- slow cold dashboard loads
- heavy client-side data flow
- poor drilldown UX on realistic datasets

The right model is now:

- JSONL stays source of truth
- SQLite becomes the indexed local view store
- the local app should consume SQLite/materialized queries

### 2. Cloud/export work is now part of the product path

Canonical export and cloud ingest are no longer speculative. We already proved:

- local canonical export works on real source-truth data
- a real `PushPayloadV2` can be generated
- cloud ingest accepts that payload end to end

So cloud/local alignment now belongs in the main product path.

---

## Current First Principles

selftune still does one thing:

**make agent skills improve from real usage data**

The core loop remains:

1. **Observe** — ingest source-truth logs/transcripts
2. **Detect** — identify missed triggers, failures, regressions
3. **Fix** — propose and validate improvements
4. **Ship** — deploy and monitor safely

The most important architectural clarification is:

- **hooks are hints**
- **transcripts/logs are truth**

That should govern future product work.

---

## Updated Priority Stack

## Priority 1: Trustworthy Local Data Model

Keep making source-truth sync the authority.

Includes:

- transcript/rollout replay correctness
- repaired usage overlays
- provenance and scope classification
- polluted query cleanup
- sync transparency and safe incrementalism

## Priority 2: Demoable Local Product

Make the local app fast and believable.

Includes:

- SQLite materialization
- SPA overview and skill report UX
- clear loading/empty/error states
- making the new local app the default path

## Priority 3: Orchestrated Skill Improvement

Make the closed loop obvious and usable.

Includes:

- orchestrator refinement
- generic scheduling
- evolve/watch safety and explainability

## Priority 4: Release And Ship

Includes:

- published package proof
- install and upgrade path
- quickstart/demo path
- stable docs/help

## Priority 5: Paperclip And Multi-Repo Iteration

Paperclip should accelerate iteration, not become the product priority.

---

## Current Recommendations

## Remaining Product Gaps

These are the highest-confidence gaps still blocking adoption and confident shipping:

### 1. The local UX still needs product polish

The SPA + SQLite path is now the supported default, but the experience still needs latency work, drilldown polish, and stronger route/report coherence before it feels fully ready for broader adoption.

### 2. The autonomous loop is not yet obvious and trustworthy

The orchestrator exists, but the product does not yet feel like a safe, comprehensible “turn this on and it improves my skills” system.

### 3. Evolution is still under-triggering in practice

We can prove skill usage and at least one real successful evolution, but the system still does not yet feel like it consistently turns real usage into useful proposed improvements across many skills.

### 4. Query and environment pollution still distort the signal

Polluted host environments still make status and unmatched-query outputs harder to trust than they should be.

### 5. Local/cloud product contracts are not fully stabilized

We proved OSS export -> cloud ingest, but the actual user-facing payload contracts for overview/report views still need to be made explicit and aligned.

### 6. The default story is still too broad

The product still presents too much surface area for a first-time user instead of one tight loop.

### 7. The release path still needs one clean published-package proof

Branch code has been proven on a real machine; the final “published install behaves the same way” proof still needs to happen.

---

## Current Recommendations

### 1. Make the SPA the real default dashboard path

Once the SQLite-backed local app is credible, stop treating it as sidecar UI.

### 2. Stabilize payload contracts for local/cloud dashboards

Define and align:

- `OverviewPayload`
- `SkillReportPayload`

Local should produce them from JSONL + SQLite/materialized queries.  
Cloud should produce them from canonical ingest + DB projections.

### 3. Keep reducing remaining unknown provenance

Unknown provenance is much lower than before, but not zero. Continue tightening:

- Claude repair path recovery
- scope/project/global/admin detection

### 4. Make orchestrator output explainable

If the system evolves or refuses to evolve a skill, the user should see why immediately.

### 5. Reduce the shipping surface in docs/help

Not by deleting code, but by making the main story smaller and easier to follow:

- `sync`
- `status`
- local app
- `evolve`
- `watch`
- orchestrator
- `doctor`

---

## Things We Should Not Do Right Now

1. **Do not return to hooks as the primary truth source**
2. **Do not spend another cycle optimizing the old static dashboard path**
3. **Do not make OpenClaw-specific automation the main story again**
4. **Do not do broad CLI regrouping before the local app and orchestrator feel good**
5. **Do not overinvest in Paperclip/platform setup at the expense of product proof**

---

## Updated 1.0 Path

### Phase 1

- source-truth sync remains correct and explainable
- query/provenance cleanup lands
- local SQLite/materialization path is stable

### Phase 2

- SPA overview and skill report become the default local UX
- the local app is fast on real-machine datasets

### Phase 3

- orchestrator becomes the main autonomous loop entry point
- generic scheduling path is documented and stable

### Phase 4

- package release / install proof
- cloud/local payload alignment
- GTM/demo narrative based on the actual product loop

---

## Final Assessment

The key shift is simple:

- telemetry correctness is good enough to build on
- the local app is now the highest-leverage product bottleneck
- orchestration is the next core integration layer
- shipping selftune means making the product feel fast, obvious, and trustworthy on a real machine

That is the current architecture priority.
