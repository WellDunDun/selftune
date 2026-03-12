# selftune Schedule Workflow

Generate ready-to-use scheduling examples for automating selftune with
standard system tools. This is the **primary automation path** — it works
on any machine without requiring a specific agent runtime.

For OpenClaw-specific scheduling, see `Workflows/Cron.md`.

## When to Use

- Setting up selftune automation for the first time
- Generating crontab entries for a Linux/macOS server
- Creating a launchd plist for a macOS machine
- Creating a systemd timer for a Linux server
- Understanding the selftune automation loop

## The Automation Loop

The core selftune automation loop is four commands:

```
sync → status → evolve --sync-first → watch --sync-first
```

1. **sync** refreshes source-truth telemetry from all agent sources
2. **status** reports skill health (run after sync)
3. **evolve --sync-first** improves underperforming skills (syncs before analyzing)
4. **watch --sync-first** monitors recently evolved skills for regressions

## Default Command

```bash
selftune schedule
```

Outputs examples for all three scheduling systems (cron, launchd, systemd).

## Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--format <type>` | Output only one format: `cron`, `launchd`, or `systemd` | All formats |
| `--help` | Show help message | — |

## Steps

1. Run `selftune schedule` to see all examples
2. Pick the scheduling system for your platform
3. Customize the snippets (skill names, paths, timezone)
4. Install using the instructions in the output

## Common Patterns

**"Quick setup on a Linux server"**
> Run `selftune schedule --format cron`, paste the output into `crontab -e`.

**"Set up on macOS"**
> Run `selftune schedule --format launchd`, save as a `.plist` file, load with `launchctl`.

**"Set up on a systemd-based server"**
> Run `selftune schedule --format systemd`, save as `.timer` and `.service` files, enable with `systemctl`.

**"I use OpenClaw"**
> Use `selftune cron setup` instead — it registers jobs directly with OpenClaw's scheduler.
> See `Workflows/Cron.md`.
