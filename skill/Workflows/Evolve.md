# selftune Evolve Workflow

Improve a skill's description based on real usage signal. Analyzes failure
patterns from eval sets and proposes description changes that catch more
natural-language queries without breaking existing triggers.

## Default Command

```bash
selftune evolve --skill <name> --skill-path <path> [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--skill <name>` | Skill name | Required |
| `--skill-path <path>` | Path to the skill's SKILL.md | Required |
| `--eval-set <path>` | Pre-built eval set JSON | Auto-generated from logs |
| `--agent <name>` | Agent CLI to use (claude, codex, opencode) | Auto-detected |
| `--dry-run` | Propose and validate without deploying | Off |
| `--confidence <n>` | Minimum confidence threshold (0-1) | 0.7 |
| `--max-iterations <n>` | Maximum retry iterations | 3 |

## Output Format

Each evolution action is logged to `~/.claude/evolution_audit_log.jsonl`.
See `references/logs.md` for the audit log schema.

### Proposal Output (dry-run or pre-deploy)

```json
{
  "proposal_id": "evolve-pptx-1709125200000",
  "skill_name": "pptx",
  "iteration": 1,
  "original_pass_rate": 0.70,
  "proposed_pass_rate": 0.92,
  "regression_count": 0,
  "confidence": 0.85,
  "status": "validated",
  "changes_summary": "Added implicit triggers: 'slide deck', 'presentation', 'board meeting slides'"
}
```

### Audit Log Entries

The evolution process writes multiple audit entries:

| Action | When | Key details |
|--------|------|-------------|
| `created` | Proposal generated | `details` contains `original_description:` prefix |
| `validated` | Proposal tested against eval set | `eval_snapshot` with before/after pass rates |
| `deployed` | Updated SKILL.md written to disk | `eval_snapshot` with final rates |

## Parsing Instructions

### Track Evolution Progress

```bash
# Read audit log for the proposal
# Parse: entries where proposal_id matches
# Check: action sequence should be created -> validated -> deployed
```

### Check for Regression

```bash
# Parse: .eval_snapshot in validated entry
# Verify: proposed pass_rate > original pass_rate
# Verify: regression_count < 5% of total evals
```

## Steps

### 0. Read Evolution Context

Before starting, read `~/.selftune/memory/context.md` for session context:
- Active evolutions and their current status
- Known issues from previous runs
- Last update timestamp

This provides continuity across context resets. If the file doesn't exist,
proceed normally -- it will be created after the first evolution.

The evolution-guard hook (`hooks/evolution-guard.ts`) blocks direct SKILL.md
edits on monitored skills during active evolution. This prevents conflicting
changes while the evolve process is running. The guard is automatically
engaged when evolve starts and released when it completes.

### 1. Load or Generate Eval Set

If `--eval-set` is provided, use it directly. Otherwise, the command
generates one from logs (equivalent to running `evals --skill <name>`).

An eval set is required for validation. Without enough telemetry data,
evolution cannot reliably measure improvement.

### 2. Extract Failure Patterns

The command groups missed queries by invocation type:
- Missed explicit: description is broken (rare, high priority)
- Missed implicit: description is too narrow (common, evolve target)
- Missed contextual: description lacks domain vocabulary (evolve target)

See `references/invocation-taxonomy.md` for the taxonomy.

### 3. Propose Description Changes

An LLM generates a candidate description that would catch the missed
queries. The candidate:
- Preserves existing trigger phrases that work
- Adds new phrases covering missed patterns
- Maintains the description's structure and tone

### 4. Validate Against Eval Set

The candidate is tested against the full eval set:
- Must improve overall pass rate
- Must not regress more than 5% on previously-passing entries
- Must exceed the `--confidence` threshold

If validation fails, the command retries up to `--max-iterations` times
with adjusted proposals.

### 5. Deploy (or Preview)

If `--dry-run`, the proposal is printed but not deployed. The audit log
still records `created` and `validated` entries for review.

If deploying:
1. The current SKILL.md is backed up to `SKILL.md.bak`
2. The updated description is written to SKILL.md
3. A `deployed` entry is logged to the evolution audit

### 6. Update Memory

After evolution completes (deploy or dry-run), the memory writer updates:
- `~/.selftune/memory/context.md` -- records the evolution outcome and current state
- `~/.selftune/memory/decisions.md` -- logs the decision rationale and proposal details

This ensures the next evolve, watch, or rollback workflow has full context
even after a context window reset.

### Stopping Criteria

The evolution loop stops when any of these conditions is met (priority order):

| # | Condition | Meaning |
|---|-----------|---------|
| 1 | **Converged** | Pass rate >= 0.95 |
| 2 | **Max iterations** | Reached `--max-iterations` limit |
| 3 | **Low confidence** | Proposal confidence below `--confidence` threshold |
| 4 | **Plateau** | Pass rate unchanged across 3 consecutive iterations |
| 5 | **Continue** | None of the above -- keep iterating |

## Common Patterns

**"Evolve the pptx skill"**
> Need `--skill pptx` and `--skill-path /path/to/pptx/SKILL.md`.
> If the user hasn't specified the path, search for the SKILL.md file
> in the workspace or ask.

**"Just show me what would change"**
> Use `--dry-run` to preview proposals without deploying.

**"The evolution didn't help enough"**
> Check the eval set quality. Missing contextual examples will limit
> what evolution can learn. Generate a richer eval set first.

**"Evolution keeps failing validation"**
> Lower `--confidence` slightly or increase `--max-iterations`.
> Also check if the eval set has contradictory expectations.

**"Which agent is being used?"**
> The evolve command auto-detects your installed agent CLI.
> Use `--agent <name>` to override (claude, codex, opencode).
