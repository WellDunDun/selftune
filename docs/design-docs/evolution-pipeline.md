<!-- Verified: 2026-03-03 -->

# Evolution Pipeline Design

How selftune proposes, validates, and deploys improved skill descriptions.

## Overview

The evolution pipeline transforms real usage signal into improved SKILL.md descriptions. It runs as a retry loop: extract failure patterns, generate a candidate description, validate it against the eval set, and deploy if improved.

The pipeline includes four advanced eval improvements:

1. **Deterministic Pre-Gates** — Fast code checks before LLM grading (<20ms)
2. **Graduated Scoring** — 0-1 float scores replacing binary pass/fail
3. **Rich Failure Feedback** — Structured failure explanations for evolution
4. **Pareto Evolution** — Multi-candidate proposals with frontier selection and merge

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
- **`dominates`** — Pareto dominance: A dominates B if A >= B on all dimensions AND A > B on at least one
- **`computeParetoFrontier`** — Filters candidates to the non-dominated set (Pareto frontier)
- **`buildMergePrompt`** — Generates an LLM prompt for merging complementary frontier candidates that each dominate on different invocation types
- **`selectFromFrontier`** — Selects the best single candidate by overall pass rate, and indicates whether a merge should be attempted

### 5. Deploy (`deploy-proposal.ts`)

Writes the improved description to SKILL.md.

- Creates `.bak` backup of original SKILL.md
- Replaces the description section (between `#` and first `##`)
- Builds commit message with pass rate delta: `evolve(skill-name): +15% pass rate`
- Optionally creates git branch and PR via `gh pr create`

## Graduated Scoring

All grading expectations now carry a `score` field (0.0-1.0) alongside the binary `passed` boolean. This enables finer-grained confidence tracking.

- Pre-gate results: `score: 1.0` (pass) or `0.0` (fail)
- LLM results: model assigns a 0.0-1.0 score per expectation
- Default: `score ?? (passed ? 1.0 : 0.0)` for backward compatibility
- `GradingSummary` includes `mean_score` and `score_std_dev` computed by `buildGraduatedSummary()`
- `printSummary()` displays scores and source tags (`[pre-gate]` / `[llm]`)

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

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--pareto` | `true` | Enable Pareto multi-candidate selection |
| `--candidates` | `3` | Number of candidate proposals to generate (max 5) |
| `--dry-run` | `false` | Preview proposals without deploying |

### Dependency Injection

`evolve()` accepts an optional `_deps: EvolveDeps` parameter for testability. In production, real module imports are used. In tests, mocks are injected directly — avoiding `mock.module` global contamination.

## Rollback (`rollback.ts`)

Two strategies, tried in order:

1. **Backup file**: Restore from `SKILL.md.bak` if it exists
2. **Audit trail**: Find the last `created` audit entry and extract the original description

Both strategies record a `rolled_back` audit entry.

## Stopping Criteria (`stopping-criteria.ts`)

Pure function that evaluates whether the retry loop should stop:

- `converged`: Pass rate meets target
- `max_iterations_reached`: Hit the retry limit
- `low_confidence`: All proposals below threshold
- `plateau`: No improvement across iterations

## Audit Trail

Every state change is recorded to `~/.claude/evolution_audit_log.jsonl`:

| Action | When |
|--------|------|
| `created` | Proposal generated |
| `validated` | Validation completed |
| `rejected` | Confidence too low or validation failed |
| `deployed` | SKILL.md updated |
| `rolled_back` | Reverted to previous description |

Each entry includes: `timestamp`, `proposal_id`, `action`, `details`, optional `eval_snapshot`.

## Files

| File | Responsibility |
|------|---------------|
| `grading/pre-gates.ts` | Deterministic pre-gate checks before LLM grading |
| `evolution/extract-patterns.ts` | Cluster missed queries into failure patterns (with optional feedback attachment) |
| `evolution/propose-description.ts` | LLM-based description improvement (single + multi-candidate) |
| `evolution/validate-proposal.ts` | Before/after eval set validation (with cached mode) |
| `evolution/pareto.ts` | Pareto frontier computation and candidate selection |
| `evolution/deploy-proposal.ts` | SKILL.md update, backup, PR creation |
| `evolution/evolve.ts` | Orchestrator with retry loop (standard + Pareto paths) |
| `evolution/rollback.ts` | Revert to pre-evolution description |
| `evolution/stopping-criteria.ts` | Loop termination conditions |
| `evolution/audit.ts` | Append/read audit trail entries |
