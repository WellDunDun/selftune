# selftune Initialize Workflow

Bootstrap selftune for first-time use or after changing environments.

## When to Use

- The user asks to set up selftune, configure selftune, or initialize selftune
- The agent detects `~/.selftune/config.json` does not exist
- The user has switched agent platforms (Claude Code, Codex, OpenCode)

## Default Command

```bash
selftune init [--agent <type>] [--cli-path <path>] [--force]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--agent <type>` | Agent platform: `claude`, `codex`, `opencode` | Auto-detected |
| `--cli-path <path>` | Override auto-detected CLI entry-point path | Auto-detected |
| `--force` | Reinitialize even if config already exists | Off |

## Output Format

Creates `~/.selftune/config.json`:

```json
{
  "agent_type": "claude",
  "cli_path": "/Users/you/selftune/cli/selftune/index.ts",
  "llm_mode": "agent",
  "agent_cli": "claude",
  "hooks_installed": true,
  "initialized_at": "2026-02-28T10:00:00Z"
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `agent_type` | string | Detected or specified agent platform |
| `cli_path` | string | Absolute path to the CLI entry point |
| `llm_mode` | string | How LLM calls are made: `agent` or `api` |
| `agent_cli` | string | CLI binary name for the detected agent |
| `hooks_installed` | boolean | Whether telemetry hooks are installed |
| `initialized_at` | string | ISO 8601 timestamp |

## Steps

### 1. Check if CLI is installed

```bash
which selftune
```

If `selftune` is not on PATH, install it:

```bash
npm install -g selftune
```

### 2. Check Existing Config

```bash
cat ~/.selftune/config.json 2>/dev/null
```

If the file exists and is valid JSON, selftune is already initialized.
Skip to Step 8 (verify with doctor) unless the user wants to reinitialize.

### 3. Run Init

```bash
selftune init
```

### 4. Hooks (Claude Code)

Hooks are **automatically installed** by `selftune init`. The init command
merges selftune hook entries from `skill/settings_snippet.json` into
`~/.claude/settings.json` without overwriting existing user hooks. If the
hooks are already present, they are skipped (no duplicates).

The init output will report what was installed, e.g.:

```text
[INFO] Installed 4 selftune hook(s) into ~/.claude/settings.json: UserPromptSubmit, PreToolUse, PostToolUse, Stop
```

**Hook reference** (for troubleshooting):

| Hook | Script | Purpose |
|------|--------|---------|
| `UserPromptSubmit` | `hooks/prompt-log.ts` | Log every user query |
| `UserPromptSubmit` | `hooks/auto-activate.ts` | Suggest skills before prompt processing |
| `PreToolUse` (Write/Edit) | `hooks/skill-change-guard.ts` | Detect uncontrolled skill edits |
| `PreToolUse` (Write/Edit) | `hooks/evolution-guard.ts` | Block SKILL.md edits on monitored skills |
| `PostToolUse` (Read/Skill) | `hooks/skill-eval.ts` | Track skill triggers and Skill tool invocations |
| `Stop` | `hooks/session-stop.ts` | Capture session telemetry |

**Codex agents:**
- Use `selftune ingest wrap-codex` for real-time telemetry capture (see `Workflows/Ingest.md`)
- Or batch-ingest existing sessions with `selftune ingest codex`

**OpenCode agents:**
- Use `selftune ingest opencode` to import sessions from the SQLite database
- See `Workflows/Ingest.md` for details

### 5. Initialize Memory Directory

Create the memory directory if it does not exist:

```bash
mkdir -p ~/.selftune/memory
```

The memory system stores three files at `~/.selftune/memory/`:
- `context.md` -- active evolution state and session context
- `decisions.md` -- evolution decisions and rollback history
- `plan.md` -- current priorities and evolution strategy

These files are created automatically by the memory writer during evolve,
watch, and rollback workflows. The directory just needs to exist.

### 6. Set Up Activation Rules

`selftune init` copies the default activation rules template to
`~/.selftune/activation-rules.json` automatically. If the file is missing,
run `selftune init --force` to regenerate it.

The activation rules file configures auto-activation behavior -- which skills
get suggested and under what conditions. Edit `~/.selftune/activation-rules.json`
to customize thresholds and skill mappings for your project.

### 7. Verify with Doctor

```bash
selftune doctor
```

Parse the JSON output. All checks should pass. If any fail, address the
reported issues before proceeding.

## Integration Guide

For project-type-specific setup (single-skill, multi-skill, monorepo, Codex,
OpenCode, mixed agents), see [docs/integration-guide.md](../../docs/integration-guide.md).

Templates for each project type are in the `templates/` directory:
- `templates/single-skill-settings.json` — hooks for single-skill projects
- `templates/multi-skill-settings.json` — hooks for multi-skill projects with activation rules
- `templates/activation-rules-default.json` — default auto-activation rule configuration

## Subagent Escalation

For complex project structures (monorepos, multi-skill repos, mixed agent
platforms), read `agents/integration-guide.md` and spawn a subagent with
those instructions. That agent handles project-type detection, per-package
configuration, and verification steps that go beyond what the basic init
workflow covers.

## Common Patterns

**User asks to set up or initialize selftune**
> Run `which selftune` to check installation. If missing, install with
> `npm install -g selftune`. Run `selftune init`, then verify with
> `selftune doctor`. Report results to the user.

**Hooks not capturing data**
> Run `selftune doctor` to check hook installation. Parse the JSON output
> for failed hook checks. If paths are wrong, update
> `~/.claude/settings.json` to point to actual files.

**Config exists but appears stale**
> Run `selftune init --force` to reinitialize. Verify with `selftune doctor`.
