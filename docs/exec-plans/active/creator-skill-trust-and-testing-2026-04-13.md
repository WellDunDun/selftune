<!-- Verified: 2026-04-13 -->

# Execution Plan: Creator Skill Trust And Testing

**Status:** Active  
**Created:** 2026-04-13  
**Goal:** Make selftune easier for skill creators to trust, test, and learn from by narrowing the next phase around skill testing, runtime observability, and creator guidance rather than broader authoring-platform expansion.

## Executive Summary

Creator feedback is converging on three needs:

1. they need a reliable way to test skills
2. they need runtime observability they can actually trust
3. they need help understanding how to structure good skills

selftune already has much of the underlying machinery:

- `selftune eval generate`
- `selftune eval unit-test`
- `selftune eval composability`
- `selftune eval family-overlap`
- `selftune evolve`
- `selftune evolve body --target body|routing`
- replay-backed validation for description, body, and routing targets

What it does **not** yet have is a productized creator workflow that makes those
pieces feel like one coherent system.

This plan narrows the next phase accordingly:

1. make skill testing first-class
2. make runtime trust legible
3. make creator guidance part of the shipped product

It explicitly does **not** open a generalized full-directory evolution program.

## Inputs

- [post-stabilization-creator-adoption-plan.md](../deferred/post-stabilization-creator-adoption-plan.md)
- [advanced-skill-patterns-adoption.md](../deferred/advanced-skill-patterns-adoption.md)
- [consumer-creator-progressive-disclosure-plan.md](./consumer-creator-progressive-disclosure-plan.md)
- [product-reset-and-shipping.md](./product-reset-and-shipping.md)
- [state-change-skills-call-2026-04-09-insights.md](../reference/state-change-skills-call-2026-04-09-insights.md)

## Scope Inheritance

This plan now owns the unfinished creator-facing work that was originally framed in:

- [post-stabilization-creator-adoption-plan.md](../deferred/post-stabilization-creator-adoption-plan.md)

Specifically, this active plan should be treated as the execution tracker for:

- the remaining routing-first proof slice / demo recipe
- any missing example-backed creator assets
- any residual authoring-boundary clarification still needed after the shipped docs pass

## Current State

### Progress update (2026-04-13)

The first creator-facing slice of this plan is now shipped:

- OSS typecheck is clean again
- the local dashboard, skill report, and `selftune status` now distinguish:
  - blocked on testing
  - ready to deploy
  - already deployed and under watch
- public docs now include an explicit create -> test -> deploy guide aligned to the Agent Skills spec and authoring best practices
- shipped creator docs now teach deploy/watch as part of the trust loop instead of stopping at dry-run + baseline

### Already real in code

- CLI registration for testing/evolution flows in `cli/selftune/index.ts`
- body and routing evolution in `cli/selftune/evolution/evolve-body.ts`
- replay-backed validation in:
  - `cli/selftune/evolution/validate-body.ts`
  - `cli/selftune/evolution/validate-routing.ts`
  - `cli/selftune/evolution/validate-host-replay.ts`
- unit-test generation and execution in `cli/selftune/eval/unit-test-cli.ts`
- composability and family-overlap analysis in `cli/selftune/eval/`
- trust/report surfaces across:
  - `cli/selftune/routes/skill-report.ts`
  - `apps/local-dashboard/src/pages/Overview.tsx`
  - `apps/local-dashboard/src/pages/SkillReport.tsx`

### Not yet productized

- one crisp answer to “how do I test my skill?”
- one creator-facing trust story across CLI, overview, and drill-down
- one creator-facing explanation of description vs routing vs body vs code
- a routing-first proof slice that is easy to demo and hard to misinterpret

### Remaining gaps after the first shipped slice

- a maintainers' routing-first demo/proof asset still needs to be packaged explicitly
- the `skill/examples/` layer envisioned in the older deferred plan still does not exist
- authoring-boundary guidance is much better, but may still deserve a small dedicated note if maintainers keep seeing confusion

### Not in scope for this plan

- generalized evolution of arbitrary files across `scripts/`, `references/`, `assets/`, and config
- reopening local dashboard serving work already tracked elsewhere
- cloud ingest/idempotency fixes already being handled in parallel workstreams

## Product Principles

1. **Testing before mutation**
   - creators should be able to test a skill before trusting autonomous evolution

2. **Runtime trust over generic observability**
   - the product should answer whether the right skill fired and whether a change helped

3. **Routing-first teaching**
   - routing remains the fastest proof of value and the easiest thing to explain

4. **Creator guidance is product work**
   - examples, playbooks, and authoring boundaries are part of the shipped system

5. **No premature authoring-platform expansion**
   - do not broaden into full-directory evolution until the current system is easier to teach and trust

## Workstream A: First-Class Skill Testing

**Goal:** make “test this skill” the default creator workflow, not an expert-only command set.

### Problems

- evals, unit tests, replay validation, and baseline comparisons exist but do not read as one connected system
- creators do not have one short, reliable path from “I wrote a skill” to “I trust this skill”
- testing expectations are still too implicit for first-time creators

### Deliverables

1. A canonical creator test loop:
   - `eval generate`
   - `eval unit-test`
   - optional `grade baseline`
   - then `evolve` / `watch`

2. A “skill test readiness” surface that makes clear:
   - whether eval coverage exists
   - whether unit tests exist
   - whether replay validation is available
   - whether the skill is still cold-start only

3. Tighter docs and examples for when to use:
   - eval generation
   - unit tests
   - composability
   - family-overlap
   - baseline

4. CI coverage for the creator-critical testing path.

### Primary files

- `cli/selftune/index.ts`
- `cli/selftune/eval/hooks-to-evals.ts`
- `cli/selftune/eval/unit-test-cli.ts`
- `cli/selftune/eval/unit-test.ts`
- `cli/selftune/grade.ts` and/or baseline-related grading entrypoints
- `skill/workflows/Evals.md`
- `skill/workflows/Evolve.md`
- `skill/workflows/EvolveBody.md`
- `README.md`

### Exit criteria

- a creator can answer “how do I test my skill?” with one short workflow
- the product can distinguish “no evals,” “has tests,” and “replay-validated” clearly
- the recommended creator loop is visible in both CLI help and workflow docs

## Workstream B: Runtime Trust And Observability

**Goal:** turn selftune’s strongest value into a clearer creator-facing product surface.

### Problems

- trigger rate, routing confidence, coverage, validation mode, and watch outcomes are useful but still fragmented
- some surfaces are richer than others, which makes trust harder to explain
- routing confidence can still be misunderstood as a universal quality score

### Deliverables

1. One creator trust vocabulary across:
   - CLI summary
   - overview / comparison surfaces
   - per-skill drill-down

2. Clear metric semantics for:
   - trigger rate
   - routing confidence
   - confidence coverage
   - validation mode
   - replay provenance
   - watch / rollback status

3. A routing-first proof slice for demos and onboarding:
   - no-skill baseline
   - current skill behavior
   - improved routing / evolution result

4. Explicit caveats when confidence/coverage are weak.

### Primary files

- `cli/selftune/routes/overview.ts`
- `cli/selftune/routes/skill-report.ts`
- `cli/selftune/status.ts`
- `cli/selftune/dashboard-contract.ts`
- `apps/local-dashboard/src/pages/Overview.tsx`
- `apps/local-dashboard/src/pages/SkillReport.tsx`
- `tests/autonomy-proof.test.ts`
- `tests/evolution/*`

### Exit criteria

- the same skill does not tell contradictory trust stories across product surfaces without explicit explanation
- replay-vs-judge provenance is visible enough for creators to understand what evidence they are looking at
- maintainers can demo the product in a routing-first story without hand-waving

## Workstream C: Creator Guidance As Product

**Goal:** make good skill authoring easier to learn.

### Problems

- creators still do not have one crisp answer for description vs routing vs body vs code
- examples are thinner than they should be for a creator-facing agent-first product
- current knowledge is too concentrated in maintainer intuition and code familiarity

### Deliverables

1. A creator playbook covering:
   - description vs routing vs body
   - when to move logic into tools/scripts
   - what belongs in references/examples/assets
   - when to use body evolution vs routing evolution vs description evolution

2. Example-backed guidance showing:
   - routing-first skill structure
   - how to interpret test/eval outputs
   - with-skill vs no-skill testing
   - how to respond to composability/family-overlap warnings

3. A simpler creator-facing framing:
   skills are easy to author, hard to test, and hard to trust at runtime.

### Primary files

- `skill/SKILL.md`
- `skill/workflows/*.md`
- `skill/references/`
- `README.md`
- optionally a new creator-facing reference note under `docs/`

### Exit criteria

- a new creator can answer “what belongs where?” without reverse-engineering the repo
- docs and examples teach the shipped system, not aspirational future behavior

## Sequencing

1. **Workstream A first**
   - testing is the most immediate creator pain and the prerequisite for trustworthy evolution

2. **Workstream B second**
   - observability becomes much more useful once the testing story is coherent

3. **Workstream C third, with partial overlap**
   - guidance should codify what is actually working, not run ahead of it

## Explicit Non-Goals

Do **not** use this plan to justify:

- generalized full-directory autonomous mutation
- a broad authoring SDK/platform rewrite
- new top-level command families
- duplicating active work on ingest correctness or local dashboard serving

## Success Criteria

1. A creator can install selftune and understand the main loop in terms of:
   - test
   - observe
   - improve
   - watch

2. A creator can understand whether a skill is trustworthy at runtime without reading raw tables.

3. Maintainers can show selftune in a short routing-first demo that emphasizes testing and trust, not only mutation.

4. selftune remains narrow enough that it still reads as a runtime skill-trust product rather than a generic creator platform.
