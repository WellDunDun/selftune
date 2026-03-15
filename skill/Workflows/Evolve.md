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

| Flag | Description | Default |
|------|-------------|---------|
| `--skill <name>` | Skill name | Required |
| `--skill-path <path>` | Path to the skill's SKILL.md | Required |
| `--eval-set <path>` | Pre-built eval set JSON | Auto-generated from logs |
| `--agent <name>` | Agent CLI to use (claude, codex, opencode) | Auto-detected |
| `--dry-run` | Propose and validate without deploying | Off |
| `--confidence <n>` | Minimum confidence threshold (0-1) | 0.6 |
| `--max-iterations <n>` | Maximum retry iterations | 3 |
| `--validation-model <model>` | Model for trigger-check validation LLM calls | `haiku` |
| `--cheap-loop` | Use cheap models for loop, expensive for final gate | Off |
| `--gate-model <model>` | Model for final gate validation | `sonnet` (when `--cheap-loop`) |
| `--proposal-model <model>` | Model for proposal generation LLM calls | None |
| `--sync-first` | Refresh source-truth telemetry before generating evals/failure patterns | Off |
| `--sync-force` | Force a full source rescan during `--sync-first` | Off |

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

### 0. Pre-Flight Configuration

Before running the evolve command, present numbered configuration options to the user inline in your response, then wait for the user's answer before proceeding.

If the user responds with "use defaults", "just run it", or similar shorthand, skip to step 1 using the recommended defaults marked below.

Present the following options inline in your response:

1. **Execution Mode**
   - a) Dry run — preview proposal without deploying (recommended for first run)
   - b) Live — validate and deploy if improved

2. **Model Tier** (see SKILL.md Model Tier Reference)
   - a) Fast (haiku) — cheapest, ~2s/call (recommended with cheap-loop)
   - b) Balanced (sonnet) — good quality, ~5s/call
   - c) Best (opus) — highest quality, ~10s/call

3. **Cost Optimization**
   - a) Cheap loop — haiku for iteration, sonnet for final gate (recommended)
   - b) Single model — use one model throughout

4. **Confidence Threshold:** 0.6 (default, higher = stricter)

5. **Max Iterations:** 3 (default, more = longer but better results)

6. **Multi-Candidate Selection**
   - a) Single candidate — one proposal per iteration (recommended)
   - b) Pareto mode — generate multiple candidates, pick best on frontier

Ask: "Reply with your choices (e.g., '1a, 2a, 3a, defaults for rest') or 'use defaults' for recommended settings."

After the user responds, parse their selections and map each choice to the corresponding CLI flags:

| Selection | CLI Flag |
|-----------|----------|
| 1a (dry run) | `--dry-run` |
| 1b (live) | _(no flag)_ |
| 2a (haiku) | `--validation-model haiku` |
| 2b (sonnet) | `--validation-model sonnet` |
| 2c (opus) | `--validation-model opus` |
| 3a (cheap loop) | `--cheap-loop` |
| 3b (single model) | _(no flag)_ |
| Custom confidence | `--confidence <value>` |
| Custom iterations | `--max-iterations <value>` |
| 6b (pareto) | _(pareto mode flag)_ |

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

### Stopping Criteria

The evolution loop stops when any of these conditions is met (priority order):

| # | Condition | Meaning |
|---|-----------|---------|
| 1 | **Converged** | Pass rate >= 0.95 |
| 2 | **Max iterations** | Reached `--max-iterations` limit |
| 3 | **Low confidence** | Proposal confidence below `--confidence` threshold |
| 4 | **Plateau** | Pass rate unchanged across 3 consecutive iterations |
| 5 | **Continue** | None of the above -- keep iterating |

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

For high-stakes evolutions, consider spawning the `evolution-reviewer` agent
as a subagent to review the proposal before deploying. This is especially
valuable when the skill has a history of regressions, the evolution touches
many trigger phrases, or the confidence score is near the threshold.

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
