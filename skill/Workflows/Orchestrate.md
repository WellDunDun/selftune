# selftune Orchestrate Workflow

Run the autonomy-first selftune loop in one command.

`selftune orchestrate` is the primary closed-loop entrypoint. It runs
source-truth sync, computes current skill health, selects candidates,
deploys validated low-risk description changes autonomously, and watches
recent changes with auto-rollback enabled.

## When to Use

- You want the full autonomous loop, not isolated subcommands
- You want to improve skills without manually chaining `sync`, `status`, `evolve`, and `watch`
- You want a dry-run of what selftune would change next
- You want a stricter review policy for a single run

## Default Command

```bash
selftune orchestrate
```

## Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Plan and validate without deploying changes | Off |
| `--review-required` | Keep validated changes in review mode instead of deploying | Off |
| `--skill <name>` | Limit the loop to one skill | All skills |
| `--max-skills <n>` | Cap how many candidates are processed in one run | `3` |
| `--recent-window <hours>` | Window for post-deploy watch/rollback checks | `24` |
| `--sync-force` | Force a full source replay before candidate selection | Off |

## Default Behavior

- Sync source-truth telemetry first
- Prioritize critical/warning/ungraded skills with real missed-query signal
- Deploy validated low-risk description changes automatically
- Watch recent deployments and roll back regressions automatically

Use `--review-required` only when you want a stricter policy for a specific run.

## Common Patterns

**"Run the full loop now"**
> Run `selftune orchestrate`.

**"Show me what would change first"**
> Run `selftune orchestrate --dry-run`.

**"Only work on one skill"**
> Run `selftune orchestrate --skill selftune`.

**"Keep review in the loop for this run"**
> Run `selftune orchestrate --review-required`.

**"Force a full replay before acting"**
> Run `selftune orchestrate --sync-force`.

## Output

The command prints:

- sync results
- candidate-selection reasoning
- evolve/watch actions taken
- skipped skills and why
- a final summary with counts and elapsed time

This is the recommended runtime for recurring autonomous scheduling.
