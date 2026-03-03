# selftune Cron Workflow

Manage OpenClaw cron jobs that run the selftune pipeline on a schedule.
Enables fully autonomous skill evolution — skills improve while you sleep.

## When to Use

- Setting up selftune automation for the first time on OpenClaw
- Checking which cron jobs are registered
- Removing selftune cron jobs (cleanup or reconfiguration)
- Enabling the autonomous observe-grade-evolve-deploy loop

## Prerequisites

OpenClaw must be installed and in your PATH. The setup command will check
for this and exit with instructions if OpenClaw is not found.

```bash
which openclaw    # Must resolve
```

## Default Command

```bash
selftune cron setup
```

## Subcommands

### `selftune cron setup`

Register the default selftune cron jobs with OpenClaw.

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Preview commands without registering jobs | Off |
| `--tz <timezone>` | IANA timezone for job schedules | Flag > `TZ` env > system timezone |

### `selftune cron list`

Show all registered selftune cron jobs. Reads from
`~/.openclaw/cron/jobs.json` and filters for `selftune-*` entries.
No flags.

### `selftune cron remove`

Remove all selftune cron jobs from OpenClaw.

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Preview which jobs would be removed without deleting | Off |

## Default Job Schedule

Setup registers these four jobs:

| Name | Cron Expression | Schedule | Description |
|------|----------------|----------|-------------|
| `selftune-ingest` | `*/30 * * * *` | Every 30 minutes | Ingest new sessions from OpenClaw transcripts |
| `selftune-status` | `0 8 * * *` | Daily at 8am | Health check — report skills with pass rate below 80% |
| `selftune-evolve` | `0 3 * * 0` | Weekly at 3am Sunday | Full evolution pipeline for undertriggering skills |
| `selftune-watch` | `0 */6 * * *` | Every 6 hours | Monitor recently evolved skills for regressions |

All jobs run in **isolated session** mode — each execution gets a clean
session with no context accumulation from previous runs.

## Output

- **setup:** Registers jobs via `openclaw cron add` and confirms each registration
- **list:** Prints a formatted table of registered selftune cron jobs (name, schedule, description)
- **remove:** Deletes each selftune cron job via `openclaw cron remove` and confirms

Jobs persist at `~/.openclaw/cron/jobs.json` and survive OpenClaw restarts.

## Steps

1. Run `selftune cron setup --dry-run` to preview what would be registered
2. Run `selftune cron setup` to register the default jobs
3. Run `selftune cron list` to verify jobs are registered
4. Wait for the first cron cycle to fire (ingest runs every 30 minutes)
5. Check results with `selftune status` after the first daily health check

## The Autonomous Evolution Loop

When cron jobs are active, selftune operates as a self-correcting system:

```
Cron fires (isolated session)
    |
    v
Agent runs selftune pipeline (ingest -> status -> evolve -> watch)
    |
    v
Improved SKILL.md written to disk
    |
    v
OpenClaw file watcher detects change (250ms debounce)
    |
    v
Skill snapshot version bumped — next agent turn uses updated description
    |
    v
Better triggering in real-time, no restart needed
```

The four jobs form a continuous loop:
- **ingest** captures raw session data every 30 minutes
- **status** identifies undertriggering skills daily
- **evolve** proposes and deploys improvements weekly
- **watch** monitors for regressions every 6 hours and auto-rolls back if needed

Skills improve and take effect within seconds of the cron job completing.
No deployment step, no restart, no manual intervention.

## Safety Controls

| Control | How It Works |
|---------|-------------|
| Dry-run first | `selftune cron setup --dry-run` previews commands before registering |
| Regression threshold | Evolution only deploys if improvement exceeds 5% on existing triggers |
| Auto-rollback | `selftune watch` automatically rolls back if pass rate drops below baseline minus threshold |
| Audit trail | Every evolution recorded in `evolution_audit_log.jsonl` with full history |
| SKILL.md backup | `.bak` file created before every deploy — primary rollback path exists via .bak; fallback depends on audit metadata integrity |
| Isolated sessions | Each cron run gets a clean session (no context pollution between runs) |
| Human override | `selftune rollback --skill <name> --skill-path <path>` available anytime to manually revert |
| Pin descriptions | Config flag to freeze specific skills and prevent evolution on sensitive skills |

## Common Patterns

**"Set up autonomous skill evolution"**
> Run `selftune cron setup`. The four default jobs handle ingestion,
> health checks, evolution, and regression monitoring.

**"Preview before registering"**
> Run `selftune cron setup --dry-run` to see exactly what commands
> would be executed without registering anything.

**"Use a specific timezone"**
> Run `selftune cron setup --tz America/New_York`. Without the flag,
> timezone resolution is: `--tz` flag > `TZ` environment variable > system timezone.

**"What jobs are registered?"**
> Run `selftune cron list`. Shows a table of all selftune cron jobs
> with their schedules and descriptions.

**"Remove all cron automation"**
> Run `selftune cron remove`. Preview first with `selftune cron remove --dry-run`.

**"A skill regressed after cron evolution"**
> The watch job should catch this automatically. If not, run
> `selftune rollback --skill <name>` manually. See `Workflows/Rollback.md`.

**"How do I know the cron loop is working?"**
> Run `selftune status` after the first daily health check fires (8am).
> Check `evolution_audit_log.jsonl` for entries with recent timestamps.
