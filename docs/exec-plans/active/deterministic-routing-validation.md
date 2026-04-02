<!-- Verified: 2026-04-01 -->

# Execution Plan: Deterministic Routing Validation

**Status:** Partially Implemented  
**Created:** 2026-04-01  
**Goal:** Replace selftune's current LLM-judge routing validation with a replay-first validation harness that measures whether skills actually trigger in the host agent, while preserving the current judge path as an explicit fallback.

## Executive Summary

selftune currently validates evolution proposals by asking an LLM:

- "Given this skill description, would this query trigger this skill?"

That design exists today in:

- [cli/selftune/evolution/validate-proposal.ts](../../../cli/selftune/evolution/validate-proposal.ts)
- [cli/selftune/evolution/validate-routing.ts](../../../cli/selftune/evolution/validate-routing.ts)
- [cli/selftune/evolution/validate-body.ts](../../../cli/selftune/evolution/validate-body.ts)

That is not deterministic. It is a model-based proxy for routing behavior.

The current approach is useful for rapid iteration, but it has three core trust problems:

1. It does not measure the actual host agent's routing behavior.
2. It produces internal `evaluation assistant` traffic that pollutes skill evidence surfaces.
3. It makes validation look more objective than it really is.

The right target is not "perfect determinism" in the abstract. The right target is:

- use deterministic scaffolding where possible
- use real host-agent replay as the primary validator
- label LLM-judge validation honestly when replay is unavailable

This plan introduces a validation engine stack with three tiers:

1. `structural_guard`
2. `host_replay`
3. `llm_judge`

`host_replay` becomes the default authority for routing validation wherever feasible.

## Current Implementation Status

Implemented on `WellDunDun/cold-start-and-replay-validation`:

- `validate-host-replay.ts` now exists and runs a deterministic fixture-backed replay over installed skill surfaces.
- `validate-routing.ts` prefers `host_replay` whenever a replay fixture is present, while preserving `llm_judge` as the fallback.
- Routing evolve runs now auto-build a replay fixture from the target skill plus sibling skills in the same registry.
- Validation provenance (`validation_mode`, `validation_agent`, `validation_fixture_id`, `validation_evidence_ref`) now persists through audit logs, SQLite materialization, dashboard contracts, and skill-report payloads.
- The skill report UI now shows whether a proposal was replay-validated, judge-validated, or only passed structural guards.

Still pending for the full target state:

- replaying the actual host agent/runtime instead of the current fixture-backed surface simulation
- extracting a separate `validate-llm-judge.ts` / `validation-engine.ts` split
- deciding whether replay-generated validation telemetry should land in existing SQLite tables or a dedicated validation namespace
- expanding replay beyond the current routing-first path where it meaningfully improves body/description validation

---

## Problem Statement

### Current Behavior

Today the evolution loop does three distinct things:

1. Builds eval sets from telemetry in [cli/selftune/eval/hooks-to-evals.ts](../../../cli/selftune/eval/hooks-to-evals.ts)
2. Proposes new descriptions in [cli/selftune/evolution/propose-description.ts](../../../cli/selftune/evolution/propose-description.ts)
3. Validates those descriptions by asking another model whether each query would trigger

The first step is mostly deterministic for telemetry-backed eval sets.

The third step is not:

- batched validation uses LLM calls with majority voting
- validation results depend on model behavior
- the validation surface is not the same as the real routing surface used by Claude Code, Codex, or other host agents

### Why This Is a Product Problem

This creates a trust gap for both technical and non-technical users:

- "validated" does not necessarily mean "the real agent now triggers correctly"
- the dashboard can show internal eval traffic as evidence for the skill itself
- proposal validation can drift from actual host routing behavior

### Constraint

Some host routing systems are themselves LLM-driven, so "fully deterministic" is not always possible.

That does **not** justify the current design as the end state.

The right standard is:

- "Did the real host agent trigger the skill in a controlled replay?"

That is much closer to truth than:

- "Would a separate LLM say this description should trigger?"

---

## Design Principles

### 1. Validate Real Behavior Before Simulated Judgment

Prefer replaying the actual host agent and observing whether the target skill is invoked or read.

### 2. Keep Deterministic Work Deterministic

Structural checks, batching, fixture setup, log parsing, and transcript comparison should be script-driven and reproducible.

### 3. Make Validation Provenance Explicit

Every validation result must say how it was produced:

- replayed host behavior
- structural guard only
- LLM judge fallback

### 4. Preserve Cheap Fallbacks Without Pretending They Are Ground Truth

The current LLM-judge path remains useful as:

- a pre-screen
- a fallback
- a cold-start tool

But it must stop masquerading as equivalent to replay validation.

---

## Target State

### Validation Engines

Introduce a validation engine abstraction with these modes:

- `structural_guard`
- `host_replay`
- `llm_judge`

### Validation Flow

For a proposal:

1. Run structural guards.
2. If structural guard fails, reject immediately.
3. If replay fixture is available, run host replay validation.
4. If replay is unavailable, run LLM-judge validation and mark result as fallback-grade.

### Output Shape

Every validation result should include:

- `validation_mode`
- `validation_agent`
- `validation_fixture_id`
- `before_pass_rate`
- `after_pass_rate`
- `improved`
- `per_entry_results`
- `replay_evidence` or transcript/session refs when applicable

---

## Proposed Architecture

### New Module Split

Status note: this is only partially complete today. `validate-host-replay.ts` exists, but `validate-llm-judge.ts` and `validation-engine.ts` have not been split out yet.

Add a validator layer under `cli/selftune/evolution/`:

- `validate-structural.ts`
- `validate-host-replay.ts`
- `validate-llm-judge.ts`
- `validation-engine.ts`

Keep current trigger-check prompt helpers in:

- [cli/selftune/utils/trigger-check.ts](../../../cli/selftune/utils/trigger-check.ts)

#### `validate-structural.ts`

Deterministic checks on the proposal text:

- preserved anchor phrases like `USE WHEN`
- preserved skill-name references where required
- obvious over-broadening
- empty or malformed description/body changes
- negative safety rules already implied by constitutional rejection patterns

Returns:

- pass/fail
- reasons
- no LLM calls

#### `validate-host-replay.ts`

Primary validation engine.

Responsibilities:

- create a controlled skill environment
- install original or proposed description into that environment
- replay eval queries through the actual host agent
- observe whether the target skill was actually triggered
- compare before vs after

Returns:

- actual trigger outcomes
- transcript/session refs
- before/after pass rates
- regressions/new passes

#### `validate-llm-judge.ts`

Contains the current logic now spread across:

- [validate-proposal.ts](../../../cli/selftune/evolution/validate-proposal.ts)
- [validate-routing.ts](../../../cli/selftune/evolution/validate-routing.ts)
- [validate-body.ts](../../../cli/selftune/evolution/validate-body.ts)

This is fallback-grade validation, not primary truth.

#### `validation-engine.ts`

Single orchestrator:

- picks validation mode
- runs structural checks first
- invokes replay when fixture exists
- otherwise falls back to LLM judge
- emits normalized provenance

---

## Host Replay Design

### What Replay Must Answer

For each eval query:

- did the host agent invoke the target skill?
- did it read the target `SKILL.md`?
- did it avoid triggering for negatives?

This is the actual routing question selftune cares about.

### First Platform: Claude Code

Claude Code should be implemented first because it is the primary supported platform.

Use existing assets:

- [tests/sandbox/](../../../tests/sandbox)
- [cli/selftune/ingestors/claude-replay.ts](../../../cli/selftune/ingestors/claude-replay.ts)
- transcript parsing utilities
- existing hook/replay detection for `Skill(...)` and `Read .../SKILL.md`

### Replay Fixture

Validation replay must not run against an arbitrary local skill environment.

Each replay run should carry a fixture describing:

- target skill path
- target platform
- competing skills to load
- any relevant workspace context
- whether the check is for description-only or body/routing changes

Add a fixture type, for example:

```ts
/**
 * Fixture describing the controlled environment for routing replay validation.
 * Each fixture captures the host platform, the target skill under test, and
 * any competing/contextual skills that must be present during replay.
 */
interface RoutingReplayFixture {
  /** Stable identifier for this fixture definition. */
  fixture_id: string;
  /** Host platform whose routing behavior is being replayed. */
  platform: "claude_code" | "codex";
  /** Canonical installed skill name that should trigger for positives. */
  target_skill_name: string;
  /** Absolute or fixture-relative path to the target skill's SKILL.md. */
  target_skill_path: string;
  /** Other installed SKILL.md paths loaded to make replay routing realistic. */
  competing_skill_paths: string[];
  /** Optional workspace root used when replay requires repository context. */
  workspace_root?: string;
}
```

### Replay Result

For each query, record:

- expected trigger outcome
- actual trigger outcome
- whether trigger was explicit/read-based/inferred
- transcript/session ref

This becomes the new authoritative `per_entry_results` payload for replay validation.

Status note: the current replay path uses a controlled fixture assembled from installed `SKILL.md` surfaces and routing phrases. That is stronger than pure judge prompts, but it is still not the final “real host replay” target described in this plan.

---

## Structural Guards

Structural validation should become a first-class gate before any replay or LLM judge work.

Examples:

- preserve `USE WHEN` anchors
- preserve required scoping clauses
- reject obviously broadened descriptions that drop core identity
- reject malformed frontmatter/body structure

This codifies the kind of rejection already visible in `evolution_audit` and removes pointless replay work on obviously invalid proposals.

---

## Data Model Changes

### Evolution Audit

Extend audit snapshots to include validation provenance:

- `validation_mode`
- `validation_agent`
- `validation_fixture_id`
- `validation_evidence_ref`

This likely touches:

- [cli/selftune/evolution/audit.ts](../../../cli/selftune/evolution/audit.ts)
- [cli/selftune/localdb/schema.ts](../../../cli/selftune/localdb/schema.ts)
- [cli/selftune/localdb/direct-write.ts](../../../cli/selftune/localdb/direct-write.ts)
- [cli/selftune/dashboard-contract.ts](../../../cli/selftune/dashboard-contract.ts)

If any of these provenance fields extend the JSONL audit schema, implementation must also update [cli/selftune/localdb/materialize.ts](../../../cli/selftune/localdb/materialize.ts) before committing so SQLite rebuilds continue to parse the append-only logs correctly.

### Evolution Evidence

Add room for replay-derived evidence payloads:

- replay transcript/session ref
- actual before/after outcomes
- validation engine type

This allows the dashboard to say:

- `Validated by real replay`
vs
- `Validated by model judgment`

---

## Dashboard and Trust UX Changes

Once provenance exists, the dashboard should surface it directly.

### Skill Report

In the proposal summary/evidence viewer:

- show `Validation Mode`
- show `Replay-validated` badge when applicable
- downgrade trust language for `llm_judge`-only results

### Evidence Buckets

Internal validation traffic should not be treated as user-facing skill evidence.

The current pollution issue on the `selftune` page is exactly why replay and internal-eval provenance must be separated from normal usage evidence.

---

## Implementation Phases

### Phase 0: Make Current State Honest

**Priority:** Critical  
**Effort:** Small  
**Risk:** Low

Changes:

1. Rename current validation mode internally to `llm_judge`.
2. Add provenance fields to result objects, even if they are initially static.
3. Update dashboard copy to stop implying deterministic validation.

Acceptance:

- no code path treats current judge-based validation as unlabeled truth

### Phase 1: Structural Guard Layer

**Priority:** Critical  
**Effort:** Medium  
**Risk:** Low

Files:

- new `validate-structural.ts`
- `evolve.ts`
- audit/evidence persistence
- `skill/Workflows/Evolve.md` (required whenever `cli/selftune/evolution/*.ts` changes)

Acceptance:

- obvious constitutional failures are rejected before replay/judge
- rejection reasons are deterministic and recorded
- any PR touching `cli/selftune/evolution/*.ts` also updates `skill/Workflows/Evolve.md` before commit

### Phase 2: Claude Code Replay Validator

**Priority:** Critical  
**Effort:** Large  
**Risk:** Medium

Files:

- new `validate-host-replay.ts`
- sandbox harness integration
- transcript/result extraction helpers
- `evolve.ts`
- `skill/Workflows/Evolve.md` (required whenever `cli/selftune/evolution/*.ts` changes)

Acceptance:

- before/after trigger rates come from actual Claude Code replay
- replay results include per-entry evidence
- replay can run on eval sets without contaminating normal operator telemetry
- PRs that modify `cli/selftune/evolution/*.ts` include the corresponding `skill/Workflows/Evolve.md` update

### Phase 3: Provenance in UI and Data Model

**Priority:** High  
**Effort:** Medium  
**Risk:** Low

Files:

- `dashboard-contract.ts`
- route handlers
- local dashboard pages/components
- `cli/selftune/localdb/materialize.ts` whenever JSONL audit fields change during provenance expansion

Acceptance:

- users can see whether validation was replay-based or judge-based
- trust language in UI reflects that distinction
- any new JSONL provenance fields rebuild cleanly into SQLite via `cli/selftune/localdb/materialize.ts`

### Phase 4: Codex Replay Validator

**Priority:** Medium  
**Effort:** Medium  
**Risk:** Medium

This is explicitly after Claude-first validation is stable.

---

## Non-Goals

- building a perfect universal routing oracle across all platforms first
- removing the LLM-judge path immediately
- redesigning eval-set generation in the same project
- making synthetic eval generation deterministic

---

## Open Questions

1. What is the cleanest controlled environment for Claude replay: sandbox harness, transcript replay shim, or a minimal live CLI harness?
2. Should replay validate "skill invocation" only, or also "skill file read" as a weaker positive signal?
3. How much competing-skill context is required for routing replay to be trustworthy?
4. Given the SQLite-first data model, should replay-generated validation rows land in existing SQLite telemetry tables or a dedicated validation table/namespace that dashboards exclude by default? SQLite remains the singleton source of truth, JSONL stays append-only, and `materialize.ts` remains rebuild-only, so any replay validation design must specify which SQLite tables own the data and how one-way materialization/logging preserves that boundary.

---

## Recommended Starting Slice

Ship the smallest honest version first:

1. Add `validation_mode = "llm_judge"` to current validation results.
2. Add structural guard validation before judge calls.
3. Build a Claude-only replay prototype for description validation on one skill.
4. Surface `Validated by real replay` vs `Validated by model judgment` in the skill report.

That gives selftune a truthful story quickly while establishing the path to real routing validation.
