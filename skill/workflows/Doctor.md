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
  "command": "doctor",
  "timestamp": "2026-02-28T10:00:00Z",
  "checks": [
    {
      "name": "config",
      "path": "/Users/you/.selftune/config.json",
      "status": "pass",
      "message": "Valid config with agent_type and llm_mode"
    },
    {
      "name": "log_session_telemetry",
      "path": "/Users/you/.claude/session_telemetry_log.jsonl",
      "status": "pass",
      "message": "Found 142 entries"
    },
    {
      "name": "hook_settings",
      "path": "/Users/you/.claude/settings.json",
      "status": "fail",
      "message": "PostToolUse hook not found in ~/.claude/settings.json"
    },
    {
      "name": "dashboard_freshness_mode",
      "status": "pass",
      "message": "Dashboard reads SQLite and watches WAL for live updates"
    }
  ],
  "summary": {
    "pass": 9,
    "fail": 1,
    "warn": 0,
    "total": 10
  },
  "healthy": false
}
```

The process exits with code 0 if `healthy: true`, code 1 otherwise.

Failed or warning checks may include a machine-readable `guidance` object:

```json
{
  "code": "config_missing",
  "message": "selftune is not initialized yet.",
  "next_command": "selftune init",
  "suggested_commands": ["selftune doctor"],
  "blocking": true
}
```

## Parsing Instructions

### Check Overall Health

```bash
# Parse: .healthy (boolean)
# Quick check: exit code 0 = healthy, 1 = unhealthy
```

### Find Failed Checks

```bash
# Parse: .checks[] | select(.status == "fail") | { name, message }
```

### Get Summary Counts

```bash
# Parse: .summary.pass, .summary.fail, .summary.warn, .summary.total
```

## Health Checks

Doctor validates these baseline areas (10 checks total), and adds alpha cloud-link
or queue checks when alpha is configured:

### Config Check

| Check name | What it validates                                                                            |
| ---------- | -------------------------------------------------------------------------------------------- |
| `config`   | `~/.selftune/config.json` exists, is valid JSON, contains `agent_type` and `llm_mode` fields |

### Log Checks (4 checks)

| Check name              | What it validates                                     |
| ----------------------- | ----------------------------------------------------- |
| `log_session_telemetry` | `session_telemetry_log.jsonl` exists and is parseable |
| `log_skill_usage`       | `skill_usage_log.jsonl` exists and is parseable       |
| `log_all_queries`       | `all_queries_log.jsonl` exists and is parseable       |
| `log_evolution_audit`   | `evolution_audit_log.jsonl` exists and is parseable   |

### Hook Check

| Check name      | What it validates                                       |
| --------------- | ------------------------------------------------------- |
| `hook_settings` | `~/.claude/settings.json` has selftune hooks configured |

### Evolution Check

| Check name        | What it validates                                |
| ----------------- | ------------------------------------------------ |
| `evolution_audit` | Evolution audit log entries have valid structure |

### Integrity Check

| Check name                 | What it validates                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `dashboard_freshness_mode` | Warns when the dashboard still relies on legacy JSONL watcher invalidation instead of SQLite WAL live refresh |

### Skill Version Sync Check

| Check name           | What it validates                                         |
| -------------------- | --------------------------------------------------------- |
| `skill_version_sync` | SKILL.md frontmatter version matches package.json version |

### Version Check

| Check name           | What it validates                                |
| -------------------- | ------------------------------------------------ |
| `version_up_to_date` | Installed version matches latest on npm registry |

## Steps

### 1. Run Doctor

```bash
selftune doctor
```

### 2. Check Results

Parse the JSON output. If `healthy: true`, selftune is fully operational.

### 3. Fix Any Issues

For each failed check, take the appropriate action:

| Failed check               | Fix                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config`                   | Run `selftune init` (or `selftune init --force` to regenerate).                                                                                  |
| `log_*`                    | Run a session to generate initial log entries. Check hook installation with `selftune init`.                                                     |
| `hook_settings`            | Run `selftune init` to install hooks into `~/.claude/settings.json`.                                                                             |
| `evolution_audit`          | Remove corrupted entries. Future operations will append clean entries.                                                                           |
| `dashboard_freshness_mode` | This is an operator warning, not a broken install. Expect possible freshness gaps for SQLite-only writes and export before destructive recovery. |
| `skill_version_sync`       | Run `bun run sync-version` to stamp SKILL.md from package.json.                                                                                  |
| `version_up_to_date`       | Run `npm install -g selftune` to update.                                                                                                         |

### 4. Re-run Doctor

After fixes, run doctor again to verify all checks pass.

## Subagent Escalation

If doctor reveals persistent issues with a specific skill — especially
recurring failures that basic fixes do not resolve — read
`skill/agents/diagnosis-analyst.md` and spawn a subagent with those instructions
for root cause analysis.

### Alpha Upload Not Active

**Symptoms:** `selftune status` shows alpha upload as "not enrolled" or "enrolled (missing credential)"

**Diagnostic steps:**

1. Check `selftune status` — look at "Alpha Upload" and "Cloud link" lines
2. If `doctor` includes a `cloud_link` or alpha queue warning, prefer `.checks[].guidance.next_command`
3. If "not enrolled" or "not linked": run `selftune init --alpha --alpha-email <email>` (opens browser for device-code auth)
4. If "enrolled (missing credential)": re-run `selftune init --alpha --alpha-email <email> --force` (re-authenticates via browser)
5. If "api_key has invalid format": re-run init with `--alpha --force` to re-authenticate

**Resolution:** Follow the setup sequence in Initialize workflow → Alpha Enrollment section.

## Common Patterns

**User reports something seems broken**

> Run `selftune doctor`. Parse the JSON output for failed checks. Report
> each failure's `name` and `message` to the user with the recommended fix.

**User asks if hooks are working**

> Run `selftune doctor`. Parse `.checks[]` for hook-related entries. If
> hooks pass but no data appears, verify hook script paths in
> `~/.claude/settings.json` point to actual files.

**No telemetry data available**

> Run `selftune doctor`. Route fixes by platform:
>
> - **Claude Code** — route to the Initialize workflow to install hooks
> - **Codex** — run `selftune ingest codex` or `selftune ingest wrap-codex`
> - **OpenCode** — run `selftune ingest opencode`
> - **OpenClaw** — run `selftune ingest openclaw`
>   At least one session must complete after setup to generate telemetry.

**User asks to check selftune health**

> Run `selftune doctor`. Parse `.healthy` and `.summary`. If `healthy: true`,
> report that selftune is fully operational. If false, report failed checks
> and recommended fixes.
