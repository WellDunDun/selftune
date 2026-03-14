# selftune Integration Guide

Comprehensive guide for integrating selftune into any project structure.
selftune makes your agent skills self-improving — it watches real sessions,
learns how you work, and evolves skill descriptions to match automatically.
Supports Claude Code, Codex, OpenCode, and OpenClaw.

---

## Quick Start

The fastest path for most projects:

```bash
# 1. Initialize selftune (auto-detects agent and workspace type)
selftune init

# 2. Verify everything is working
selftune doctor

# 3. Refresh source-truth telemetry
selftune sync

# 4. Inspect health
selftune status
```

`selftune init` now detects your workspace structure (single-skill, multi-skill,
or monorepo) and suggests the appropriate template. See the sections below for
project-specific setup.

### Source of Truth vs. Hooks

For Claude Code, hooks provide low-latency local signal:
- prompt logging
- best-effort skill-use hints
- session-stop telemetry

But the authoritative view is now **source-truth sync**:
- Claude transcripts
- Codex rollout logs
- OpenCode history
- OpenClaw session history

Run `selftune sync` before trusting `status`, `dashboard`, `watch`, or `evolve`,
especially on polluted hosts or after large batches of agent activity.

If your primary `~/.claude` is modified by another system or routing layer,
keep using selftune's sandbox harness as the clean regression environment while
treating host-machine `sync` output as the real-world proof source.

---

## Project Types

### Single-Skill Projects

A project with one `SKILL.md` file and straightforward hooks.

**Structure:**

```text
my-project/
  skill/
    SKILL.md
  cli/selftune/
    hooks/
      prompt-log.ts
      skill-eval.ts
      session-stop.ts
      auto-activate.ts
```

**Setup:**

1. Run `selftune init`. It will detect the single skill automatically.
2. Merge `templates/single-skill-settings.json` into `~/.claude/settings.json`.
   Replace `/PATH/TO` with the absolute path to your selftune installation.
3. Run `selftune doctor` to verify local install health.
4. Run `selftune sync` after real sessions to rebuild source-truth telemetry.

**Template:** `templates/single-skill-settings.json`

**What you get:**
- Prompt logging on every user query
- Skill evaluation on every `Read` tool use
- Session telemetry on session stop
- Auto-activation suggestions when metrics are low

**Important:** the hooks are convenience signals for Claude Code only. The
authoritative usage view still comes from `selftune sync`.

---

### Multi-Skill Projects

A project with multiple `SKILL.md` files. Activation rules route queries to
the correct skill for evaluation.

**Structure:**

```text
my-project/
  skills/
    auth/SKILL.md
    deploy/SKILL.md
    monitoring/SKILL.md
  cli/selftune/
    hooks/
      prompt-log.ts
      skill-eval.ts
      session-stop.ts
      auto-activate.ts
      skill-change-guard.ts
      evolution-guard.ts
```

**Setup:**

1. Run `selftune init`. It will detect multiple skills and suggest the multi-skill template.
2. Merge `templates/multi-skill-settings.json` into `~/.claude/settings.json`.
3. Copy `templates/activation-rules-default.json` to `~/.selftune/activation-rules.json`
   and customize rule thresholds if needed.
4. Run `selftune doctor`.
5. Run `selftune sync` after sessions to rebuild the repaired/source-truth overlay.

**Template:** `templates/multi-skill-settings.json`

**Differences from single-skill:**
- Includes `evolution-guard.ts` in `PreToolUse` hooks to protect active evolutions
- Activation rules (`activation-rules.json`) control which suggestions fire
- Each skill gets independent eval/grade/evolve cycles
- Workflow discovery becomes useful once telemetry accumulates: run
  `selftune workflows` to find repeated multi-skill chains and
  `selftune workflows save <workflow-id|index>` to codify them into
  `## Workflows` in the relevant SKILL.md

**Activation Rules:**

selftune ships with four default activation rules (see `cli/selftune/activation-rules.ts`):

| Rule ID | Trigger | Suggestion |
|---------|---------|------------|
| `post-session-diagnostic` | >2 unmatched queries in session | `selftune last` |
| `grading-threshold-breach` | Session pass rate < 60% | `selftune evolve` |
| `stale-evolution` | No evolution in >7 days + pending false negatives | `selftune evolve` |
| `regression-detected` | Monitoring snapshot shows regression | `selftune rollback` |

Rules fire at most once per session (tracked via session state files in `~/.selftune/`).
To disable a rule, set `"enabled": false` in your `activation-rules.json`.

---

### Monorepo

A project with `package.json` workspaces, `pnpm-workspace.yaml`, or `lerna.json`.
Each package can have its own skill.

**Structure:**

```text
my-monorepo/
  package.json            # { "workspaces": ["packages/*"] }
  packages/
    core/
      skill/SKILL.md
    api/
      skill/SKILL.md
    web/
      skill/SKILL.md
  cli/selftune/
    hooks/
```

**Setup:**

1. Run `selftune init` from the monorepo root. It detects the workspace structure.
2. Use the `templates/multi-skill-settings.json` template (monorepos are multi-skill).
3. Each package's `SKILL.md` is independently tracked for eval and grading.
4. Run `selftune doctor`.
5. Run `selftune sync` to refresh usage/telemetry from actual session history.

**Tips:**
- Run `selftune init` from the monorepo root, not from individual packages.
- Skill paths are stored as absolute paths in telemetry, so cross-package analysis works.
- Use `selftune status --skill <name>` to check per-skill metrics.

---

### Codex-Only

Using selftune with OpenAI Codex instead of Claude Code.

**Setup:**

1. Run `selftune init --agent codex`.
2. Codex does not support Claude Code hooks. Use the wrapper approach:

```bash
# Wrap codex sessions for real-time telemetry
selftune wrap-codex -- codex <your-args>
```

3. Or batch-ingest existing sessions:

```bash
selftune ingest-codex --dir /path/to/codex/sessions
```

**Limitations:**
- No real-time hook-based telemetry (Codex has no hook system)
- Eval and grading work the same way once sessions are ingested
- Auto-activation suggestions are not available (no `UserPromptSubmit` hook)

After wrapping or ingesting Codex activity, run `selftune sync` before
trusting status/evolution decisions.

---

### OpenCode-Only

Using selftune with OpenCode.

**Setup:**

1. Run `selftune init --agent opencode`.
2. OpenCode stores sessions in a SQLite database. Import them:

```bash
selftune ingest-opencode
```

The default database path is `~/.local/share/opencode/opencode.db`.
Override with `--db /path/to/opencode.db`.

**Limitations:**
- Same as Codex: no real-time hooks, batch ingest only
- Session format differs; selftune normalizes on import

After import, run `selftune sync` before checking `status`, `watch`, or `evolve`.

---

### OpenClaw-Only

Using selftune with OpenClaw. This is the richest integration path — OpenClaw
supports cron-based autonomous evolution, hot-reloading of evolved skills, and
isolated session execution.

**Setup (batch ingest):**

1. Run `selftune init --agent openclaw`.
2. Import existing sessions:

```bash
selftune ingest-openclaw
```

This scans `~/.openclaw/agents/*/sessions/*.jsonl` for all agent sessions.
Use `--since 2026-02-01` to limit scope. Use `--dry-run` to preview.

3. Run `selftune doctor` to verify logs are healthy.
4. Run `selftune sync` so all imported sessions flow into the repaired/source-truth overlay.

**Options:**

| Flag | Description |
|------|-------------|
| `--agents-dir <path>` | Override default `~/.openclaw/agents/` directory |
| `--since <date>` | Only ingest sessions modified after this date (YYYY-MM-DD) |
| `--dry-run` | Preview what would be ingested without writing to logs |
| `--force` | Re-ingest all sessions, ignoring the marker file |
| `--verbose` / `-v` | Show per-session progress during ingestion |

**Skill detection:** OpenClaw doesn't explicitly log skill triggers. selftune
infers triggers by detecting `SKILL.md` file reads and matching tool call names
against known skill names from OpenClaw's skill directories.

**Multi-agent support:** If you run multiple OpenClaw agents, selftune scans
all directories under `~/.openclaw/agents/` automatically.

**OpenClaw autonomous cron loop (optional):**

OpenClaw users can also register selftune jobs with OpenClaw's Gateway Scheduler
for fully autonomous evolution. See the [Automation](#automation) section below
and `skill/Workflows/Cron.md` for details.

---

### Mixed Agent

Using selftune across multiple agent platforms (e.g., Claude Code + Codex + OpenClaw).

**Setup:**

1. Run `selftune init` on each agent platform:
   - On the Claude Code machine: `selftune init --agent claude_code`
   - On the Codex machine: `selftune init --agent codex`
   - On the OpenClaw machine: `selftune init --agent openclaw`
2. Each agent writes telemetry to `~/.selftune/` in a shared format.
3. Merge telemetry for cross-agent analysis:

```bash
# Ingest Codex sessions alongside Claude Code telemetry
selftune ingest-codex --dir /path/to/sessions

# Ingest OpenClaw sessions
selftune ingest-openclaw

# View combined dashboard
selftune dashboard
```

**Shared telemetry format:**
All agents produce the same JSONL log format (`session_telemetry_log.jsonl`,
`skill_usage_log.jsonl`, `all_queries_log.jsonl`). The `source` field in each
record identifies the originating agent.

**Tips:**
- Use `selftune status` to see aggregated metrics across agents.
- Grading and evolution work on the merged dataset.
- Keep `~/.selftune/config.json` agent-specific on each machine.

---

## `selftune sync` Reference

`selftune sync` is the source-truth telemetry command. It replays Claude
transcripts, Codex rollout logs, OpenCode history, and OpenClaw sessions into
the canonical JSONL logs, then rebuilds the repaired skill-usage overlay.

Run it before trusting `status`, `dashboard`, `watch`, or `evolve`.

**Flags:**

| Flag | Description |
|------|-------------|
| `--since <date>` | Only sync sessions modified on/after this date (YYYY-MM-DD) |
| `--dry-run` | Show summary without writing files |
| `--force` | Ignore per-source markers and rescan everything |
| `--no-claude` | Skip Claude transcript replay |
| `--no-codex` | Skip Codex rollout ingest |
| `--no-opencode` | Skip OpenCode ingest |
| `--no-openclaw` | Skip OpenClaw ingest |
| `--no-repair` | Skip rebuilt skill-usage overlay |
| `--projects-dir <dir>` | Override Claude transcript directory (default: `~/.claude/projects`) |
| `--codex-home <dir>` | Override Codex home directory (default: `~/.codex`) |
| `--openclaw-agents-dir <dir>` | Override OpenClaw agents directory |

---

## Hook Reference

selftune uses Claude Code hooks for real-time telemetry. Here is the full hook chain:

| Hook Event | Script | Purpose |
|-----------|--------|---------|
| `UserPromptSubmit` | `prompt-log.ts` | Log every user query to `all_queries_log.jsonl` |
| `UserPromptSubmit` | `auto-activate.ts` | Evaluate activation rules and show suggestions |
| `PreToolUse` (Write/Edit) | `skill-change-guard.ts` | Prevent unreviewed changes to SKILL.md files |
| `PreToolUse` (Write/Edit) | `evolution-guard.ts` | Block changes that conflict with active evolutions |
| `PostToolUse` (Read) | `skill-eval.ts` | Track which skills are triggered by queries |
| `Stop` | `session-stop.ts` | Capture end-of-session telemetry |

All hooks:
- Exit code 0 on success (non-blocking by design)
- Write to stderr for advisory messages (shown to Claude as system messages)
- Have 5-15 second timeouts to avoid blocking the agent
- Fail open: errors are silently caught, never interrupting the session

**Portable hook dispatch:** Instead of hardcoding absolute paths to hook scripts
in `settings.json`, use `selftune hook <name>`:

```bash
selftune hook prompt-log
selftune hook session-stop
selftune hook skill-eval
selftune hook auto-activate
selftune hook skill-change-guard
selftune hook evolution-guard
```

This lets you write `selftune hook prompt-log` (or `npx selftune hook prompt-log`)
in your hook configuration, which resolves the correct script path at runtime.

---

## Automation

selftune is designed to run unattended on any machine. The core automation
loop is centered on one command:

```text
selftune orchestrate
```

`selftune orchestrate` runs source-truth sync first, selects candidate skills,
deploys validated low-risk description changes autonomously, and watches recent
deployments with auto-rollback enabled.

Fastest path:

```bash
selftune init --enable-autonomy
```

Run `selftune schedule` to generate or install ready-to-use snippets for your platform.

### System cron (Linux/macOS — recommended default)

The simplest path. Install it directly:

```bash
selftune schedule --install --format cron
```

Or inspect the raw crontab first with `selftune schedule --format cron`.

### macOS launchd

For macOS machines that need scheduling to survive reboots and sleep/wake:

```bash
selftune schedule --install --format launchd
```

Run `selftune schedule --format launchd` for raw plist output without installing it.

### Linux systemd timer

For systemd-based servers:

```bash
selftune schedule --install --format systemd
```

### OpenClaw integration (optional)

If you use OpenClaw, `selftune cron setup` registers jobs directly with
OpenClaw's Gateway Scheduler. This provides isolated sessions per cron run
and an autonomous orchestrated loop without manual scheduler setup.

```bash
selftune cron setup                    # register autonomous jobs
selftune cron setup --dry-run          # preview first
selftune cron list                     # check registered jobs
```

See `skill/Workflows/Cron.md` for the full OpenClaw cron reference.

---

## Troubleshooting

### `selftune doctor` reports failing checks

Run `selftune doctor` and address each failing check:

| Check | Fix |
|-------|-----|
| Config missing | Run `selftune init` |
| Hooks not installed | Merge the appropriate template into `~/.claude/settings.json` |
| Log directory missing | Run `selftune init --force` |
| Stale config | Run `selftune init --force` to regenerate |

### Hooks not firing

1. Verify hooks are in `~/.claude/settings.json`:
   ```bash
   cat ~/.claude/settings.json | grep selftune
   ```
2. Check that paths in settings.json point to actual files.
3. Ensure `bun` is on PATH (hooks use `bun run`).
4. Check hook timeouts: if a hook exceeds its timeout, Claude Code skips it silently.

### No telemetry data

1. Check that log files exist:
   ```bash
   ls -la ~/.claude/*_log.jsonl
   ```
2. Verify the hooks are running by checking stderr output during a session.
3. Run `selftune last` after a session to see if data was captured.

### Activation rules not suggesting anything

1. Rules fire at most once per session. Start a new session to see suggestions again.
2. Check `~/.selftune/session-state-*.json` for session state.
3. If using PAI alongside selftune, PAI takes priority for skill-level suggestions
   (selftune defers to avoid duplicate nags).

### OpenClaw sessions not ingesting

1. Verify OpenClaw agents directory exists:

   ```bash
   ls ~/.openclaw/agents/
   ```

2. Check that sessions are stored as `.jsonl` files under each agent's `sessions/` directory.
3. Use `--verbose` to see per-session progress: `selftune ingest-openclaw --verbose`
4. Use `--force` to re-ingest all sessions if the marker file is stale.
5. If using a custom agents directory: `selftune ingest-openclaw --agents-dir /custom/path`

### Scheduled automation not running

**System cron / launchd / systemd:**
1. Verify `selftune` is on PATH in the cron environment (cron has a minimal PATH).
2. Use absolute paths if needed: `which selftune` to find the binary.
3. Check cron logs: `grep selftune /var/log/syslog` (Linux) or Console.app (macOS).

**OpenClaw cron:**
1. Verify jobs are registered: `selftune cron list`
2. Check OpenClaw cron status: `openclaw cron list`
3. Newly created jobs may require a Gateway restart (known OpenClaw bug).
4. Verify timezone is correct: `selftune cron setup --tz <your-timezone>`
5. Check if cron is blocked by Docker sandbox mode (OpenClaw issue #29921).
6. Preview what would run: `selftune cron setup --dry-run`

### Mixed-agent telemetry conflicts

1. Each agent should have its own `~/.selftune/config.json` with the correct `agent_type`.
2. Telemetry logs are append-only and use the `source` field to distinguish agents.
3. If logs are on different machines, copy the `.jsonl` files into a shared directory
   and re-run analysis.

### Workspace detection issues

If `selftune init` detects the wrong workspace type:
1. Use `--force` to reinitialize.
2. The detection scans for `SKILL.md` files and monorepo markers (`package.json` workspaces,
   `pnpm-workspace.yaml`, `lerna.json`).
3. Directories named `node_modules`, `.git`, `dist`, `build`, `.next`, and `.cache` are
   always excluded from the scan.
