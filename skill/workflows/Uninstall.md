# selftune Uninstall Workflow

Clean removal of all selftune data, configuration, hooks, and scheduling
artifacts. Surgically removes selftune entries from shared config files
(like `settings.json`) without affecting user-owned entries.

## When to Use

- The user wants to completely remove selftune
- The user says "uninstall", "remove selftune", "clean up", or "teardown"
- The agent needs to undo all selftune installation side effects

## Default Command

```bash
selftune uninstall
```

## Options

| Flag              | Description                                                |
| ----------------- | ---------------------------------------------------------- |
| `--dry-run`       | Preview what would be removed without deleting anything    |
| `--keep-logs`     | Preserve JSONL telemetry logs (remove everything else)     |
| `--npm-uninstall` | Also run `npm uninstall -g selftune` to remove the binary  |
| `--help`          | Show usage information                                     |

## Removal Steps

The uninstall command removes artifacts in this order:

1. **Autonomy scheduling** — Removes launchd plist (`~/Library/LaunchAgents/dev.selftune.orchestrate.plist`) on macOS, or cron jobs via `selftune cron remove` on other platforms.
2. **Hooks from settings.json** — Surgically removes only selftune hook entries from `~/.claude/settings.json`. Preserves all user-defined hooks.
3. **Claude subagents** — Removes selftune-managed agent files from `~/.claude/agents/`.
4. **JSONL telemetry logs** — Removes all selftune log files from `~/.claude/` (session telemetry, skill usage, evolution audit, orchestrate runs, etc.). Skipped with `--keep-logs`.
5. **Config directory** — Removes `~/.selftune/` and all contents.
6. **Ingest markers** — Removes per-source marker files that track which sessions have been ingested.
7. **npm package** — Runs `npm uninstall -g selftune` only when `--npm-uninstall` is passed.

## Output Format

Output is JSON with per-step results:

```json
{
  "dryRun": false,
  "schedule": { "removed": true, "details": "Removed launchd plist: ..." },
  "hooks": { "removed": 6, "details": "Removed 6 selftune hook entries from ..." },
  "agents": { "removed": 4, "files": ["..."] },
  "logs": { "removed": 10, "skipped": false, "files": ["..."] },
  "config": { "removed": true, "path": "~/.selftune" },
  "markers": { "removed": 5, "files": ["..."] },
  "npm": { "uninstalled": false, "skipped": true }
}
```

## Common Patterns

**Preview before removing**

> Run `selftune uninstall --dry-run` first to see what would be removed.

**Keep telemetry data for later**

> Run `selftune uninstall --keep-logs` to remove config and hooks but preserve log files for potential re-installation.

**Full removal including npm package**

> Run `selftune uninstall --npm-uninstall` for a complete teardown.

**Re-install after uninstall**

> Run `npx skills add selftune-dev/selftune` followed by `selftune quickstart` to set up again from scratch.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Hooks still present after uninstall | `settings.json` was not writable | Check file permissions on `~/.claude/settings.json` |
| Scheduling still active | launchd/cron removal failed | Manually run `launchctl unload ~/Library/LaunchAgents/dev.selftune.orchestrate.plist` or remove cron entries |
| npm package still installed | `--npm-uninstall` was not passed | Run `npm uninstall -g selftune` manually or re-run with `--npm-uninstall` |
| Some log files remain | Files were locked by another process | Stop any running `selftune` processes and retry, or delete manually |
