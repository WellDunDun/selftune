# selftune Evolve Workflow

Improve a skill's description based on real usage signal. Analyzes failure
patterns from eval sets and proposes description changes that catch more
natural-language queries without breaking existing triggers.

## When to Invoke

Invoke this workflow when the user requests any of the following:

- Improving or evolving a skill's trigger coverage
- Fixing undertriggering or missed queries for a skill
- Optimizing a skill description based on usage data
- Any request containing "evolve", "improve triggers", or "fix skill matching"

## Default Command

```bash
selftune evolve --skill <name> --skill-path <path> [options]
```

## Options

| Flag                         | Description                                                             | Default                        |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| `--skill <name>`             | Skill name                                                              | Required                       |
| `--skill-path <path>`        | Path to the skill's SKILL.md                                            | Required                       |
| `--eval-set <path>`          | Pre-built eval set JSON                                                 | Auto-generated from logs       |
| `--agent <name>`             | Agent CLI to use (claude, codex, opencode)                              | Auto-detected                  |
| `--dry-run`                  | Propose and validate without deploying                                  | Off                            |
| `--confidence <n>`           | Minimum confidence threshold (0-1)                                      | 0.6                            |
| `--max-iterations <n>`       | Maximum retry iterations                                                | 3                              |
| `--validation-model <model>` | Model for trigger-check validation LLM calls                            | `haiku`                        |
| `--pareto`                   | Generate multiple candidates per iteration                              | Off                            |
| `--candidates <n>`           | Number of candidates per iteration (with `--pareto`)                    | 3                              |
| `--token-efficiency`         | Optimize for token efficiency in proposals                              | Off                            |
| `--with-baseline`            | Include a no-skill baseline comparison                                  | Off                            |
| `--cheap-loop`               | Use cheap models for loop, expensive for final gate                     | On                             |
| `--full-model`               | Use full-cost model throughout (disables cheap-loop)                    | Off                            |
| `--verbose`                  | Print detailed progress during evolution                                | Off                            |
| `--gate-model <model>`       | Model for final gate validation                                         | `sonnet` (when `--cheap-loop`) |
| `--proposal-model <model>`   | Model for proposal generation LLM calls                                 | None                           |
| `--sync-first`               | Refresh source-truth telemetry before generating evals/failure patterns | Off                            |
| `--sync-force`               | Force a full source rescan during `--sync-first`                        | Off                            |

## Output Format

Each evolution action is logged to `~/.claude/evolution_audit_log.jsonl`.
See `references/logs.md` for the audit log schema.

### Proposal Output (dry-run or pre-deploy)

```json
{
  "proposal_id": "evolve-pptx-1709125200000",
  "skill_name": "pptx",
  "iteration": 1,
  "original_pass_rate": 0.7,
  "proposed_pass_rate": 0.92,
  "regression_count": 0,
  "confidence": 0.85,
  "status": "validated",
  "changes_summary": "Added implicit triggers: 'slide deck', 'presentation', 'board meeting slides'"
}
```

### Audit Log Entries

The evolution process writes multiple audit entries:

| Action      | When                             | Key details                                       |
| ----------- | -------------------------------- | ------------------------------------------------- |
| `created`   | Proposal generated               | `details` contains `original_description:` prefix |
| `validated` | Proposal tested against eval set | `eval_snapshot` with before/after pass rates      |
| `deployed`  | Updated SKILL.md written to disk | `eval_snapshot` with final rates                  |

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

### 0. Pre-Flight Configuration

Before running the evolve command, use the `AskUserQuestion` tool to present structured configuration options. If the user responds with "use defaults" or similar shorthand, skip to step 1 using the recommended defaults. If the user cancels, stop and do not continue.

Ask one `AskUserQuestion` at a time in this order:

1. `Execution Mode`
   Options:
   - `Dry run — preview without deploying (recommended for first run)`
   - `Live — validate and deploy if improved`
2. `Model Tier (see SKILL.md reference)`
   Options:
   - `Fast (haiku) — cheapest, ~2s/call (recommended with cheap-loop)`
   - `Balanced (sonnet) — good quality, ~5s/call`
   - `Best (opus) — highest quality, ~10s/call`
3. `Cost Optimization`
   Options:
   - `Cheap loop — haiku for iteration, sonnet for final gate (recommended)`
   - `Single model — use one model throughout`
4. `Advanced Options`
   Options:
   - `Defaults (0.6 confidence, 3 iterations, single candidate) (recommended)`
   - `Stricter (0.7 confidence, 5 iterations)`
   - `Pareto mode (multiple candidates per iteration)`

If `AskUserQuestion` is not available or Claude does not invoke it, fall back to presenting the same choices as inline numbered options.

If the user cancels, stop -- do not proceed with defaults. If the user selects "use defaults", skip to step 1 with recommended defaults.

After the user responds, parse their selections and map each choice to the corresponding CLI flags:

| Selection         | CLI Flag                    |
| ----------------- | --------------------------- |
| 1a (dry run)      | `--dry-run`                 |
| 1b (live)         | _(no flag)_                 |
| 2a (haiku)        | `--validation-model haiku`  |
| 2b (sonnet)       | `--validation-model sonnet` |
| 2c (opus)         | `--validation-model opus`   |
| 3a (cheap loop)   | `--cheap-loop`              |
| 3b (single model) | _(no flag)_                 |
| Custom confidence | `--confidence <value>`      |
| Custom iterations | `--max-iterations <value>`  |
| 6b (pareto)       | `--pareto`                  |

Show a confirmation summary to the user:

```
Configuration Summary:
  Mode:        dry-run
  Model:       haiku (cheap-loop: sonnet gate)
  Confidence:  0.6
  Iterations:  3
  Pareto:      off

Proceeding...
```

Build the CLI command string with all selected flags and continue to step 1.

### 1. Read Evolution Context

Before running, read `~/.selftune/memory/context.md` for session context:

- Active evolutions and their current status
- Known issues from previous runs
- Last update timestamp

This provides continuity across context resets. If the file doesn't exist,
proceed normally -- it will be created after the first evolution.

The evolution-guard hook (`hooks/evolution-guard.ts`) blocks direct SKILL.md
edits on monitored skills during active evolution. This prevents conflicting
changes while the evolve process is running. The guard is automatically
engaged when evolve starts and released when it completes.

### 2. Refresh Source Truth (Recommended)

If the host has accumulated significant agent activity or is known to be
polluted, prefer:

```bash
selftune evolve --skill <name> --skill-path <path> --sync-first
```

`--sync-first` runs the authoritative transcript/rollout sync before eval-set
generation and failure-pattern extraction. Use `--sync-force` when you need
to ignore markers and rescan everything.

### 3. Load or Generate Eval Set

If `--eval-set` is provided, use it directly. Otherwise, the command
generates one from logs (equivalent to running `evals --skill <name>`).

An eval set is required for validation. Without enough telemetry data,
evolution cannot reliably measure improvement.

### 4. Extract Failure Patterns

The command groups missed queries by invocation type:

- Missed explicit: description is broken (rare, high priority)
- Missed implicit: description is too narrow (common, evolve target)
- Missed contextual: description lacks domain vocabulary (evolve target)

See `references/invocation-taxonomy.md` for the taxonomy.

### 4b. Constitutional Pre-Validation Gate

Before any LLM-based validation, each proposal passes through a
deterministic constitutional check that rejects obviously bad proposals
at zero cost. Four principles are enforced:

1. **Size constraint** — description must be ≤1024 characters and within
   0.3x–3.0x word count of the original.
2. **No XML injection** — reject proposals containing XML/HTML tags.
3. **No unbounded broadening** — reject bare "all", "any", "every",
   "everything" unless qualified by enumeration markers ("including",
   "such as", "like", "e.g.", or a comma-separated list).
4. **Anchor preservation** — if the original contains `USE WHEN` trigger
   phrases or `$skillName` references, those must appear in the proposal.

If a proposal fails any principle, it is rejected with a descriptive
violation message and the pipeline retries (if iterations remain).

For body evolution (`evolve body`), only the size constraint applies.

### 5. Propose Description Changes

An LLM generates a candidate description that would catch the missed
queries. The candidate:

- Preserves existing trigger phrases that work
- Adds new phrases covering missed patterns
- Maintains the description's structure and tone

### 6. Validate Against Eval Set

The candidate is tested against the full eval set:

- Must improve overall pass rate
- Must not regress more than 5% on previously-passing entries
- Must exceed the `--confidence` threshold

If validation fails, the command retries up to `--max-iterations` times
with adjusted proposals.

### Aggregate Metrics To Report

When summarizing an evolution run, include these aggregate metrics rather
than only saying "passed" or "failed":

| Metric                          | Meaning                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `original_pass_rate`            | Baseline pass rate before the proposal                                       |
| `proposed_pass_rate`            | Pass rate after applying the proposal                                        |
| `regression_count`              | Eval entries that passed before and failed after                             |
| `net_change`                    | Total passes gained minus regressions introduced                             |
| `iteration` / `iterations_used` | Which retry produced the current candidate                                   |
| `baseline_lift`                 | Additional lift over the no-skill baseline when `--with-baseline` is enabled |

These metrics explain whether the proposal is genuinely better, merely
different, or too risky to deploy.

### 7. Deploy (or Preview)

If `--dry-run`, the proposal is printed but not deployed. The audit log
still records `created` and `validated` entries for review.

If deploying:

1. The current SKILL.md is backed up to `SKILL.md.bak`
2. The updated description is written to SKILL.md
3. A `deployed` entry is logged to the evolution audit

### 8. Update Memory

After evolution completes (deploy or dry-run), the memory writer updates:

- `~/.selftune/memory/context.md` -- records the evolution outcome and current state
- `~/.selftune/memory/decisions.md` -- logs the decision rationale and proposal details

This ensures the next evolve, watch, or rollback workflow has full context
even after a context window reset.

### Description Quality Scoring

Proposals are scored on heuristic quality criteria (no LLM required). The composite score (0.0–1.0) uses five weighted criteria: trigger context (0.30), vagueness absence (0.20), specificity (0.20), length (0.15), and not-just-name (0.15). Proposals that regress in quality score are rejected. See `docs/design-docs/evolution-pipeline.md` for full criteria details.

### Stopping Criteria

The evolution loop stops when any of these conditions is met (priority order):

| #   | Condition          | Meaning                                             |
| --- | ------------------ | --------------------------------------------------- |
| 1   | **Converged**      | Pass rate >= 0.95                                   |
| 2   | **Max iterations** | Reached `--max-iterations` limit                    |
| 3   | **Low confidence** | Proposal confidence below `--confidence` threshold  |
| 4   | **Plateau**        | Pass rate unchanged across 3 consecutive iterations |
| 5   | **Continue**       | None of the above -- keep iterating                 |

## Cheap Loop Mode

The `--cheap-loop` flag runs the entire evolution loop with cheap models (haiku)
and only uses an expensive model (sonnet) for a final gate validation before
deploying. This reduces cost while maintaining deployment quality.

When `--cheap-loop` is set:

- `--proposal-model` defaults to `haiku`
- `--validation-model` defaults to `haiku`
- `--gate-model` defaults to `sonnet`

The gate validation is a new step between validation and deploy. It re-runs
`validateProposal` using the gate model. If the gate fails, the proposal is
not deployed.

```bash
# Cheap loop with default models
selftune evolve --skill X --skill-path Y --cheap-loop

# Cheap loop with opus gate
selftune evolve --skill X --skill-path Y --cheap-loop --gate-model opus

# Manual model control without cheap-loop
selftune evolve --skill X --skill-path Y --proposal-model haiku --validation-model sonnet
```

## Common Patterns

**User asks to evolve a specific skill (e.g., "evolve the pptx skill"):**
Requires `--skill pptx` and `--skill-path /path/to/pptx/SKILL.md`.
If the user has not specified the path, search for the SKILL.md file
in the workspace. If not found, ask the user for the path.

**User wants a preview without deployment (e.g., "just show me what would change"):**
Add `--dry-run` to preview proposals without deploying.

**Evolution results are insufficient:**
Check the eval set quality. Missing contextual examples limit
what evolution can learn. Generate a richer eval set first using the Evals workflow.

**Evolution keeps failing validation:**
Lower `--confidence` slightly or increase `--max-iterations`.
Also check if the eval set has contradictory expectations.

**Agent CLI override needed:**
The evolve command auto-detects the installed agent CLI.
Use `--agent <name>` to override (claude, codex, opencode).

## Subagent Escalation

For high-stakes evolutions, read `skill/agents/evolution-reviewer.md` and spawn a
subagent with those instructions to review the proposal before deploying.
This is especially valuable when the skill has a history of regressions,
the evolution touches many trigger phrases, or the confidence score is near
the threshold.

## Autonomous Mode

When called by `selftune orchestrate` (via cron or --loop), evolution runs
without user interaction:

- Pre-flight is skipped entirely — defaults are used
- The orchestrator selects candidate skills based on health scores
- Evolution uses cheap-loop mode (Haiku) by default
- Validation runs automatically against the eval set
- Deploy happens if validation passes the regression threshold
- Results are logged to orchestrate-runs.jsonl

No user confirmation is needed. The safety controls (regression threshold,
auto-rollback via watch, SKILL.md backup) provide the guardrails.
