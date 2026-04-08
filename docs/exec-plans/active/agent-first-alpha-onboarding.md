# Agent-First Alpha Onboarding

**Status:** Proposed  
**Date:** 2026-03-19

## Goal

Make the real alpha user path happen through the user's coding agent and the
local CLI, not through the cloud frontend as the primary UX.

The cloud app remains the control plane for:

- sign-in
- alpha enrollment
- upload credential issuance

But the user's experience should be:

1. tell the agent to set up selftune
2. complete the minimum cloud auth handoff
3. return to the agent/CLI flow

## Product Rule

The cloud app is a dependency, not the main product surface.

The main product surface remains:

- `skill/SKILL.md`
- `skill/workflows/Initialize.md`
- `selftune init`

## Ticket 1: Define the Agent-First Enrollment Flow

**Goal:** specify the exact setup sequence the agent should follow.

### Deliverable

- a short flow spec covering:
  - user says "set up selftune"
  - agent checks local config
  - if not linked, agent explains the cloud enrollment step
  - user signs in / enrolls / issues credential
  - agent stores credential locally
  - agent finishes setup and verifies upload readiness

### Acceptance

- no ambiguity about where browser handoff happens
- no ambiguity about what the agent asks the user
- no ambiguity about when the flow returns to local CLI mode

## Ticket 2: Replace Local Alpha Identity Assumptions

**Goal:** stop treating alpha identity as a separate local-only user model.

### Files

- `cli/selftune/alpha-identity.ts`
- `cli/selftune/types.ts`
- `cli/selftune/init.ts`

### Work

- treat cloud-linked identity as authoritative
- keep local config as a cache of:
  - cloud user id
  - org id
  - upload credential
  - enrollment status metadata if needed
- remove assumptions that local email/user id are the real alpha identity source

### Acceptance

- local config reflects linked cloud identity, not a separate parallel identity model

## Ticket 3: Add CLI Support for Cloud Linking State

**Goal:** make `selftune init` and related commands aware of cloud link status.

### Files

- `cli/selftune/init.ts`
- `cli/selftune/status.ts`
- `cli/selftune/observability.ts`

### Work

- detect whether cloud identity + upload credential are present
- show clear agent-facing next steps when missing
- expose whether alpha upload is:
  - not linked
  - linked but not enrolled
  - enrolled but missing credential
  - ready

### Acceptance

- agent can reliably diagnose why alpha upload is not active

## Ticket 4: Add Browser Handoff UX for the Agent

**Goal:** make the unavoidable cloud step feel intentional and small.

### Files

- `skill/workflows/Initialize.md`
- `skill/SKILL.md`
- `skill/references/interactive-config.md`

### Work

- tell the agent exactly when to ask the user to sign in to the cloud app
- tell the agent exactly when to ask the user to issue an upload credential
- make the copy explicit:
  - this is a one-time account/enrollment step
  - afterwards the workflow returns to the local agent/CLI path

### Acceptance

- the agent does not present the cloud app as the main way to use selftune

## Ticket 5: Add Credential Import / Storage Path

**Goal:** let the agent finish setup after the user gets a cloud-issued credential.

### Files

- `cli/selftune/init.ts`
- `cli/selftune/alpha-upload/index.ts`
- local config read/write helpers

### Work

- accept product-issued `st_live_*` credential in setup flow
- store it locally in the expected config location
- validate presence/format before marking setup complete

### Acceptance

- after credential issuance, the agent can finish setup without manual file editing

## Ticket 6: Add Upload Readiness Verification

**Goal:** prove the local machine is actually ready after setup.

### Files

- `cli/selftune/init.ts`
- `cli/selftune/observability.ts`
- `skill/workflows/Initialize.md`

### Work

- run a small readiness check after setup:
  - config present
  - enrollment/credential fields present
  - push endpoint configured
  - upload queue can initialize
- return agent-facing confirmation or exact remediation

### Acceptance

- setup ends with a concrete readiness result, not “probably done”

## Ticket 7: Update Agent Docs to Match the New Truth

**Goal:** keep the agent-first product surface aligned with the new onboarding path.

### Files

- `skill/SKILL.md`
- `skill/workflows/Initialize.md`
- `skill/workflows/Doctor.md`
- `skill/workflows/Dashboard.md` if any cloud references exist

### Work

- make the setup workflow explicitly agent-first
- describe cloud auth as a required one-time control-plane handoff
- remove any implication that users should live in the cloud UI for normal use

### Acceptance

- docs match the intended product story

## Ticket 8: Add End-to-End Setup Smoke Test

**Goal:** verify the intended user path, not just the pieces.

### Scope

- temp local config
- simulated or staged cloud-issued credential
- `selftune init`
- readiness verification

### Acceptance

- one passing test proves the setup can go from fresh machine to upload-ready

## Recommended Order

1. Ticket 1 — flow spec
2. Ticket 2 — local identity cleanup
3. Ticket 3 — cloud-link state in CLI
4. Ticket 5 — credential import/storage
5. Ticket 6 — readiness verification
6. Ticket 4 and Ticket 7 — doc/agent workflow alignment
7. Ticket 8 — end-to-end smoke test

## Success Criteria

- the primary setup story is “tell your agent to set up selftune”
- the cloud UI is used only as a short auth/enrollment handoff
- the agent can explain exactly what the user must do and when
- local config reflects cloud-issued identity/credential state
- setup ends with upload-ready verification
