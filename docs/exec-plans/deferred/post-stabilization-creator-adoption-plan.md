<!-- Verified: 2026-04-13 -->

# Execution Plan: Post-Stabilization Creator Adoption

**Status:** Partially completed / superseded  
**Created:** 2026-04-09  
**Goal:** Turn the 2026-04-09 skills-call insights into a concrete follow-on program that improves selftune's creator guidance, routing-first proof, and basic packaging/discoverability without overlapping the stabilization and convergence work already in progress.

## Status Update

This plan is no longer a clean "planned" future state.

As of 2026-04-13:

- much of **Workstream A** has effectively shipped via the creator trust/testing work:
  - creator playbook updates
  - public create -> test -> deploy guidance
  - clearer router/workflow/reference/script boundaries
- much of **Workstream C** has also effectively shipped:
  - sharper README/install positioning
  - clearer creator-loop framing
  - better packaging/discoverability guidance in public docs

The remaining unfinished work is:

- the **routing-first proof slice** from Workstream B
- the missing `skill/examples/` style example layer from Workstream A
- any small residual authoring-boundary cleanup from Workstream D

That remaining scope is now better tracked by:

- [creator-skill-trust-and-testing-2026-04-13.md](../active/creator-skill-trust-and-testing-2026-04-13.md)

This document remains useful as the original strategy framing, but it should no
longer be treated as the primary execution tracker.

## Executive Summary

The 2026-04-09 State Change skills call exposed an important distinction:
selftune's biggest near-term opportunity is not more architecture breadth. It
is making the current system easier to trust, easier to learn from, and easier
to try.

The current active plans already own the shipped-surface truth work:

- `docs/exec-plans/active/eval-system-gap-closure.md`
- `docs/exec-plans/active/repo-convergence-refactor-program.md`

This plan therefore starts only after those plans clear their stabilization
gates. Once that happens, the next high-leverage program is:

1. package the creator playbook and examples
2. ship a routing-first proof slice
3. repair the basic packaging/discoverability path
4. document the authoring boundary more clearly if it is still needed after the first three items

This is a productization plan, not a core-runtime rewrite.

## Inputs

- `docs/exec-plans/reference/state-change-skills-call-2026-04-09-insights.md`
- `docs/exec-plans/active/eval-system-gap-closure.md`
- `docs/exec-plans/active/repo-convergence-refactor-program.md`
- `docs/exec-plans/deferred/advanced-skill-patterns-adoption.md`
- broader skill-authoring best-practice material referenced in the call
- `README.md`
- `ROADMAP.md`

## Dependency Gate

This plan should not move from "planned" to active execution until the current
stabilization wave is complete.

### Required exit criteria from the active wave

1. Replay-backed description validation is reachable from the real public
   `evolve` and/or `orchestrate` path, or the docs stop claiming that it is.
2. Replay-backed validation preserves the provenance needed by audit,
   evidence, and Pareto selection.
3. `watch` compares the deployment baseline it claims to compare.
4. `watch` docs, flags, and CLI parsing match.
5. `eval generate --blend` has explicit cold-start behavior and cannot silently
   emit an empty result.
6. The public runtime story is narrowed enough that `orchestrate` is clearly
   the canonical "make the system better" path.

### Why this gate exists

If selftune starts producing creator guidance and demos before the public
surface is truthful, the guidance will encode drift instead of reducing it.

## Non-Goals

- Do not add new top-level CLI commands in this plan.
- Do not reopen replay-vs-judge architecture debates owned by the active wave.
- Do not build the full personalization SDK in this plan.
- Do not create a second competing public story next to `orchestrate`.
- Do not add feature surface just to make demos look broader.

## Workstream A: Creator Playbook And Examples

**Goal:** turn current selftune practice into explicit, reusable creator
guidance.

### Problems to solve

- creators do not have one crisp answer for router vs workflow vs reference vs script
- file-splitting triggers are still mostly implicit
- "deterministic code vs skill prompt" is understood by maintainers, but not yet
  taught as a first-class system

### Primary files

- `skill/SKILL.md`
- `skill/workflows/*.md`
- `skill/examples/` (new)
- `docs/design-docs/` or `docs/exec-plans/reference/` for a creator-patterns note
- `README.md`

### Deliverables

1. A creator-facing reference doc that explains:
   - router-first structure
   - when to split into workflows
   - what belongs in references
   - when deterministic logic should move into code or CLI tools
2. A small `skill/examples/` layer showing:
   - routing-first skill shape
   - dry-run/evolve summary interpretation
   - with-skill vs without-skill test framing
3. Clear guidance that repeated mechanical work belongs in scripts/tools while
   judgment stays with the model.
4. Low-risk improvements already described in
   `advanced-skill-patterns-adoption.md`, especially examples and
   `${CLAUDE_SKILL_DIR}` portability, pulled forward if still relevant after the
   stabilization wave.
5. Guidance that explicitly compares repo-local practice with broader
   skill-authoring best practices, rather than presenting selftune's current
   structure as the only valid pattern.

### Success criteria

- a new creator can answer "what goes in the skill vs the tool?" from repo docs
  without reading implementation code
- examples reinforce the actual shipped flow, not aspirational behavior
- no new public runtime surface is required to teach these patterns

## Workstream B: Routing-First Proof Slice

**Goal:** package the strongest "aha" from the call into a reproducible proof.

### Problems to solve

- selftune is easier to understand when it proves routing selection before deep
  body evolution
- creators need a way to see progress without jumping directly into complex
  end-to-end evolution

### Primary files

- `tests/sandbox/`
- `tests/eval/`
- `tests/orchestrate.test.ts`
- `tests/orchestrate-overlap.test.ts`
- `tests/autonomy-proof.test.ts`
- `README.md`
- optionally `docs/design-docs/` for the benchmark description

### Deliverables

1. One benchmark/demo slice that compares:
   - no-skill baseline
   - current skill behavior
   - improved routing/description behavior
2. Output that makes the main value legible:
   - trigger selection
   - missed-trigger reduction
   - watchable post-deploy result
3. A repeatable fixture or test recipe that maintainers can run when showing
   selftune to creators.

### Notes

- this should bias toward routing/selection clarity, not maximum architecture
  coverage
- if body/routing evolution are both shown, selection must still be the first
  teaching frame

### Success criteria

- maintainers can demo selftune in one short routing-first story
- the demo does not depend on hand-wavy explanations about future behavior
- the proof slice is stable enough to support README, docs, or talks

## Workstream C: Basic Packaging And Discoverability Repair

**Goal:** make it easier for people to find selftune, understand what it is,
and install it correctly on first contact.

### Problems to solve

- at least one person in the call could not find or install selftune quickly
- selftune is still at risk of being interpreted as generic discoverability
  instead of runtime skill observability
- the install path, CLI-only path, and product positioning need tighter alignment

### Primary files

- `README.md`
- `llms.txt`
- public site/docs surfaces outside this plan if needed

### Deliverables

1. Sharper top-of-funnel copy around:
   - skill observability
   - routing/evolution/watch loop
   - why this is about skill runtime trust, not only traces or prompts
2. An unmistakable install path for:
   - skill install
   - CLI-only usage
3. Consistent phrasing across README, docs, and any public landing copy.
4. A short creator-oriented "why selftune exists" framing that matches the call:
   skills are easy to author, hard to test, and hard to trust at runtime.

### Success criteria

- a new reader can find the install command in seconds
- selftune's category is clearer after the first screenful
- selftune is not mistaken for a generic prompt or tracing tool

## Workstream D: Authoring Boundary Note

**Goal:** formalize the current working boundary between skill content and
deterministic tooling without overcommitting to a new platform surface.

### Problems to solve

- the repo still answers "what belongs where?" mostly through examples and
  maintainer intuition
- the call validated this authoring-boundary confusion, but not a broad SDK push

### Primary files

- one new reference or design note under `docs/`
- `skill/SKILL.md`
- `skill/workflows/*.md`

### Deliverables

1. A short note that distinguishes:
   - what belongs in the top-level skill router
   - what belongs in workflows and references
   - what should move into scripts, tools, or CLI code
2. Explicit examples from the current repo that show those boundaries in practice.
3. Open questions that remain unresolved, rather than inventing a premature API.

### Success criteria

- maintainers can discuss the authoring boundary concretely without inventing a
  premature SDK
- the note grows from the stabilized product surface, not from hypotheticals

## Sequencing

### Phase 0: Dependency closure

- wait for the active stabilization and convergence wave to clear its exit criteria

### Phase 1: Creator guidance

- run Workstream A first
- use it to sharpen the vocabulary and examples for the rest of the plan

### Phase 2: Proof slice

- run Workstream B after enough surface truth exists to demo honestly

### Phase 3: Positioning repair

- run Workstream C once the proof slice and creator language are concrete

### Phase 4: Authoring-boundary note

- run Workstream D last

## Recommended Ownership Split

### Track 1: Product truth and teaching

- creator playbook
- examples
- README positioning

### Track 2: Proof and fixture work

- routing-first demo
- repeatable benchmark/test recipe

### Track 3: Strategic design

- authoring-boundary note

## Success Criteria

This plan is complete when all of the following are true:

1. selftune has a creator-facing explanation of router/workflow/reference/tool
   boundaries that matches the shipped product.
2. selftune has a short, routing-first proof slice that maintainers can use in
   docs, demos, and calls.
3. install and positioning copy no longer make it hard to find or categorize
   the product.
4. the current authoring boundary is documented well enough to discuss
   deliberately, without inventing a premature SDK surface.

## Completion Snapshot

### Effectively completed

1. creator-facing explanation of router/workflow/reference/tool boundaries
2. install and positioning copy is substantially clearer than when this plan was written
3. creator-oriented framing around testing and runtime trust is now part of the shipped docs/product story

### Still incomplete

1. a short, routing-first proof slice that maintainers can use for demos, docs, and talks
2. the planned `skill/examples/` layer
3. any final dedicated authoring-boundary note if the currently shipped playbooks/references are still not enough

## Risks

### Risk 1: Starting too early

If this plan starts before the active stabilization wave is done, it will
document unstable behavior and amplify drift.

### Risk 2: Turning docs into a second product surface

Creator guidance should explain the canonical runtime path, not invent parallel
expert workflows.

### Risk 3: Over-rotating into creator-platform features

The call validated creator pain, but the immediate product value is still the
runtime observe/evaluate/evolve/watch loop. Any authoring-model note should stay
small and grounded in current behavior until the current product is more stable.

## Immediate Next Step

Do not activate this plan as a new execution track.

Instead:

1. treat this document as the original framing/reference
2. execute remaining creator-facing work in:
   - [creator-skill-trust-and-testing-2026-04-13.md](../active/creator-skill-trust-and-testing-2026-04-13.md)
3. close the remaining gap by shipping the routing-first proof slice and any missing example assets
