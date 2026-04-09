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

Autonomous evolve settings used by orchestrate:

```text
confidenceThreshold = 0.6
maxIterations = 3
paretoEnabled = true
candidateCount = 3
tokenEfficiencyEnabled = false
withBaseline = false
validationModel = haiku
cheapLoop = true
gateModel = sonnet
adaptiveGate = true
proposalModel = haiku
```

## Flags

| Flag                        | Description                                                | Default    |
| --------------------------- | ---------------------------------------------------------- | ---------- |
| `--dry-run`                 | Plan and validate without deploying changes                | Off        |
| `--review-required`         | Keep validated changes in review mode instead of deploying | Off        |
| `--auto-approve`            | _(Deprecated)_ Autonomous mode is now the default          | —          |
| `--skill <name>`            | Limit the loop to one skill                                | All skills |
| `--max-skills <n>`          | Cap how many candidates are processed in one run           | `5`        |
| `--recent-window <hours>`   | Window for post-deploy watch/rollback checks               | `48`       |
| `--sync-force`              | Force a full source replay before candidate selection      | Off        |
| `--max-auto-grade <n>`      | Max ungraded skills to auto-grade per run (0 to disable)   | `5`        |
| `--loop`                    | Run as a long-lived process that cycles continuously       | Off        |
| `--loop-interval <seconds>` | Pause between cycles (minimum 60)                          | `3600`     |

## Default Behavior

- Sync source-truth telemetry first
- Auto-grade up to 5 ungraded skills that have session data (enables evolution on first run after ingest)
- Prioritize critical/warning/ungraded skills with real missed-query signal
- Deploy validated low-risk description changes automatically
- Generate review-first new skill proposals from strong workflow patterns
- Watch recent deployments and roll back regressions automatically
- Upload personal telemetry to cloud (alpha users)
- Flush staged creator-directed contribution signals for opted-in skills

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
3. **Auto-grade** — how many ungraded skills were graded (logged to stderr, included in summary)
4. **Phase 3: Skill Decisions** — each skill with its action (EVOLVE / WATCH / SKIP) and reason
5. **Phase 4: Evolution Results** — validation pass-rate changes (before → after), deployment status
6. **Phase 5: Watch** — post-deploy monitoring with alert and rollback indicators
7. **Summary** — auto-graded/evaluated/deployed/watched/skipped counts and elapsed time

A mode banner at the top shows DRY RUN, REVIEW, or AUTONOMOUS with rerun hints when applicable.

### JSON output (stdout)

Machine-readable JSON with the summary fields plus a `decisions` array containing per-skill:

- `skill`, `action`, `reason`
- `deployed`, `evolveReason`, `validation` (before/after pass rates, improved flag) — when evolved
- `alert`, `rolledBack`, `passRate`, `recommendation` — when watched

This is the recommended runtime for recurring autonomous scheduling.

## Two Execution Contexts

`selftune orchestrate` runs in two contexts with different callers:

| Context              | Caller                                | Token cost                                            | When                  |
| -------------------- | ------------------------------------- | ----------------------------------------------------- | --------------------- |
| **Interactive**      | Agent (user says "improve my skills") | Uses agent subscription                               | On demand             |
| **Automated (cron)** | OS scheduler (cron/launchd/systemd)   | No agent session; LLM cost only if evolution triggers | Every 6 hours         |
| **Automated (loop)** | `selftune orchestrate --loop`         | No agent session; LLM cost only if evolution triggers | Configurable interval |

In automated mode, the OS calls the CLI binary directly. No agent session
is created. Outside of the regular sync/status/candidate-selection logic,
LLM calls can come from auto-grading ungraded skills and from the evolution
step itself. By default, orchestrate runs proposal generation and validation
on `haiku`, then re-runs the final gate on `sonnet` before deploy. Risky
candidates are escalated to `opus` with `high` effort for the gate only.

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
3. **Auto-grade** — grade up to `--max-auto-grade` (default 5) ungraded skills that have session data but no grades yet. Skipped during `--dry-run` (grading makes LLM calls). After grading, status is recomputed so candidate selection sees updated grades. Fail-open: individual grading errors are logged but never block the loop.
4. **Evolve** — run evolution on selected candidates (pre-flight is skipped; Pareto mode uses 3 candidates; cheap-loop uses `haiku` for proposal + validation and `sonnet` for the final gate; adaptive gate escalation promotes risky proposals to `opus` + `high` effort; baseline and token-efficiency stay off)
5. **Watch** — monitor recently evolved skills (auto-rollback enabled by default, `--recent-window` hours lookback)
6. **Workflow proposals** — discover repeated multi-skill patterns and create review-first `new_skill` proposals when a workflow is strong enough to merit codification. These are never auto-deployed; they are surfaced as proposals for review.
7. **Alpha Upload** — if enrolled in the alpha program (`config.alpha.enrolled === true`) and an API key is configured, stage new canonical records (sessions, invocations, evolution evidence, orchestrate runs) into `canonical_upload_staging`, build V2 push payloads, and flush to the cloud API (`POST /api/v1/push`) with Bearer auth. Fail-open: upload errors never block the orchestrate loop. Respects `--dry-run`.

When orchestrate invokes evolve for a selected candidate, it always passes
`confidenceThreshold: 0.6` and `maxIterations: 3`, plus the autonomous evolve
defaults listed above. Those defaults are the recurring-run policy for the
autonomy-first loop; there are no orchestrate flags to override them per run.

Between candidate selection and evolution, orchestrate checks for
**cross-skill eval set overlap**. When two or more evolution candidates
share >30% of their positive eval queries, a warning is logged to stderr.
This is an informational diagnostic only — it does not block evolution.

All sub-workflows run with defaults and no user interaction. The safety
model relies on regression thresholds, automatic rollback, and SKILL.md
backups rather than human confirmation.
