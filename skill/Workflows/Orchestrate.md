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

**User asks to improve skills or run the full loop**
> Run `selftune orchestrate`. Parse the JSON output from stdout and the
> phased report from stderr. Report the summary to the user.

**User wants to preview changes before deploying**
> Run `selftune orchestrate --dry-run`. Report the planned actions without
> making any changes.

**User wants to focus on a single skill**
> Run `selftune orchestrate --skill <name>`. This limits the loop to the
> specified skill only.

**User wants manual review before deployment**
> Run `selftune orchestrate --review-required`. Validated changes stay in
> review mode instead of auto-deploying.

**Agent needs fresh source data before orchestrating**
> Run `selftune orchestrate --sync-force`. This forces a full source replay
> before candidate selection.

## Output

### Human-readable report (stderr)

A phased decision report printed to stderr so you can see exactly what happened and why:

1. **Phase 1: Sync** — which sources were scanned, how many records synced, repair counts
2. **Phase 2: Status** — skill count, system health, breakdown by status category
3. **Phase 3: Skill Decisions** — each skill with its action (EVOLVE / WATCH / SKIP) and reason
4. **Phase 4: Evolution Results** — validation pass-rate changes (before → after), deployment status
5. **Phase 5: Watch** — post-deploy monitoring with alert and rollback indicators
6. **Summary** — evaluated/deployed/watched/skipped counts and elapsed time

A mode banner at the top shows DRY RUN, REVIEW, or AUTONOMOUS with rerun hints when applicable.

### JSON output (stdout)

Machine-readable JSON with the summary fields plus a `decisions` array containing per-skill:

- `skill`, `action`, `reason`
- `deployed`, `evolveReason`, `validation` (before/after pass rates, improved flag) — when evolved
- `alert`, `rolledBack`, `passRate`, `recommendation` — when watched

This is the recommended runtime for recurring autonomous scheduling.

## Two Execution Contexts

`selftune orchestrate` runs in two contexts with different callers:

| Context | Caller | Token cost | When |
|---------|--------|------------|------|
| **Interactive** | Agent (user says "improve my skills") | Uses agent subscription | On demand |
| **Automated (cron)** | OS scheduler (cron/launchd/systemd) | No agent session; LLM cost only if evolution triggers | Every 6 hours |
| **Automated (loop)** | `selftune orchestrate --loop` | No agent session; LLM cost only if evolution triggers | Configurable interval |

In automated mode, the OS calls the CLI binary directly. No agent session
is created. LLM calls only happen during the evolution step (proposing and
validating description changes), which uses the configured model tier.
The orchestrate logic itself (sync, status, candidate selection) is pure
data processing with zero token cost.

**Cron mode:** Install OS-level scheduling with `selftune cron setup`.
Runs as separate invocations on a schedule (default: every 6 hours).

**Loop mode:** Run `selftune orchestrate --loop` for a long-running process
that cycles continuously. Use `--loop-interval <seconds>` to set the pause
between cycles (default: 3600s / 1 hour, minimum: 60s). Stop with Ctrl+C
or SIGTERM — the current cycle finishes before exit.

### Signal-Reactive Trigger

When improvement signals are detected during a session (corrections, explicit
requests, manual invocations), the `session-stop` hook automatically spawns a
focused `selftune orchestrate --max-skills 2` run in the background. This
reactive path complements the scheduled cron/loop modes by responding to signals
immediately after the session that produced them.

Guard rails:
- Only spawns if unconsumed signals exist in `improvement_signals.jsonl`
- Respects the orchestrate lock file — skips if another run started within 30 minutes
- Fire-and-forget: the hook exits immediately, orchestrate runs independently
- Silent failure: any error is swallowed so the hook never blocks Claude

### Internal Workflow Chain (Autonomous Mode)

In autonomous mode, orchestrate calls sub-workflows in this fixed order:

1. **Sync** — refresh source-truth telemetry across all supported agents (`selftune sync`)
2. **Status** — compute skill health using existing grade results (reads `grading.json` outputs from previous sessions)
3. **Evolve** — run evolution on selected candidates (pre-flight is skipped, cheap-loop mode enabled, defaults used)
4. **Watch** — monitor recently evolved skills (auto-rollback enabled by default, `--recent-window` hours lookback)

All sub-workflows run with defaults and no user interaction. The safety
model relies on regression thresholds, automatic rollback, and SKILL.md
backups rather than human confirmation.
