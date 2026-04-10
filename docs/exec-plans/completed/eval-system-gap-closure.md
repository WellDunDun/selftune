<!-- Verified: 2026-04-10 -->

# Execution Plan: Eval System Gap Closure

**Status:** Completed with follow-up fixes
**Created:** 2026-04-09
**Goal:** Close the audited eval-system gaps without redoing replay work that already exists in body/routing evolution, and fix the shipped-surface mismatches found after the first implementation pass.

## Audit Baseline

This plan implements the corrected reading of `docs/eval-system-gap-analysis.md`:

- replay-first validation already exists for body and routing evolution
- description evolution is still judge-only
- validation provenance already persists through audit/evidence/SQLite
- grading already informs failure extraction and proposal context, but not deployment monitoring
- execution-style testing exists as a unit-test harness, but it is not replay-staged and not a deploy gate

This plan also builds on, rather than replaces:

- `docs/eval-system-gap-analysis.md`
- `docs/exec-plans/active/deterministic-routing-validation.md`

## Implementation Audit Update

A post-implementation audit found that several gap-closure items landed as
partial plumbing rather than shipped behavior:

- description replay validation exists behind injected test seams, but is not
  reachable from the real `evolve` or `orchestrate` surface
- replay-backed description validation drops per-entry evidence and fixture
  provenance needed by Pareto selection and audit/evidence persistence
- post-deploy grade monitoring writes proposal-scoped baselines, but `watch`
  does not compare against them
- `watch` documents grade-watch controls that the CLI does not actually parse
- `eval generate --blend` can silently emit an empty eval file for log-sparse
  skills

This plan therefore adds a stabilization gate ahead of any more feature
expansion. The rule for the next agent wave is: **fix shipped behavior before
adding more surface area.**

## Follow-up Fix Update

The post-implementation audit follow-up closed the remaining shipped-surface
mismatches:

- `selftune watch` now parses the documented `--no-grade-watch` flag.
- Grade-only regressions can trigger the same alert and auto-rollback path as
  trigger-rate regressions.
- Replay-backed description validation uses the same improvement predicate as
  judge validation, including regression tolerance and minimum lift.
- Replay validation preserves eval provenance, `before_entry_results`, and
  `validation_fixture_id` through validation/evidence plumbing.
- `eval generate` honors custom JSONL path flags instead of silently reading
  SQLite.
- The eval generator/import cycle and contribution staging/preference cycle
  were split into smaller authority modules.
- The top-level `selftune evolve --help` entrypoint now renders the canonical
  default evolve command surface before listing subcommands.

## Stabilization Gate

No follow-on feature work in this plan should start until the following are
true from the real CLI/orchestrate surface, not only from injected tests:

1. Description evolution replay is reachable from `selftune evolve` and
   `selftune orchestrate`, or the replay-first claim is removed from docs and
   public help.
2. Replay-backed description validation preserves `per_entry_results`,
   `before_entry_results`, and `validation_fixture_id` through audit/evidence
   persistence.
3. Grade watch compares the correct baseline pair for the deployed proposal,
   rather than reading only a generic pre-deploy row.
4. `selftune watch` only documents flags that the CLI actually parses and
   forwards.
5. `selftune eval generate --blend` has explicit cold-start behavior: either
   synthetic fallback or a hard error. Silent empty output is not allowed.

## Success Criteria

Stabilization is complete when all of the items in the gate above are true and
covered by tests that run through the public command path.

Phase 1 is complete when all of the following are true after stabilization:

1. `EvalEntry` carries provenance (`source`, `created_at`) and CLI stats expose maturity mix.
2. Eval generation can emit a persisted blended set instead of forcing synthetic-or-log exclusivity.
3. `selftune evolve` uses the same replay-first validation stack as body/routing evolution, with an explicit `--validation-mode`.
4. Post-deploy monitoring can use grading deltas, not just trigger pass-rate deltas.
5. Orchestrate feeds freshly evolved skills into the monitoring path instead of waiting for a later run.

Phase 2 is complete when execution evals can run in a staged skill workspace and optionally gate deploys behind an experimental flag.

## Agent Team

### Operating Rules For This Agent Wave

- Do not add new commands for this plan.
- Do not add new public flags unless they replace a misleading surface that is
  already documented.
- Prefer deleting or hiding unstable paths over keeping multiple “advanced”
  modes alive.
- Any doc claim about `evolve`, `watch`, `eval generate`, or `orchestrate`
  must be backed by a test that exercises the shipped interface.

### Agent 1: Eval Schema + Provenance

**Scope**

- Add provenance to `EvalEntry`
- Plumb provenance through generators, serializers, stats output, and tests

**Primary files**

- `cli/selftune/types.ts`
- `cli/selftune/eval/hooks-to-evals.ts`
- `cli/selftune/eval/synthetic-evals.ts`
- tests under `tests/eval/`

**Deliverables**

- `EvalEntry.source` with at least `synthetic | log | blended`
- `EvalEntry.created_at`
- stats output showing source mix and synthetic maturity
- fixture/test updates for new shape

**Notes**

- Keep the type additive and backwards-compatible
- Do not block later agents on perfect maturity analytics; land the schema and basic plumbing first

### Agent 2: Blended Eval Builder

**Scope**

- Add a persisted blended eval generation path
- Reuse the provenance fields from Agent 1
- Make cold-start blend behavior explicit and safe

**Primary files**

- `cli/selftune/eval/hooks-to-evals.ts`
- `cli/selftune/eval/synthetic-evals.ts`
- `cli/selftune/index.ts` if flags change
- `skill/SKILL.md`
- `skill/workflows/Evals.md`

**Deliverables**

- `--blend` or equivalent flag on eval generation
- deterministic blending policy for positives, negatives, and boundary cases
- exported JSON carrying blended provenance
- tests proving synthetic boundary entries survive after real logs exist
- explicit zero-log behavior:
  - either synthetic output is retained as the cold-start fallback, or
  - the command fails with a targeted error telling the agent what to do next

**Dependency**

- Starts after Agent 1 lands the new `EvalEntry` shape

### Agent 3: Replay Reachability + Validation Unifier

**Scope**

- Move description evolution onto the replay-first validation stack already used by body/routing evolution
- Do not rewrite body/routing validation from scratch
- Make replay reachable from the real `evolve` and `orchestrate` code paths
- Preserve replay evidence needed by Pareto selection and audit/evidence persistence

**Primary files**

- `cli/selftune/evolution/evolve.ts`
- `cli/selftune/evolution/validate-proposal.ts`
- `cli/selftune/evolution/engines/replay-engine.ts`
- `cli/selftune/evolution/validate-host-replay.ts`
- `cli/selftune/evolution/engines/judge-engine.ts`
- `skill/SKILL.md`
- `skill/workflows/Evolve.md`

**Deliverables**

- `selftune evolve --validation-mode auto|replay|judge`
- replay fixture/runner wiring inside description evolution from the real CLI/orchestrate path
- fallback behavior that is explicit in audit/evidence output
- preserved replay provenance in description evolution:
  - `per_entry_results`
  - `before_entry_results`
  - `validation_fixture_id`
- tests covering:
  - replay available
  - replay unavailable
  - explicit judge mode
  - orchestrate invoking the same replay-capable path
  - Pareto selection with replay-backed validation results

**Notes**

- Reuse existing provenance fields; do not invent a second audit trail
- Preserve judge mode as an explicit fallback, not an implicit default
- Treat Codex/OpenCode runtime parity as stretch work, not a phase-1 blocker

### Agent 4: Grade-Watch Loop

**Scope**

- Connect grading deltas to post-deploy monitoring and rollback decisions
- Fix sequencing so freshly evolved skills are watched in the same operational window
- Make the public `watch` CLI match the documented grade-watch surface

**Primary files**

- `cli/selftune/monitoring/watch.ts`
- `cli/selftune/orchestrate.ts`
- `cli/selftune/grading/results.ts`
- `cli/selftune/localdb/{queries.ts,direct-write.ts,schema.ts}`
- tests under `tests/monitoring/`, `tests/orchestrate/`, and `tests/localdb/`

**Deliverables**

- proposal-aware pre/post deploy grading baseline lookup from SQLite
- grade-regression thresholds alongside trigger-regression thresholds
- auto-grade-next-N-session logic for recently deployed skills, or tighten docs to the implemented count
- orchestrate path that watches freshly evolved skills instead of deferring them to future runs
- `watch` CLI parsing for the documented grade-watch flags, or doc removal if those flags stay internal

**Notes**

- Current auto-grading of ungraded skills is useful but not sufficient; keep it
- Prefer additive monitoring signals over replacing the trigger snapshot entirely
- Do not leave `queryGradeRegression()` as dead plumbing; either use it or delete it

### Agent 5: Execution Eval Foundations

**Scope**

- Phase-2 work only
- Extend the existing unit-test/assertion system into a replay-staged execution eval harness

**Primary files**

- `cli/selftune/eval/unit-test.ts`
- `cli/selftune/eval/unit-test-cli.ts`
- `cli/selftune/evolution/validate-host-replay.ts`
- `cli/selftune/types.ts`
- `skill/workflows/UnitTest.md` or equivalent docs

**Deliverables**

- experimental `ExecutionEvalEntry` type or equivalent execution-eval contract
- staged workspace execution path for assertions
- optional deploy gate behind an experimental flag

**Notes**

- Build on the existing assertion language if possible
- Do not block Phase 1 on this track

### Agent 6: Integration, Docs, and QA

**Scope**

- Keep the repo coherent while the other agents land changes
- Own all required doc propagation and end-to-end verification

**Primary files**

- `AGENTS.md` entries if commands or files move
- `skill/SKILL.md`
- `skill/workflows/Evolve.md`
- `skill/workflows/Evals.md`
- `skill/workflows/Orchestrate.md`
- `docs/design-docs/evolution-pipeline.md`

**Deliverables**

- docs updated for every new flag or changed behavior
- regression test matrix
- product-surface contract tests for:
  - `evolve` validation-mode behavior
  - `watch` flag/help/workflow parity
  - `eval generate --blend` cold-start semantics
- final integration pass across `evolve`, `evolve body`, `eval generate`, `watch`, and `orchestrate`

**Notes**

- This agent should run continuously, not only at the end
- If new evolution modules are added, update `ARCHITECTURE.md` per repo rules

## Delivery Waves

### Wave 0: Stabilization

- Agent 3 makes replay reachable from the shipped description-evolution path
- Agent 3 preserves replay per-entry provenance and fixture IDs through audit/evidence
- Agent 4 wires proposal-aware grade baseline comparison into `watch`
- Agent 4 either implements the documented watch flags or removes them from docs/help
- Agent 2 resolves `--blend` zero-log behavior so the command cannot silently emit `[]`
- Agent 6 adds product-surface contract tests that fail if docs/help overclaim

This wave is the hard gate for the rest of the plan.

### Wave 0.5: Alignment

- Agent 6 lands the audited doc updates and keeps the implementation plan current
- Agent 3 reviews `deterministic-routing-validation.md` and extracts only the still-open work

### Wave 1: Foundation

- Agent 1 lands `EvalEntry` provenance
- Agent 4 adds the minimal SQLite query surface needed for grade-aware monitoring
- Agent 6 updates docs for any schema/flag drift introduced in this wave

### Wave 2: Core Gap Closure

- Agent 2 lands persisted blended eval generation on top of Agent 1
- Agent 3 lands replay-first description evolution and explicit validation mode selection
- Agent 4 lands same-run monitoring/orchestrate sequencing if not already completed in stabilization

These can run in parallel once Agent 1 is merged.

### Wave 3: Monitoring Hardening

- Agent 4 adds grade-regression thresholds and rollback hooks
- Agent 6 runs end-to-end validation across:
  - `eval generate`
  - `evolve`
  - `evolve body`
  - `watch`
  - `orchestrate`

### Wave 4: Execution Eval Expansion

- Agent 5 builds the experimental execution-eval layer
- Agent 6 updates operator docs and flags this as non-default until confidence is high

## Merge Order

Use this merge order to avoid rebase churn:

1. Agent 6 plan/docs/contract-test groundwork
2. Agent 3 replay reachability + provenance preservation
3. Agent 4 grade-watch correctness + watch CLI parity
4. Agent 2 blend cold-start semantics
5. Agent 1 remaining provenance/schema cleanup
6. Agent 4 monitoring/orchestrate behavior
7. Agent 6 doc/integration sweep
8. Agent 5 experimental execution eval

## Verification Matrix

Every merged wave should pass the smallest relevant test slice first, then a wider sweep.

### Required targeted tests

- eval generation tests
- replay validation tests
- description evolve tests
- orchestrate replay-path tests
- monitoring/watch tests
- orchestrate tests
- SQLite read/write tests for new fields
- command help/workflow parity tests for `watch`, `evolve`, and `eval generate`

### Required workflow checks

1. Generate a log-based eval set and confirm provenance stats.
2. Generate a blended eval set and confirm mixed provenance in output JSON.
3. Run description evolution with `--validation-mode auto` and verify replay/judge fallback labeling.
4. Deploy a proposal, then confirm the monitoring loop can detect trigger and grade regressions separately.
5. Run orchestrate and confirm freshly evolved skills enter the watch path without waiting for a later run.

## Risks

- The current replay stack is Claude-runtime-first. Cross-agent runtime parity can expand scope quickly.
- `validate-proposal.ts` still represents the old description-validation architecture; careless refactors can break Pareto flows.
- Adding provenance to `EvalEntry` touches more fixtures and tests than the size of the type change suggests.
- Grade-aware rollback needs conservative thresholds; otherwise noisy sessions will cause rollback churn.

## Non-Goals

- Replacing the existing replay engine stack for body/routing evolution
- Building perfect cross-agent runtime replay in Phase 1
- Making execution evals mandatory before the experimental path is proven
- Adding cloud dashboard product work unless the CLI contracts force it

## Program Lead Checklist

- Keep Agent 3 focused on making replay real on the shipped path before broader cleanup
- Keep Agent 4 focused on correct proposal-scoped post-deploy monitoring, not generic grading cleanup
- Require Agent 6 sign-off before merging any new CLI flag or workflow behavior
- Do not start the wider refactor program until the stabilization gate is closed
- Treat Phase 2 execution eval as explicitly optional if Phase 1 slips
