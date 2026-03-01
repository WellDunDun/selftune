# selftune Integration Guide

Comprehensive guide for integrating selftune into any project structure.
selftune is a skill observability CLI that tracks how your Claude Code skills
perform, detects regressions, and evolves skill descriptions automatically.

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

```
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

```
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

```
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

### Mixed Agent

Using selftune across multiple agent platforms (e.g., Claude Code + Codex).

**Setup:**

1. Run `selftune init` on each agent platform:
   - On the Claude Code machine: `selftune init --agent claude_code`
   - On the Codex machine: `selftune init --agent codex`
2. Each agent writes telemetry to `~/.selftune/` in a shared format.
3. Merge telemetry for cross-agent analysis:

```bash
# Ingest Codex sessions alongside Claude Code telemetry
selftune ingest-codex --dir /path/to/sessions

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
