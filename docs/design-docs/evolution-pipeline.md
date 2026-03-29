<!-- Verified: 2026-03-04 -->

# Evolution Pipeline Design

How selftune proposes, validates, and deploys improved skill descriptions, routing tables, and full skill bodies.

## Overview

The evolution pipeline transforms real usage signal into improved SKILL.md descriptions. It runs as a retry loop: extract failure patterns, generate a candidate description, validate it against the eval set, and deploy if improved.

The pipeline includes four advanced eval improvements plus four scope expansions:

1. **Deterministic Pre-Gates** — Fast code checks before LLM grading (<20ms)
2. **Graduated Scoring** — 0-1 float scores replacing binary pass/fail
3. **Rich Failure Feedback** — Structured failure explanations for evolution
4. **Pareto Evolution** — Multi-candidate proposals with frontier selection and merge

Scope expansions:

5. **Full Body Evolution** — Teacher-student model for evolving routing tables and complete skill bodies (not just descriptions)
6. **Baseline Comparison** — Measure skill value vs no-skill baseline before deploying
7. **Token Efficiency** — 5th Pareto dimension tracking token usage efficiency
8. **Skill Unit Tests** — Deterministic assertion framework for skill validation
9. **Composability Analysis** — Detect conflicts between co-occurring skills
10. **SkillsBench Import** — External eval corpus integration

## Pipeline Stages

```
Pre-Gates → Extract Patterns → Generate Proposal(s) → Validate → Pareto Select → Deploy (or Reject + Retry)
```

### 0. Deterministic Pre-Gates (`grading/pre-gates.ts`)

Fast deterministic checks that resolve grading expectations without an LLM call. Runs before the LLM grader to save tokens and time.

- **4 built-in gates:**
  - `skill_md_read` — Checks if `skills_triggered` contains the skill or transcript mentions reading SKILL.md
  - `expected_tools_called` — Checks `total_tool_calls > 0`
  - `error_count` — Checks `errors_encountered <= 2`
  - `session_completed` — Checks `assistant_turns > 0`
- Each gate matches expectation text via regex pattern
- Resolved expectations get `source: "pre-gate"` and `score: 1.0` or `0.0`
- Remaining expectations are passed to the LLM grader
- If all expectations resolve via pre-gates, the LLM call is skipped entirely
- Custom gates can be injected via the `gates` parameter for testability

### 1. Extract Failure Patterns (`extract-patterns.ts`)

Analyzes eval entries and skill usage records to find clusters of missed queries.

- Groups missed queries by invocation type (explicit, implicit, contextual, negative)
- Uses Jaccard similarity for query clustering (`computeQuerySimilarity`)
- Single-linkage clustering groups similar misses into `FailurePattern` objects
- Each pattern records: missed queries, frequency, sample sessions
- **Rich feedback attachment**: When `gradingResults` are provided, builds a `Map<query, FailureFeedback>` and attaches matching feedback to each `FailurePattern.feedback` field

### 2. Generate Proposal (`propose-description.ts`)

Uses an LLM to propose an improved description that would catch missed queries.

- System prompt (`PROPOSER_SYSTEM`) instructs the model to improve trigger coverage
- Builds a structured prompt with current description, failure patterns, and missed queries
- **Structured failure analysis**: When feedback is present on patterns, includes a "Structured Failure Analysis" section with specific query, failure reason, and improvement hint
- Parses response into an `EvolutionProposal` with confidence score
- Supports both `agent` mode (subprocess) and `api` mode (direct API call)
- **Multi-candidate generation**: `generateMultipleProposals` enables parallel LLM calls for N candidate proposals
- **Prompt variations**: `buildPromptVariations` creates prompt variants biased towards different invocation types

### 3. Validate Proposal (`validate-proposal.ts`)

Runs the proposed description against the full eval set.

- Checks each query: "Would this description trigger for this query?"
- Computes before/after pass rates, identifies new passes and regressions
- A proposal must: improve pass rate AND introduce <5% regressions
- Returns `ValidationResult` with `improved` boolean and `net_change`
- **Per-entry tracking**: Collects `per_entry_results` array during the validation loop
- **Invocation type breakdown**: Computes `by_invocation_type` scores from per-entry results
- **Cached validation**: `validateProposalCached` caches "before" results for efficiency across multiple candidates in the same Pareto run

### 4. Pareto Selection (`evolution/pareto.ts`)

Multi-dimensional selection of the best proposal from multiple candidates. All functions are pure — no I/O, no LLM calls.

- **`computeInvocationScores`** — Builds `InvocationTypeScores` from per-entry validation results, computing pass rate per invocation type (explicit, implicit, contextual, negative)
- **`dominates`** — Pareto dominance: A dominates B if A >= B on all dimensions AND A > B on at least one. Supports optional 5th dimension (token efficiency)
- **`computeParetoFrontier`** — Filters candidates to the non-dominated set (Pareto frontier). Passes `token_efficiency_score` through when available
- **`buildMergePrompt`** — Generates an LLM prompt for merging complementary frontier candidates that each dominate on different invocation types
- **`selectFromFrontier`** — Selects the best single candidate by overall pass rate, and indicates whether a merge should be attempted
- **`computeTokenUsageMetrics`** — Sums input/output tokens from telemetry records
- **`computeTokenEfficiencyScore`** — Compares avg tokens for sessions with/without a skill. Returns `clamp(baseline_avg / with_skill_avg, 0, 1)`. Score > 0.5 = skill is token-efficient

### 5. Deploy (`deploy-proposal.ts`)

SKILL.md manipulation utilities for the evolution pipeline.

- Replaces the description section (between `#` and first `##`)
- Parses SKILL.md into structured sections (frontmatter, title, description, `##` sections)
- Replaces named `##` sections or full body below frontmatter

## Graduated Scoring

All grading expectations now carry a `score` field (0.0-1.0) alongside the binary `passed` boolean. This enables finer-grained confidence tracking.

- Pre-gate results: `score: 1.0` (pass) or `0.0` (fail)
- LLM results: model assigns a 0.0-1.0 score per expectation
- Default: `score ?? (passed ? 1.0 : 0.0)` for backward compatibility
- `GradingSummary` includes `mean_score` and `score_std_dev` computed by `buildGraduatedSummary()`
- `printSummary()` displays scores and source tags (`[pre-gate]` / `[llm]`)

## Signal-Aware Candidate Selection

When `selftune orchestrate` runs, it reads pending improvement signals from
`~/.claude/improvement_signals.jsonl` and uses them to influence candidate
selection in two ways:

1. **Priority boost** — Each pending signal for a skill adds +150 to its
   candidate priority score (capped at +450). One signal outranks a WARNING
   base score; two signals outrank CRITICAL. Direct user correction is the
   highest-fidelity signal selftune can receive.

2. **Gate relaxation** — Skills with pending signals bypass:
   - The `MIN_CANDIDATE_EVIDENCE` gate (the signal IS the evidence)
   - The "UNGRADED with 0 missed queries" gate

After the orchestrate run completes, processed signals are marked
`consumed: true` with a timestamp and run ID so they don't affect subsequent
runs.

## Orchestrator (`evolve.ts`)

Coordinates the full pipeline with retry logic:

1. Read current SKILL.md
2. Load eval set (from file or build from logs)
3. Extract failure patterns (with optional `gradingResults` for rich feedback) → early exit if none
4. **Retry loop** (up to `maxIterations`):
   - **Standard path** (single candidate): Generate proposal → check confidence → validate → deploy/reject
   - **Pareto path** (when `--pareto` enabled and `--candidates > 1`):
     1. Generate N candidates in parallel via `generateMultipleProposals`
     2. Filter by confidence threshold
     3. Validate each using `validateProposalCached` (reuses cached "before" results)
     4. Compute Pareto frontier
     5. Attempt merge if complementary candidates exist
     6. Select best single candidate if merge fails
     7. Fall back to retry with feedback if no proposals improve
5. Deploy if validation passed (unless `--dry-run`)
6. Record audit entries at every state transition

### Constitutional Pre-Validation

Before LLM validation, description proposals pass through a deterministic
constitutional gate. This rejects obviously bad proposals before they can
consume validation budget or pollute the retry loop.

Current checks:

- size guard: description must stay within the configured character and word-count bounds
- XML/HTML rejection: proposals containing tags are rejected immediately
- unbounded broadening guard: bare "all", "any", "every", or "everything" must be qualified
- anchor preservation: required `USE WHEN` anchors and `$skillName` references must survive

If the gate fails, the pipeline records a `rejected` audit entry with the
constitutional reason. For description evolution the loop can retry with a
new proposal; for body evolution the size-only constitutional rejection is a
terminal failure for that candidate.

### CLI Flags

| Flag                 | Default                              | Description                                                 |
| -------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `--pareto`           | `true`                               | Enable Pareto multi-candidate selection                     |
| `--candidates`       | `3`                                  | Number of candidate proposals to generate (max 5)           |
| `--dry-run`          | `false`                              | Preview proposals without deploying                         |
| `--with-baseline`    | `false`                              | Measure baseline lift before deploying; gate on lift > 0.05 |
| `--token-efficiency` | `false`                              | Compute token efficiency scores; adds 5th Pareto dimension  |
| `--validation-model` | `haiku`                              | Model for trigger-check validation calls                    |
| `--proposal-model`   | (agent default)                      | Model for proposal generation LLM calls                     |
| `--cheap-loop`       | `true`                               | Use haiku for proposal/validation, sonnet for final gate    |
| `--gate-model`       | (none; `sonnet` when `--cheap-loop`) | Model for final gate validation before deploy               |
| `--gate-effort`      | (none)                               | Thinking effort for final gate validation                   |
| `--adaptive-gate`    | `false`                              | Escalate risky gate checks to `opus` + `high` effort        |

### Batch Trigger Validation

Trigger checks are batched (10 queries per LLM call by default) via `validateProposalBatched()`. This reduces LLM calls from 2N to ~2\*(N/10). The sequential `validateProposalSequential()` is kept for backward compatibility.

### Cheap-Loop Mode

When `--cheap-loop` is enabled:

1. `proposalModel` defaults to `haiku`
2. `validationModel` defaults to `haiku`
3. `gateModel` defaults to `sonnet`

All proposal generation and validation runs on the cheap model. Before deploy, a gate validation step (Step 13c) re-runs `validateProposal()` with the expensive gate model. Deploy is blocked if the gate validation fails. This follows GEPA's "learn cheap, deploy expensive" pattern — skills validated on cheap models transfer to expensive ones.

When `--adaptive-gate` is enabled, the pipeline inspects the validated candidate
before the final gate. Proposals with weak lift, regressions, low confidence,
or unusually large description broadening are escalated to an `opus` gate with
`high` effort. Low-risk proposals keep the base gate configuration.

### Synthetic Eval Generation

`cli/selftune/eval/synthetic-evals.ts` generates eval sets from SKILL.md via LLM, without requiring real session logs. Invoked via `selftune eval generate --synthetic --skill <name> --skill-path <path>`. Solves the cold-start problem where new skills have no session data for eval generation.

### Dependency Injection

`evolve()` accepts an optional `_deps: EvolveDeps` parameter for testability. In production, real module imports are used. In tests, mocks are injected directly — avoiding `mock.module` global contamination. The `gateValidateProposal` dependency allows testing gate validation independently.

## Rollback (`rollback.ts`)

Two strategies, tried in order:

1. **Backup file**: Restore from `SKILL.md.bak` if it exists
2. **Audit trail**: Find the last `created` audit entry and extract the original description

Both strategies record a `rolled_back` audit entry.

## Description Quality Scoring (`description-quality.ts`)

Pure heuristic scorer that evaluates skill description quality without LLM calls. Returns a 0.0–1.0 composite score with per-criterion breakdown.

**Criteria and weights:**

| Criterion         | Weight | What it measures                                            |
| ----------------- | ------ | ----------------------------------------------------------- |
| `length`          | 0.15   | Description length (penalizes < 20 or > 500 chars)          |
| `trigger_context` | 0.30   | Presence of trigger/activation keywords and examples        |
| `vagueness`       | 0.20   | Absence of vague filler words ("various", "helps with")     |
| `specificity`     | 0.20   | Concrete details: file extensions, CLI commands, tool names |
| `not_just_name`   | 0.15   | Description adds info beyond restating the skill name       |

Used during evolution runs to record before/after description quality in results, and in the dashboard to surface descriptions that need improvement. Quality-regression rejection is not currently enforced by the runtime validator.

## Stopping Criteria (`stopping-criteria.ts`)

Pure function that evaluates whether the retry loop should stop:

- `converged`: Pass rate meets target
- `max_iterations_reached`: Hit the retry limit
- `low_confidence`: All proposals below threshold
- `plateau`: No improvement across iterations

## Audit Trail

Every state change is recorded to `~/.claude/evolution_audit_log.jsonl`:

| Action        | When                                    |
| ------------- | --------------------------------------- |
| `created`     | Proposal generated                      |
| `validated`   | Validation completed                    |
| `rejected`    | Confidence too low or validation failed |
| `deployed`    | SKILL.md updated                        |
| `rolled_back` | Reverted to previous description        |

Each entry includes: `timestamp`, `proposal_id`, `action`, `details`, optional `eval_snapshot`.

## Full Body Evolution Pipeline (`evolve body`)

Extends evolution beyond descriptions to routing tables and complete skill bodies. Uses a teacher-student model where a stronger LLM generates proposals and a cheaper LLM validates them.

### Evolution Targets

| Target          | What changes                    | Generator                | Validator              |
| --------------- | ------------------------------- | ------------------------ | ---------------------- |
| `description`   | Text between `#` and first `##` | `propose-description.ts` | `validate-proposal.ts` |
| `routing_table` | `## Workflow Routing` table     | `propose-routing.ts`     | `validate-routing.ts`  |
| `full_body`     | Entire body below frontmatter   | `propose-body.ts`        | `validate-body.ts`     |

### 3-Gate Validation

Full body proposals pass through three sequential gates:

1. **Gate 1 (Structural)** — Pure code check: YAML frontmatter present, `# Title` exists, `## Workflow Routing` preserved if original had one. No LLM cost.
2. **Gate 2 (Trigger Accuracy)** — Student model runs YES/NO trigger checks per eval entry on the extracted description. Reuses shared `buildTriggerCheckPrompt`.
3. **Gate 3 (Quality)** — Student model rates body clarity and completeness on a 0.0-1.0 scale.

If any gate fails, structured feedback is passed to `refine-body.ts` which asks the teacher to revise specific sections. Retries up to `maxIterations`.

### Orchestrator Flow

```
parseSkillSections → buildEvalSet → extractFailurePatterns → Teacher generates →
Gate 1 (structural) → Gate 2 (trigger) → Gate 3 (quality) →
[refine if failed] → deploy (replaceSection or replaceBody)
```

## Baseline Comparison (`eval/baseline.ts`)

Measures whether a skill adds value over a no-skill baseline by running trigger checks with an empty description vs the actual description.

- `lift = with_skill_pass_rate - baseline_pass_rate`
- `adds_value = lift >= 0.05`
- Integrated into `evolve.ts` via `--with-baseline` flag — gates deployment on positive lift

## Token Efficiency (`evolution/pareto.ts`)

Extends Pareto dominance from 4 dimensions to 5 by adding token efficiency:

- `computeTokenEfficiencyScore(skillName, telemetry)` — compares avg total tokens for sessions with vs without the skill
- `efficiency_ratio = baseline_avg / with_skill_avg` — clamped to [0, 1], where > 0.5 means the skill reduces token usage
- When `--token-efficiency` is enabled, the score is attached to `ParetoCandidate.token_efficiency_score` and used in `dominates()` comparison
- Backward compatible — the 5th dimension is only used when both candidates have token scores

## Skill Unit Tests (`eval unit-test`)

Deterministic assertion framework for per-skill validation:

- **Assertion types**: `trigger_check` (LLM), `output_contains`, `output_matches_regex`, `tool_called` (agent-based)
- **Runner**: `runUnitTestSuite()` runs all tests, returns `UnitTestSuiteResult` with pass rate
- **Generator**: `generateUnitTests()` uses an LLM to create test cases from skill content and eval failures
- Tests stored as JSON arrays in `~/.selftune/unit-tests/<skillName>.json`

## Composability Analysis (`eval/composability.ts`)

Pure function that detects skill interaction conflicts from telemetry:

- Filters sessions where the target skill is triggered
- For each co-occurring skill: computes avg errors together vs alone
- `conflict_score = clamp((errors_together - errors_alone) / (errors_alone + 1), 0, 1)`
- Pairs with `conflict_score > 0.3` are flagged as conflict candidates

## SkillsBench Import (`eval import`)

Imports external evaluation tasks from the SkillsBench corpus:

- Parses `tasks/*/instruction.md` + optional `task.toml` metadata
- Converts to `EvalEntry[]` via `exact` (skill name match) or `fuzzy` (keyword overlap) strategies
- Enriches existing eval sets with externally validated test cases

## Files

| File                               | Responsibility                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `grading/pre-gates.ts`             | Deterministic pre-gate checks before LLM grading                                 |
| `evolution/extract-patterns.ts`    | Cluster missed queries into failure patterns (with optional feedback attachment) |
| `evolution/propose-description.ts` | LLM-based description improvement (single + multi-candidate)                     |
| `evolution/validate-proposal.ts`   | Before/after eval set validation (with cached mode)                              |
| `evolution/pareto.ts`              | Pareto frontier computation, candidate selection, token efficiency               |
| `evolution/deploy-proposal.ts`     | SKILL.md description replacement, section parsing, body replacement              |
| `evolution/evolve.ts`              | Description orchestrator with retry loop (standard + Pareto paths)               |
| `evolution/propose-routing.ts`     | LLM-based routing table proposal generation                                      |
| `evolution/validate-routing.ts`    | Routing table structural + trigger validation                                    |
| `evolution/propose-body.ts`        | Teacher LLM full body generation                                                 |
| `evolution/validate-body.ts`       | 3-gate body validation (structural + trigger + quality)                          |
| `evolution/refine-body.ts`         | Iterative body refinement from failure feedback                                  |
| `evolution/evolve-body.ts`         | Body/routing evolution orchestrator                                              |
| `evolution/rollback.ts`            | Revert to pre-evolution description                                              |
| `evolution/stopping-criteria.ts`   | Loop termination conditions                                                      |
| `evolution/audit.ts`               | Append/read audit trail entries                                                  |
| `eval/baseline.ts`                 | No-skill baseline comparison and lift measurement                                |
| `eval/unit-test.ts`                | Skill unit test runner                                                           |
| `eval/generate-unit-tests.ts`      | Unit test auto-generation from skill content                                     |
| `eval/composability.ts`            | Multi-skill co-occurrence conflict detection                                     |
| `eval/import-skillsbench.ts`       | SkillsBench task corpus importer                                                 |
| `utils/trigger-check.ts`           | Shared trigger-check prompt builder and parser                                   |
