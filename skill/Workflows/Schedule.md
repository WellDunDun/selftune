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

| Flag              | Description                                                              | Default     |
| ----------------- | ------------------------------------------------------------------------ | ----------- |
| `--format <type>` | Output only one format: `cron`, `launchd`, or `systemd`                  | All formats |
| `--install`       | Write and activate scheduler artifacts for the selected/default platform | Off         |
| `--dry-run`       | Preview installed files and activation commands without writing          | Off         |
| `--help`          | Show help message                                                        | —           |

## Steps

1. Run `selftune schedule` to see all examples
2. Pick the scheduling system for your platform
3. Install them directly with `--install`, or inspect/customize the raw snippets first

## Alias

`selftune schedule` is now an alias for `selftune cron`. Both commands are interchangeable. See `Workflows/Cron.md` for the full cron workflow reference.

## PATH Resolution (All Platforms)

All three scheduling formats resolve the absolute path to the `selftune` binary
(via `Bun.which` with a `~/.bun/bin/selftune` fallback) and set explicit PATH
environment variables. This prevents silent failures from minimal default
environments that don't include homebrew, bun, or node binary locations.

- **launchd** — Injects an `EnvironmentVariables` dict with PATH and HOME into each plist.
- **systemd** — Adds `Environment="PATH=..."` and `Environment="HOME=..."` to each service unit.
- **cron** — Prepends a `PATH=...` declaration at the top of the generated crontab.

## Common Patterns

- **User wants quick setup on a Linux server** -- Run `selftune schedule --install --format cron`.
- **User wants setup on macOS** -- Run `selftune schedule --install --format launchd`.
- **User wants setup on a systemd-based server** -- Run `selftune schedule --install --format systemd`.
- **User mentions OpenClaw** -- Use `selftune cron setup --platform openclaw` for the OpenClaw scheduler adapter. The default product path is still `selftune schedule --install`. See `Workflows/Cron.md`.
