# selftune Doctor Workflow

Run health checks on selftune logs, hooks, and schema integrity.
Reports pass/fail status for each check with actionable guidance.

## Default Command

```bash
selftune doctor
```

## Options

None. Doctor runs all checks unconditionally.

## Output Format

```json
{
  "healthy": true,
  "checks": [
    {
      "name": "session_telemetry_log exists",
      "status": "pass",
      "detail": "Found 142 entries"
    },
    {
      "name": "skill_usage_log parseable",
      "status": "pass",
      "detail": "All 89 entries valid JSON"
    },
    {
      "name": "hooks installed",
      "status": "fail",
      "detail": "PostToolUse hook not found in ~/.claude/settings.json"
    }
  ],
  "summary": {
    "passed": 5,
    "failed": 1,
    "total": 6
  }
}
```

The process exits with code 0 if `healthy: true`, code 1 otherwise.

## Parsing Instructions

### Check Overall Health

```bash
# Parse: .healthy (boolean)
# Quick check: exit code 0 = healthy, 1 = unhealthy
```

### Find Failed Checks

```bash
# Parse: .checks[] | select(.status == "fail") | { name, detail }
```

### Get Summary Counts

```bash
# Parse: .summary.passed, .summary.failed, .summary.total
```

## Health Checks

Doctor validates these areas:

### Log File Checks

| Check | What it validates |
|-------|-------------------|
| Log files exist | `session_telemetry_log.jsonl`, `skill_usage_log.jsonl`, `all_queries_log.jsonl` exist in `~/.claude/` |
| Logs are parseable | Every line in each log file is valid JSON |
| Schema conformance | Required fields present per log type (see `references/logs.md`) |

### Hook Checks

| Check | What it validates |
|-------|-------------------|
| Hooks installed | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` hooks are configured in `~/.claude/settings.json` |
| Hook scripts exist | The script files referenced by hooks exist on disk |
| Auto-activate hook | `hooks/auto-activate.ts` is registered in `UserPromptSubmit` and the file is executable |
| Evolution guard hook | `hooks/evolution-guard.ts` is registered in `PreToolUse` and the file exists |

### Memory Checks

| Check | What it validates |
|-------|-------------------|
| Memory directory exists | `~/.selftune/memory/` directory is present |
| Memory files valid | `context.md`, `decisions.md`, `patterns.md` exist and are non-empty (if previously written) |

### Activation Rules Checks

| Check | What it validates |
|-------|-------------------|
| Rules file exists | `~/.selftune/activation-rules.json` is present |
| Rules file valid | The file contains valid JSON conforming to the activation rules schema |

### Agent Checks

| Check | What it validates |
|-------|-------------------|
| Agent directory exists | `.claude/agents/` directory is present |
| Agent files present | Expected agent files exist: `diagnosis-analyst.md`, `pattern-analyst.md`, `evolution-reviewer.md`, `integration-guide.md` |

### Dashboard Checks (optional)

| Check | What it validates |
|-------|-------------------|
| Dashboard server accessible | `dashboard-server.ts` exists in the CLI directory |

### Evolution Audit Checks

| Check | What it validates |
|-------|-------------------|
| Audit log integrity | `evolution_audit_log.jsonl` entries have required fields (`timestamp`, `proposal_id`, `action`) |
| Valid action values | All entries use known action types: `created`, `validated`, `deployed`, `rolled_back` |

## Steps

### 1. Run Doctor

```bash
selftune doctor
```

### 2. Check Results

Parse the JSON output. If `healthy: true`, selftune is fully operational.

### 3. Fix Any Issues

For each failed check, take the appropriate action:

| Failed check | Fix |
|-------------|-----|
| Log files missing | Run a session to generate initial log entries. Check hook installation. |
| Logs not parseable | Inspect the corrupted log file. Remove or fix invalid lines. |
| Hooks not installed | Merge `skill/settings_snippet.json` into `~/.claude/settings.json`. Update paths. |
| Hook scripts missing | Verify the selftune repo path. Re-run `init` if the repo was moved. |
| Auto-activate missing | Add `hooks/auto-activate.ts` to `UserPromptSubmit` in settings. |
| Evolution guard missing | Add `hooks/evolution-guard.ts` to `PreToolUse` in settings. |
| Memory directory missing | Run `mkdir -p ~/.selftune/memory`. |
| Memory files invalid | Delete and let the memory writer recreate them on next evolve/watch. |
| Activation rules missing | Copy `templates/activation-rules-default.json` to `~/.selftune/activation-rules.json`. |
| Activation rules invalid | Validate JSON syntax. Re-copy from template if corrupted. |
| Agent files missing | Copy agents from the selftune repo `.claude/agents/` directory. |
| Audit log invalid | Remove corrupted entries. Future operations will append clean entries. |

### 4. Re-run Doctor

After fixes, run doctor again to verify all checks pass.

## Common Patterns

**"Something seems broken"**
> Run doctor first. Report any failing checks with their detail messages.

**"Are my hooks working?"**
> Doctor checks hook installation. If hooks pass but no data appears,
> verify the hook script paths point to actual files.

**"No telemetry available"**
> Doctor will report missing log files. Install hooks using the
> `settings_snippet.json` in the skill directory, then run a session.

**"Check selftune health"**
> Run doctor and report the summary. A clean bill of health means
> all checks pass and selftune is ready to grade/evolve/watch.
