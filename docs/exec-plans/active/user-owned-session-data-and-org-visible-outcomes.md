# User-Owned Session Data And Org-Visible Outcomes

**Status:** Proposed  
**Date:** 2026-03-20

## Goal

Correct the cloud data model so raw session telemetry is private to the user by
default, while organization-visible data is limited to derived, reviewed, or
explicitly shared outcomes.

This fixes the current semantic mismatch:

- storage is org-scoped
- raw prompts and session telemetry are user-originated and sensitive
- product intent is personal learning first, shared skill outcomes second

## Product Rule

Raw session data belongs to a user by default.

Organization visibility should default to:

- aggregates
- alerts
- reviewed proposals
- deployed evolution outcomes
- explicitly promoted/shared exemplars

Organization visibility should **not** default to:

- raw prompt text
- full per-session telemetry
- raw execution facts
- raw invocation trails

## Why This Matters

The current alpha model stores canonical session-level facts with `org_id` as
the main ownership key. That is acceptable for single-user alpha orgs, but it
will become incorrect as soon as multiple humans share one org.

If left unchanged, the system will implicitly treat one user’s raw working
sessions as org-wide data. That is the wrong privacy and ownership default for
the product.

## Target Model

### Keep

- `org_id` as the tenancy boundary
- org-scoped skill namespace
- org-scoped derived dashboards and operator views
- one ingest pipeline and one cloud storage path

### Add

- direct user ownership on raw session-level canonical records
- explicit visibility state for raw/session-derived records where needed
- a clear split between private raw telemetry and shared derived outcomes

### Default Semantics

- raw session layer: user-owned, private by default
- derived outcomes layer: org-visible by default
- raw sharing: explicit opt-in, never implied by org membership alone

## Data Model Changes

### Session-Level Tables To Reclassify As User-Owned

These tables should keep `org_id` for tenancy partitioning, but they should no
longer be treated as org-owned data semantically:

- `raw_pushes`
- `canonical_sessions`
- `canonical_prompts`
- `canonical_skill_invocations`
- `canonical_execution_facts`
- `normalization_runs`
- `orchestrate_runs` when they reflect an individual user’s local run

### Tables That Can Stay Org-Visible By Default

- skill aggregates / trend summaries
- alerts
- proposals
- proposal review state
- deployed evolution outcomes
- body/description evolution audit summaries intended for the shared skill

### New Fields

Add the following as appropriate:

- `owner_user_id`
- `uploaded_by_user_id`
- `visibility`

Suggested semantics:

- `owner_user_id`: the human whose local session generated the raw data
- `uploaded_by_user_id`: the authenticated cloud user who sent the push
- `visibility`: `private`, `org_shared`, or `promoted`

In many cases `owner_user_id` and `uploaded_by_user_id` will be the same. They
should still be modeled separately because they mean different things.

## Access Model

### Private By Default

For raw/session-level endpoints:

- only the owner user should see their raw prompt/session data by default
- org admins should not automatically see raw prompts or session trails

### Org-Visible By Default

For derived operator/product surfaces:

- org members can see shared skill health
- org members can see org-level outcome metrics
- org members can see reviewed/deployed proposal outcomes

### Explicit Sharing

If a user wants to share raw evidence with the org:

- sharing must be explicit
- sharing should happen at the level of a promoted exemplar, reviewed proposal,
  or an intentionally shared session sample

## API And UI Changes

### Cloud API

Update cloud routes so they stop assuming org scope implies raw-data access.

Required changes:

- raw/session endpoints must filter by `owner_user_id`
- org-visible derived endpoints remain org-scoped
- add new endpoints or query modes for promoted/shared examples if needed

### Cloud UI

Update product copy to match the real privacy model.

Required changes:

- raw activity views should clearly say “your sessions”
- org dashboards should clearly say “team/shared outcomes”
- avoid any UI copy that implies raw prompt text is org-visible by default

## Migration Plan

### Phase 0: Freeze Semantics

**Goal:** stop making the current org-owned interpretation stronger.

Actions:

- stop adding new product surfaces that expose raw session data org-wide
- stop documenting raw session telemetry as org-owned

Completion:

- docs and new code stop reinforcing the wrong default

### Phase 1: Add Ownership Fields

**Goal:** make raw ownership explicit in storage.

Actions:

- add `owner_user_id` to raw/session canonical tables
- add `uploaded_by_user_id` where useful for auditability
- add `visibility` only where the record may later be shared/promoted

Backfill:

- derive `uploaded_by_user_id` from `raw_pushes.user_id`
- derive `owner_user_id` initially from the same source for current alpha data

Completion:

- every raw/session canonical row can be attributed to a user

### Phase 2: Change Read Paths

**Goal:** enforce the new default semantics in the product.

Actions:

- update API routes to filter raw/session data by owner
- keep org filters for derived/aggregate routes
- add targeted joins where raw data must be traced back through `push_id`

Completion:

- no raw/session route leaks other users’ data by org membership alone

### Phase 3: Separate Shared Outcomes From Raw Inputs

**Goal:** make the shared layer explicit.

Actions:

- identify which current surfaces are raw-input views vs derived-outcome views
- move org-facing dashboards to derived models where needed
- add a promoted/shared exemplar path for intentionally shared evidence

Completion:

- org-visible surfaces are clearly derived or explicitly shared

### Phase 4: Update Agent And Operator Docs

**Goal:** make the product explanation honest.

Files to update:

- `docs/operator-guide.md`
- `docs/design-docs/system-overview.md`
- any cloud-side privacy or alpha onboarding docs

Completion:

- docs clearly distinguish private raw telemetry from shared outcomes

## Implementation Notes

### Keep `org_id`

This plan does **not** remove `org_id`.

`org_id` is still the correct key for:

- tenancy partitioning
- billing/workspace membership
- shared skill namespace
- org-level derived analytics

The fix is to stop treating `org_id` as the only ownership key for raw session
telemetry.

### Do Not Block Current Alpha Upload

The current ingest pipeline is already working. The fix should not require a
parallel ingest system or a rewrite of the push payload contract.

Preferred approach:

- keep ingest as-is
- add ownership fields and backfill
- tighten read paths
- then refactor dashboards and derived tables

## Acceptance Criteria

- raw session-level canonical rows have explicit user ownership
- raw session/prompt data is private to the owner by default
- org-visible dashboards and outcomes continue to work
- no org-wide raw prompt access exists by default
- derived evolution outcomes remain org-visible
- current alpha ingest path remains operational throughout the migration

## Recommended Order

1. Freeze semantics and docs
2. Add ownership fields and backfill
3. Tighten API read paths
4. Separate derived/shared surfaces from raw views
5. Update operator and product docs

## Non-Goals

- changing the local CLI upload contract right now
- redesigning the alpha bootstrap/auth flow
- deleting `org_id` from canonical storage
- building a new remote ingest service
