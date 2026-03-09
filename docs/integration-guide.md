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

# 3. Run a session and check telemetry
selftune last
```

`selftune init` now detects your workspace structure (single-skill, multi-skill,
or monorepo) and suggests the appropriate template. See the sections below for
project-specific setup.

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
3. Run `selftune doctor` to verify hooks are connected.

**Template:** `templates/single-skill-settings.json`

**What you get:**
- Prompt logging on every user query
- Skill evaluation on every `Read` tool use
- Session telemetry on session stop
- Auto-activation suggestions when metrics are low

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

1. Run `selftune doctor` to verify logs are healthy.

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

**Setup (autonomous cron loop):**

This is the unique OpenClaw feature — skills that improve while you sleep.
OpenClaw's built-in Gateway Scheduler runs selftune autonomously on a schedule.

1. Ensure OpenClaw is installed (`which openclaw`).
2. Register default cron jobs:

```bash
selftune cron setup
```

This registers 4 jobs with OpenClaw:

| Job | Schedule | Purpose |
|-----|----------|---------|
| `selftune-ingest` | Every 30 min | Ingest new sessions |
| `selftune-status` | Daily 8am | Health check, flag skills below 80% |
| `selftune-evolve` | Weekly Sunday 3am | Full evolution pipeline on undertriggering skills |
| `selftune-watch` | Every 6 hours | Regression monitoring on recently evolved skills |

1. Customize timezone: `selftune cron setup --tz America/New_York`
2. Preview without registering: `selftune cron setup --dry-run`
3. View registered jobs: `selftune cron list`
4. Remove all jobs: `selftune cron remove`

**How the autonomous loop works:**

```text
Cron fires (isolated session)
    ↓
OpenClaw agent reads selftune skill instructions
    ↓
Runs: selftune ingest-openclaw → selftune status
    ↓
For each skill below 80% pass rate:
    selftune evals → selftune evolve → selftune watch
    ↓
Evolved SKILL.md written to disk
    ↓
OpenClaw hot-reloads the changed SKILL.md (250ms)
    ↓
Next agent turn uses improved skill description
```

Each cron run uses an **isolated session** — no context pollution between runs.

**Safety controls:**
- `--dry-run` before real deploys
- <5% regression threshold on existing triggers
- Auto-rollback via `selftune watch --auto-rollback`
- Full audit trail in `evolution_audit_log.jsonl`
- `SKILL.md.bak` backup before every deploy
- Manual override: `selftune rollback --skill <name>` at any time

**Limitations:**
- Each cron run costs tokens (full LLM session, ~5K tokens estimated)
- Cron tools may be blocked in Docker sandbox mode (OpenClaw issue #29921)
- Newly created cron jobs may not fire until Gateway restart (known OpenClaw bug)

See `skill/Workflows/Cron.md` for the full cron workflow reference.

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

### Cron jobs not firing

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
