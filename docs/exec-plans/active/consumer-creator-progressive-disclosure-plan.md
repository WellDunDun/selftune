# Consumer / Creator Progressive Disclosure Plan

**Status:** Active  
**Date:** 2026-04-01  
**Owner:** Daniel Petro  
**Builds on:** external strategy docs that are not checked into this repo

## Purpose

Translate the 2026-04-01 strategy update into an implementation plan that fits the current selftune codebase, dashboard contract, and cloud rollout constraints.

The strategy is directionally correct:
- one product, not two products
- consumer value should be mostly invisible
- creator value should be comparison-first
- detail should be drill-down, not the landing page
- the long-term business is the creator ← user eval data pipeline

This plan adds the engineering constraints the strategy document does not capture explicitly.

It now also incorporates the new companion spec from the external strategy workspace:
- `contribute-pipeline-spec.md`

## Implementation Progress

Completed groundwork on 2026-04-01:
- creator-side `selftune.contribute.json` management
- end-user creator-directed contribution preferences
- per-skill preview of privacy-safe relay payloads
- shared creator-directed signal builder
- local SQLite staging for approved creator-directed signals during `sync`
- explicit `selftune contributions upload` relay flush for staged rows
- eval cold-start onboarding for installed skills (`--list-skills` readiness + `--auto-synthetic` fallback)
- bulk creator config scaffolding for installed skill suites (`selftune creator-contributions enable --all --prefix <prefix>`)
- cold-start architecture suspicion in `selftune eval family-overlap`, including installed-surface overlap and synthetic sibling-confusion probes
- replay-backed routing validation scaffolding with persisted validation provenance and skill-report provenance badges

Still pending:
- creator aggregate analytics surface
- proposal generation from contributor aggregates

## Next Up

Immediate next steps, in order:

1. **State Change creator eval onboarding**
   - Follow-on polish only: cold-start onboarding is already in place, and `family-overlap` now flags early architecture suspicion before trusted telemetry converges.
   - Next refinement is tuning static-signal thresholds from real creator sessions.

1. **Cloud relay ingest**
   - Completed in the cloud repo: the creator-directed relay ingest path now matches `selftune contributions upload` and stays separate from alpha upload canonical push.

1. **Creator community analytics**
   - Continue validating the new aggregate/community layer against real relay data.
   - Do not mix creator-community signals into local trust metrics.

1. **Aggregate proposal generation**
   - Validate proposal quality and thresholding now that relay ingest and aggregate reads are live.

## Strategy Review

### What is correct

1. **Progressive disclosure is the right product model.**
   The current repo already has the right primitive split:
   - CLI surfaces for low-friction status
   - overview page for multi-skill supervision
   - per-skill report for drill-down

2. **The overview should become comparison-first.**
   The present [Overview.tsx](../../../apps/local-dashboard/src/pages/Overview.tsx) is still supervision-heavy. That is useful, but it is not yet the creator landing page Ray described.

3. **Consumers should not need the dashboard.**
   The current [status.ts](../../../cli/selftune/status.ts) is the right place to deliver “seen and not heard” value.

4. **The creator-to-user eval pipeline is the moat.**
   This aligns with:
   - [alpha-rollout-data-loop-plan.md](./alpha-rollout-data-loop-plan.md)
   - [deterministic-routing-validation.md](./deterministic-routing-validation.md)

### Newly completed on this branch

1. **Cold-start architecture suspicion now exists in OSS.**
   The repo no longer waits exclusively on trusted live overlap counts before flagging sibling-family packaging problems.

2. **Replay provenance is now a first-class product concept.**
   Routing validation can persist and surface whether a proposal was replay-validated, judge-validated, or only passed structural guards.

### What needs adjustment

1. **“Confidence” cannot be treated as a universal trust number yet.**
   In the current DB, confidence coverage is incomplete and varies by ingest path. The creator grid can show confidence, but only when coverage is high enough and the label is explicit:
   - use `routing confidence`
   - suppress or soften the metric when confidence coverage is weak

2. **The overview and skill report must share the same trust model.**
   This is now partly fixed in code, but it needs to be treated as a formal invariant going forward.

3. **“Watched skills” is not yet a first-class concept.**
   Ray’s “these are the ten I care about” mental model is right, but the repo does not currently have persistent watchlist/pinning state. Phase 1 should fake this with a derived default. Phase 2 can add explicit watchlist persistence.

4. **The cloud eval pipeline is not ready for product promises yet.**
   Alpha upload is still blocked by the cloud V2 API mismatch tracked in:
   - [tech-debt-tracker.md](../tech-debt-tracker.md)

5. **The new contribution pipeline collides with the current `contribute` product surface.**
   In the current repo:
   - `selftune push` means user -> own cloud dashboard
   - `selftune contribute` means user -> community pool / anonymized export
   The new spec adds a third meaning:
   - end-user -> relay -> specific creator

   This is strategically coherent, but the command and documentation model will be confusing unless we explicitly split:
   - consumer contribution preferences
   - creator-side contribution enablement
   - existing community contribution/export

## Product Principles

1. **One trust model, three surfaces**
   - consumer CLI summary
   - creator comparison grid
   - creator drill-down report

2. **Numbers first, explanation second**
   - comparison surfaces should lead with metrics
   - detail pages can carry narrative and evidence

3. **Real usage first**
   - internal selftune eval traffic never masquerades as ordinary usage
   - repaired history must be labeled when surfaced

4. **No product bifurcation**
   - no separate consumer app
   - no separate creator app
   - only different defaults and density levels

5. **One data plane, multiple contribution modes**
   - SQLite-first local runtime remains the foundation
   - alpha upload / cloud push remains the generic remote transport
   - creator-directed contribution is a product layer on top of the cloud relay, not a separate telemetry stack

## Workstreams

### Workstream A: Shared Trust Model Foundation

**Goal:** keep CLI, overview, skill report, and later cloud analytics on one vocabulary.

**Tasks**
- Extract the current trust computation rules from [skill-report.ts](../../../cli/selftune/routes/skill-report.ts) and [queries.ts](../../../cli/selftune/localdb/queries.ts) into shared helpers.
- Make `overview`, `status`, and per-skill report consume the same:
  - operational observation filtering
  - legacy exclusion rules
  - repaired-history handling
  - dedupe rules for “previously missed” cases
- Add focused tests that lock this invariant for a sample skill like `Art`.

**Files**
- [cli/selftune/localdb/queries.ts](../../../cli/selftune/localdb/queries.ts)
- [cli/selftune/routes/overview.ts](../../../cli/selftune/routes/overview.ts)
- [cli/selftune/routes/skill-report.ts](../../../cli/selftune/routes/skill-report.ts)
- [cli/selftune/status.ts](../../../cli/selftune/status.ts)
- [cli/selftune/dashboard-contract.ts](../../../cli/selftune/dashboard-contract.ts)

**Exit criteria**
- A skill cannot appear “at risk” in overview and “healthy” in detail unless the UI explicitly says the two views answer different questions.
- `status`, overview, and skill report agree on core counts for the same trusted working set.

### Workstream B: Consumer Surface

**Goal:** make the default selftune experience useful without opening the dashboard.

**Scope**
- rewrite `selftune status` to a short, agent-friendly summary line first
- keep detailed output available below or behind a verbose mode
- add a weekly summary mechanism driven by existing scheduling/orchestration, not a separate notification system

**Tasks**
- Redesign [status.ts](../../../cli/selftune/status.ts) output so the first line answers:
  - how many skills are being watched
  - how many improved recently
  - whether anything needs attention
- Add a consumer-first summary string that agents can quote directly.
- Add optional weekly summary output from the orchestrate/schedule path rather than OS-native notification complexity in v1.
- Document the new consumer flow in:
  - [skill/workflows/Initialize.md](../../../skill/workflows/Initialize.md)
  - [skill/workflows/Orchestrate.md](../../../skill/workflows/Orchestrate.md)
  - [skill/workflows/Dashboard.md](../../../skill/workflows/Dashboard.md)

**Non-goals**
- native desktop notifications
- a consumer-only dashboard mode

**Exit criteria**
- a first-time user can understand value from `init -> sync -> status` without touching the dashboard
- the status output is short enough for an agent to relay naturally

### Workstream C: Creator Landing Page

**Goal:** make overview a comparison-first creator surface.

**Scope**
- replace “supervision dashboard first” with “skill comparison grid first”
- keep supervision as a secondary module, not the hero

**Required columns**
- skill name
- trigger rate
- routing confidence
- sessions watched
- last evolution
- status

**Important metric rules**
- `trigger rate` must use trusted operational observations
- `routing confidence` must be hidden or visibly caveated when confidence coverage is weak
- `status` must use the shared trust model from Workstream A

**Tasks**
- Add a comparison-grid section to [Overview.tsx](../../../apps/local-dashboard/src/pages/Overview.tsx) and corresponding API support in [overview.ts](../../../cli/selftune/routes/overview.ts).
- Decide an initial `Watching` subset:
  - Phase 1: derive from at-risk/improving/uncertain plus recent creator interest
  - Phase 2: persist a user-managed watchlist
- Demote the current attention/supervision feed below the comparison surface.
- Keep drill-down clicks routing to `/skills/:name`.

**Files**
- [apps/local-dashboard/src/pages/Overview.tsx](../../../apps/local-dashboard/src/pages/Overview.tsx)
- [cli/selftune/routes/overview.ts](../../../cli/selftune/routes/overview.ts)
- [cli/selftune/dashboard-contract.ts](../../../cli/selftune/dashboard-contract.ts)

**Exit criteria**
- overview first screen answers “which skills need my attention and which are doing well?”
- the page is scannable without opening a single detail page

### Workstream D: Skill Detail Compression

**Goal:** keep the existing trust-first detail page, but make it feel like Layer 3 of the creator experience.

**Tasks**
- Keep current sections, but tune the page for drill-down:
  - big metrics at top
  - prompt evidence
  - evolution evidence
  - FAQ/help
- Make education/support content progressively disclosed:
  - keep the `How this works` entry point
  - auto-collapse or reduce onboarding density after first exposure
- Ensure the detail page always answers:
  - what happened
  - what changed
  - should I act

**Files**
- [apps/local-dashboard/src/pages/SkillReport.tsx](../../../apps/local-dashboard/src/pages/SkillReport.tsx)
- [apps/local-dashboard/src/components/skill-report-panels.tsx](../../../apps/local-dashboard/src/components/skill-report-panels.tsx)
- [packages/ui/src/components/EvidenceViewer.tsx](../../../packages/ui/src/components/EvidenceViewer.tsx)

**Exit criteria**
- detail page feels like a drill-down from the comparison grid, not a separate product
- `observed` never reads as `healthy`

### Workstream E: Creator ← User Eval Pipeline

**Goal:** prepare the business-critical data loop without overpromising it in the near term.

**Dependencies**
- cloud alpha upload V2 API compatibility
- stable canonical push payload acceptance
- clear provenance for replay-validated vs judge-validated evidence

**New constraints from the contribution spec**
- no raw prompt content in the creator-facing contribution schema
- static creator config, not executable creator code
- privacy model enforced at the relay, not by creator tooling
- end-user opt-in must be post-value and per-skill
- creator analytics must distinguish:
  - creator's own local evidence
  - contributor aggregate evidence
  - replay-validated / judge-validated proposal confidence

**Tasks**
- Fix the cloud-side alpha-upload payload mismatch tracked in [tech-debt-tracker.md](../tech-debt-tracker.md).
- Continue the replay-based validation plan from [deterministic-routing-validation.md](./deterministic-routing-validation.md).
- Define the creator-facing cloud analytics contract:
  - creator-owned skills
  - user aggregate trigger/miss signals
  - privacy-safe provenance
- Define the relay contribution contract so it composes with existing push infrastructure rather than bypassing it.
- Add a product naming decision before implementation begins:
  - preserve `selftune contribute` for community contribution and introduce a new creator-directed command surface, or
  - explicitly migrate/rename the current community contribution feature
- Define the local data model additions for contribution consent/preferences and creator-contribution config discovery.

**Non-goal for current sprint**
- shipping the full marketplace/team eval pipeline

**Required design decisions before coding**
1. Command surface split
   - recommended: keep current `selftune contribute` semantics for community export compatibility
   - introduce separate end-user consent and creator config commands for the creator-directed relay pipeline
2. Config discovery model
   - how `selftune.contribute.json` is discovered from installed skills
   - how multiple installed skills request contribution independently
3. Cloud boundary
   - whether creator-directed contribution signals ride the current canonical push path or a distinct relay ingest contract
4. Privacy/audit model
   - what is stored locally
   - what is queued for upload
   - what is retained in relay storage

### Workstream F: Contribution Pipeline Productization

**Goal:** turn the new contribution spec into an implementable product slice without collapsing existing `push` and `contribute` semantics.

**Scope**
- creator-side configuration and packaging
- end-user opt-in/preferences
- local signal preparation
- relay-facing contract definition
- creator dashboard integration planning

**Tasks**
- Define the v1 command map.
  Recommended shape:
  - keep `selftune push` for user -> own dashboard
  - keep current `selftune contribute` for community/export until migrated deliberately
  - introduce a separate surface for creator-directed sharing, e.g. `selftune contributions` for end-user preferences and `selftune creator-contributions` or equivalent for creator-side setup
- Add workflow/doc propagation requirements for the new commands and config:
  - `skill/SKILL.md`
  - `skill/workflows/Contribute.md` or split workflow docs
  - `README.md`
  - `docs/design-docs/alpha-remote-data-contract.md`
- Define `selftune.contribute.json` ownership and validation rules in the OSS repo.
- Specify how local classifier outputs map onto a relay-safe schema and how that differs from existing `ContributionBundle`.
- Design the creator dashboard "Community" layer as a separate evidence source, not mixed into local trust metrics.

**Exit criteria**
- there is no ambiguity about the difference between:
  - personal cloud push
  - community contribution
  - creator-directed contribution
- the new creator-directed pipeline can be built without breaking existing alpha upload or community contribution behavior

### Workstream G: Alpha Operations

**Goal:** turn the strategy’s human tasks into explicit product feedback loops.

**Tasks**
- Pair with Ray on SC skills using the creator comparison view, not the old detail-heavy dashboard.
- Capture the exact ten-skill “watching” list mental model during the session.
- Onboard Robert as a second creator alpha after the comparison view and status line are stable.
- Convert the findings into:
  - dashboard tweaks
  - CLI wording tweaks
  - trust-model adjustments

## Sequence

### Phase 1: Trust + Consumer Surface

- Workstream A
- Workstream B

### Phase 2: Creator Landing Page

- Workstream C
- Workstream D

### Phase 3: Cloud Data Loop Foundation

- Workstream E
- Workstream F

### Phase 4: Alpha Validation

- Workstream G

## Immediate Implementation Priorities

1. **Unify command semantics before adding new pipeline UI**
   - decide the naming split for creator-directed contribution vs existing `contribute`
   - update repo docs accordingly before implementation spreads

1. **Keep alpha upload as the transport foundation**
   - creator-directed contribution should build on the cloud relay / upload architecture already being established
   - do not create a second unrelated remote ingest stack

1. **Keep creator contribution data separate from local trust**
   - local skill health remains grounded in the creator/user's own trusted operational observations
   - contributor aggregate data should augment creator decision-making, not silently alter local trust scores

1. **Land the comparison-first creator overview before community analytics**
   - the creator landing page still needs to be comparison-first even before the full contribution pipeline ships

## Acceptance Criteria

1. **Consumer success**
   - a user can install selftune, ignore the dashboard, and still see value in `status`

1. **Creator success**
   - a creator can compare skills in one screen before drilling down

1. **Trust consistency**
   - overview, skill detail, and CLI status do not disagree about core health semantics

1. **Business readiness**
   - the repo is structurally ready for the creator ← user eval pipeline, even if the cloud portion is not fully launched yet

1. **Contribution clarity**
- the product has a clear, non-conflicting story for:
  - push
  - community contribution
  - creator-directed contribution

## Immediate Next Actions

1. Land the shared trust-model helper extraction.
2. Redesign `selftune status` around a single summary line plus compact secondary detail.
3. Replace overview’s current hero-first layout with a comparison-first creator grid.
4. Use the Ray pairing session to validate:
   - column choice
   - watchlist concept
   - acceptable confidence labeling
