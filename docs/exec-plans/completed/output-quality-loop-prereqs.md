# Output Quality Loop Prerequisites

**Status:** Proposed  
**Date:** 2026-03-19  
**Related:** [prd-output-quality-loop.md](/Users/danielpetro/Documents/Projects/FOSS/selftune/strategy/prd-output-quality-loop.md)

## Purpose

Do **not** build `selftune evolve output` yet.

Do the minimum now so the alpha program collects the right data and does not
close off the option to build the output-quality loop well later.

This is a prerequisite plan, not a feature plan.

## Why Now

The output-quality PRD is strategically right but tactically early.

Current priority remains:

- trusted alpha onboarding
- reliable local-to-cloud upload
- operator visibility
- real-session review loops

But if alpha telemetry omits the evidence needed for output-quality learning,
we waste the highest-value learning window.

## Goal

Capture enough output-side evidence during alpha that a later
`selftune evolve output` loop can be built from real data rather than guesses.

## Non-Goals

- no `selftune evolve output` command yet
- no automated output mutation loop yet
- no output-quality dashboard panel yet
- no output grader rollout yet

## Required Data Prerequisites

### 1. Final Output Capture

For sessions where a skill fires, preserve the best available representation of
what the agent actually produced.

Prefer, in order:

- final assistant message text
- generated file references and changed file paths
- structured artifact metadata when available
- attachment or screenshot references when available

Minimum requirement:

- enough data to let an operator answer “the skill fired, but what did it produce?”

### 2. Output Context Linkage

Every captured output signal should be linkable back to:

- `session_id`
- `prompt_id` if available
- `skill_invocation_id`
- `skill_name`
- platform / agent type / model
- timestamp

This is what makes later grading and mutation evidence usable.

### 3. Artifact References, Not Just Text

For output-quality work, text alone is often insufficient.

Capture references to:

- changed files
- generated markdown/docs/code outputs
- image or screenshot paths when local artifacts exist
- any durable local artifact ID that can be replayed or inspected later

Do not try to upload huge binaries blindly in the first pass.
Store references and metadata first.

### 4. Manual Review Hook

Add a lightweight operator review path for “triggered correctly, output looked bad.”

Minimum viable form:

- mark a session or invocation as output-bad
- attach a short note
- preserve the linked output evidence

This gives real labels before full automation exists.

### 5. Cloud Queryability

The cloud side should be able to answer:

- which skills trigger often but receive poor output feedback
- which invocations are linked to output-bad labels
- what artifacts or outputs were produced for those invocations

This can start as operator-facing inspection, not polished UI.

## Suggested Implementation Slices

### Slice A: Local Evidence Capture

In `miami`, ensure the local telemetry pipeline preserves:

- final response text when safely available
- changed file paths
- artifact metadata or attachment references

Do not block alpha on perfect normalization.
Prefer capture over elegance.

### Slice B: Canonical Upload Contract Extension

Extend the alpha upload contract only where needed to preserve:

- output evidence references
- linked file paths or artifact metadata
- future operator labels for output quality

Avoid a giant schema expansion.
Add only fields that are clearly useful for later grading or review.

### Slice C: Cloud Operator Inspection

In the cloud app, ensure operator surfaces can inspect:

- invocation
- output evidence
- linked artifacts
- any manual output-quality label

Start with raw/operator views, not polished product UI.

### Slice D: Manual Label Seed

Add a minimal label model for:

- `output_bad`
- `output_good`
- optional note

This is enough to seed the later quality loop.

## Acceptance Criteria

- For a triggered skill invocation, an operator can inspect what was produced.
- Output evidence is linked to invocation/session identity.
- At least one manual label path exists for “triggered correctly, output was poor.”
- The cloud model preserves enough evidence to support later output-quality grading.
- No major alpha rollout work is blocked on this prerequisite slice.

## Sequencing

1. Finish current alpha/auth/upload stabilization.
2. Add output-evidence capture and linkage as a narrow telemetry enhancement.
3. Add minimal operator review/label support.
4. Reassess after the first alpha cohort produces real sessions.
5. Only then decide whether to start full `selftune evolve output`.

## Decision

Use the output-quality PRD to influence **what data we keep now**.

Do **not** treat it as the next implementation milestone until:

- alpha users are active
- the current trigger/data loop is trusted
- operator review of real outputs is happening
