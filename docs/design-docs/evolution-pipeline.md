<!-- Verified: 2026-02-28 -->

# Evolution Pipeline Design

How selftune proposes, validates, and deploys improved skill descriptions.

## Overview

The evolution pipeline transforms real usage signal into improved SKILL.md descriptions. It runs as a retry loop: extract failure patterns, generate a candidate description, validate it against the eval set, and deploy if improved.

## Pipeline Stages

```
Extract Patterns → Generate Proposal → Validate → Deploy (or Reject + Retry)
```

### 1. Extract Failure Patterns (`extract-patterns.ts`)

Analyzes eval entries and skill usage records to find clusters of missed queries.

- Groups missed queries by invocation type (explicit, implicit, contextual, negative)
- Uses Jaccard similarity for query clustering (`computeQuerySimilarity`)
- Single-linkage clustering groups similar misses into `FailurePattern` objects
- Each pattern records: missed queries, frequency, sample sessions

### 2. Generate Proposal (`propose-description.ts`)

Uses an LLM to propose an improved description that would catch missed queries.

- System prompt (`PROPOSER_SYSTEM`) instructs the model to improve trigger coverage
- Builds a structured prompt with current description, failure patterns, and missed queries
- Parses response into an `EvolutionProposal` with confidence score
- Supports both `agent` mode (subprocess) and `api` mode (direct API call)

### 3. Validate Proposal (`validate-proposal.ts`)

Runs the proposed description against the full eval set.

- Checks each query: "Would this description trigger for this query?"
- Computes before/after pass rates, identifies new passes and regressions
- A proposal must: improve pass rate AND introduce <5% regressions
- Returns `ValidationResult` with `improved` boolean and `net_change`

### 4. Deploy (`deploy-proposal.ts`)

Writes the improved description to SKILL.md.

- Creates `.bak` backup of original SKILL.md
- Replaces the description section (between `#` and first `##`)
- Builds commit message with pass rate delta: `evolve(skill-name): +15% pass rate`
- Optionally creates git branch and PR via `gh pr create`

## Orchestrator (`evolve.ts`)

Coordinates the full pipeline with retry logic:

1. Read current SKILL.md
2. Load eval set (from file or build from logs)
3. Extract failure patterns → early exit if none
4. **Retry loop** (up to `maxIterations`):
   - Generate proposal
   - Check confidence threshold → reject if below
   - Validate against eval set → reject if not improved
   - Feed failure reason into next iteration if rejected
5. Deploy if validation passed (unless `--dry-run`)
6. Record audit entries at every state transition

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
| `evolution/extract-patterns.ts` | Cluster missed queries into failure patterns |
| `evolution/propose-description.ts` | LLM-based description improvement |
| `evolution/validate-proposal.ts` | Before/after eval set validation |
| `evolution/deploy-proposal.ts` | SKILL.md update, backup, PR creation |
| `evolution/evolve.ts` | Orchestrator with retry loop |
| `evolution/rollback.ts` | Revert to pre-evolution description |
| `evolution/stopping-criteria.ts` | Loop termination conditions |
| `evolution/audit.ts` | Append/read audit trail entries |
