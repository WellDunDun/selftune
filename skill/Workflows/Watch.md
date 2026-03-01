# selftune Watch Workflow

Monitor post-deploy skill performance for regressions. Compares current
pass rates against a baseline within a sliding window of recent sessions.

## Default Command

```bash
selftune watch --skill <name> --skill-path <path> [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--skill <name>` | Skill name | Required |
| `--skill-path <path>` | Path to the skill's SKILL.md | Required |
| `--window <n>` | Sliding window size (number of sessions) | 20 |
| `--threshold <n>` | Regression threshold (drop from baseline) | 0.1 |
| `--baseline <n>` | Explicit baseline pass rate (0-1) | Auto-detected from last deploy |
| `--auto-rollback` | Automatically rollback on detected regression | Off |

## Output Format

```json
{
  "skill_name": "pptx",
  "window_size": 20,
  "sessions_evaluated": 18,
  "current_pass_rate": 0.89,
  "baseline_pass_rate": 0.92,
  "threshold": 0.1,
  "regression_detected": false,
  "delta": -0.03,
  "status": "healthy",
  "evaluated_at": "2026-02-28T14:00:00Z"
}
```

### Status Values

| Status | Meaning |
|--------|---------|
| `healthy` | Current pass rate is within threshold of baseline |
| `warning` | Pass rate dropped but within threshold |
| `regression` | Pass rate dropped below baseline minus threshold |
| `insufficient_data` | Not enough sessions in the window to evaluate |

## Parsing Instructions

### Check Regression Status

```bash
# Parse: .regression_detected (boolean)
# Parse: .status (string)
# Parse: .delta (float, negative = regression)
```

### Get Key Metrics

```bash
# Parse: .current_pass_rate vs .baseline_pass_rate
# Parse: .sessions_evaluated (should be close to .window_size)
```

## Steps

### 0. Read Evolution Context

Before starting, read `~/.selftune/memory/context.md` for session context:
- Active evolutions and their current status
- Known issues and regression history
- Last update timestamp

This provides continuity across context resets. If the file doesn't exist,
proceed normally -- it will be created after the first watch.

The evolution-guard hook prevents conflicting SKILL.md edits while watch is
evaluating the skill. The auto-activation system uses watch results to
adjust suggestion confidence -- skills showing regressions get flagged for
attention in subsequent prompts.

### 1. Run Watch

```bash
selftune watch --skill pptx --skill-path /path/to/SKILL.md
```

### 2. Check Regression Status

Parse the JSON output. Key decision points:

| Status | Action |
|--------|--------|
| `healthy` | No action needed. Skill is performing well. |
| `warning` | Monitor closely. Consider re-running after more sessions. |
| `regression` | Investigate. Consider rollback. |
| `insufficient_data` | Wait for more sessions before evaluating. |

### 3. Decide Action

If regression is detected:
- Review recent session transcripts to understand what changed
- Check if the eval set is still representative
- Run `rollback` if the regression is confirmed (see `Workflows/Rollback.md`)

If `--auto-rollback` was set, the command automatically restores the
previous description and logs a `rolled_back` entry.

### 4. Report

Summarize the snapshot for the user:
- Current pass rate vs baseline
- Number of sessions evaluated
- Whether regression was detected
- Recommended action

### 5. Update Memory

After watch completes, the memory writer updates
`~/.selftune/memory/context.md` with the current regression status,
pass rates, and recommended next action. This ensures continuity if the
context window resets before the user acts on the results.

## Common Patterns

**"Is the skill performing well after the change?"**
> Run watch with the skill name and path. Report the snapshot.

**"Check for regressions"**
> Same as above. Focus on the `regression_detected` and `delta` fields.

**"How is the skill doing?"**
> Run watch. If `insufficient_data`, tell the user to wait for more
> sessions before drawing conclusions.

**"Auto-rollback if it regresses"**
> Use `--auto-rollback`. The command will restore the previous description
> automatically if pass rate drops below baseline minus threshold.

**"Set a custom baseline"**
> Use `--baseline 0.85` to override auto-detection. Useful when the
> auto-detected baseline is from an older evolution.
