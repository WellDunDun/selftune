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

The core selftune automation loop is one command:

```bash
selftune orchestrate
```

`selftune orchestrate` runs source-truth sync first, selects candidate skills,
deploys validated low-risk description changes autonomously, and watches recent
deployments with auto-rollback enabled.

## Default Command

```bash
selftune schedule
```

Outputs examples for all three scheduling systems (cron, launchd, systemd).

## Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--format <type>` | Output only one format: `cron`, `launchd`, or `systemd` | All formats |
| `--install` | Write and activate scheduler artifacts for the selected/default platform | Off |
| `--dry-run` | Preview installed files and activation commands without writing | Off |
| `--help` | Show help message | — |

## Steps

1. Run `selftune schedule` to see all examples
2. Pick the scheduling system for your platform
3. Install them directly with `--install`, or inspect/customize the raw snippets first

## Common Patterns

**"Quick setup on a Linux server"**
> Run `selftune schedule --install --format cron`.

**"Set up on macOS"**
> Run `selftune schedule --install --format launchd`.

**"Set up on a systemd-based server"**
> Run `selftune schedule --install --format systemd`.

**"I use OpenClaw"**
> Use `selftune cron setup` instead — it registers jobs directly with OpenClaw's scheduler.
> See `Workflows/Cron.md`.
