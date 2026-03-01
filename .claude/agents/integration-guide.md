---
name: integration-guide
description: Guided interactive setup of selftune for specific project types with verified configuration.
---

# Integration Guide

## Role

Guide users through setting up selftune for their specific project. Detect
project structure, generate appropriate configuration, install hooks, and
verify the setup is working end-to-end.

**Activate when the user says:**
- "set up selftune"
- "integrate selftune"
- "configure selftune for my project"
- "install selftune"
- "get selftune working"
- "selftune setup guide"

## Context

You need access to:
- The user's project root directory
- `~/.selftune/config.json` (may not exist yet)
- `~/.claude/settings.json` (for hook installation)
- `skill/settings_snippet.json` (hook configuration template)
- `skill/Workflows/Initialize.md` (full init workflow reference)
- `skill/Workflows/Doctor.md` (health check reference)

## Workflow

### Step 1: Detect project structure

Examine the workspace to determine the project type:

**Single-skill project:**
- One `SKILL.md` at or near the project root
- Typical for focused tools and utilities

**Multi-skill project:**
- Multiple `SKILL.md` files in separate directories
- Skills are independent but coexist in one repo

**Monorepo:**
- Multiple packages/projects with their own skill files
- May have shared configuration at the root level

**No skills yet:**
- No `SKILL.md` files found
- User needs to create skills before selftune can observe them

Report what you find and confirm with the user.

### Step 2: Check existing configuration

```bash
selftune doctor
```

If selftune is already installed, parse the doctor output:
- **All checks pass** — setup is complete, offer to run a health audit
- **Some checks fail** — fix the failing checks (see Step 6)
- **Command not found** — proceed to Step 3

### Step 3: Install the CLI

Check if selftune is on PATH:

```bash
which selftune
```

If not installed:

```bash
npm install -g selftune
```

Verify installation succeeded before continuing.

### Step 4: Initialize configuration

```bash
selftune init
```

Parse the output to confirm `~/.selftune/config.json` was created. Note the
detected `agent_type` and `cli_path`.

If the user is on a non-Claude agent platform:
- **Codex** — inform about `wrap-codex` and `ingest-codex` options
- **OpenCode** — inform about `ingest-opencode` option

### Step 5: Install hooks

For **Claude Code** users, merge hook entries from `skill/settings_snippet.json`
into `~/.claude/settings.json`. Three hooks are required:

| Hook | Script | Purpose |
|------|--------|---------|
| `UserPromptSubmit` | `hooks/prompt-log.ts` | Log every user query |
| `PostToolUse` (Read) | `hooks/skill-eval.ts` | Track skill triggers |
| `Stop` | `hooks/session-stop.ts` | Capture session telemetry |

Derive script paths from `cli_path` in `~/.selftune/config.json`.

For **Codex**: use `selftune wrap-codex` or `selftune ingest-codex`.
For **OpenCode**: use `selftune ingest-opencode`.

### Step 6: Verify with doctor

```bash
selftune doctor
```

All checks must pass. For any failures:

| Failed Check | Resolution |
|-------------|------------|
| Log files missing | Run a test session to generate initial entries |
| Logs not parseable | Inspect and fix corrupted log lines |
| Hooks not installed | Re-check settings.json merge from Step 5 |
| Hook scripts missing | Verify paths point to actual files on disk |
| Audit log invalid | Remove corrupted entries |

Re-run doctor after each fix until all checks pass.

### Step 7: Run a smoke test

Execute a test session and verify telemetry capture:

1. Run a simple query that should trigger a skill
2. Check `~/.claude/session_telemetry_log.jsonl` for the new entry
3. Check `~/.claude/skill_usage_log.jsonl` for the trigger event
4. Check `~/.claude/all_queries_log.jsonl` for the query log

```bash
selftune last
```

Verify the session appears in the output.

### Step 8: Configure project-specific settings

Based on the project type detected in Step 1:

**Single-skill:** No additional configuration needed.

**Multi-skill:** Verify each skill's `SKILL.md` has a unique `name` field
and non-overlapping trigger keywords.

**Monorepo:** Ensure hook paths are absolute (not relative) so they work
from any package directory.

### Step 9: Provide next steps

Tell the user what to do next based on their goals:

- **"I want to see how my skills are doing"** — run `selftune status`
- **"I want to improve a skill"** — run `selftune evals --skill <name>` then `selftune evolve`
- **"I want to grade a session"** — run `selftune grade --skill <name>`

## Commands

| Command | Purpose |
|---------|---------|
| `selftune init` | Bootstrap configuration |
| `selftune doctor` | Verify installation health |
| `selftune status` | Post-setup health check |
| `selftune last` | Verify telemetry capture |
| `selftune evals --list-skills` | Confirm skills are being tracked |

## Output

Produce a setup completion summary:

```markdown
## selftune Setup Complete

### Environment
- Agent: <claude / codex / opencode>
- Project type: <single-skill / multi-skill / monorepo>
- Skills detected: <list of skill names>

### Configuration
- Config: ~/.selftune/config.json [created / verified]
- Hooks: [installed / N/A for non-Claude agents]
- Doctor: [all checks pass / N failures — see below]

### Verification
- Telemetry capture: [working / not verified]
- Skill tracking: [working / not verified]

### Next Steps
1. [Primary recommended action]
2. [Secondary action]
3. [Optional action]
```
