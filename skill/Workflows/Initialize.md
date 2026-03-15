# selftune Initialize Workflow

Bootstrap selftune for first-time use or after changing environments.

## When to Use

- First time using selftune in a new environment
- After switching agent platforms (Claude Code, Codex, OpenCode)
- When `~/.selftune/config.json` does not exist

## Default Command

```bash
selftune init [--agent <type>] [--cli-path <path>] [--force] [--enable-autonomy] [--schedule-format <cron|launchd|systemd>]
```

## Recommended Default

For most users, the intended setup path is:

```bash
selftune init --enable-autonomy
```

That keeps the product aligned with the autonomy-first loop:

- installs config
- verifies the local environment
- activates the recurring scheduler path

Use plain `selftune init` when you only want bootstrap or debugging without
turning on recurring automation yet.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--agent <type>` | Agent platform: `claude`, `codex`, `opencode` | Auto-detected |
| `--cli-path <path>` | Override auto-detected CLI entry-point path | Auto-detected |
| `--force` | Reinitialize even if config already exists | Off |
| `--enable-autonomy` | Install and activate the autonomous scheduler for the current platform | Off |
| `--schedule-format <type>` | Override the scheduler format used by `--enable-autonomy` | Platform default |

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

### 4. Install Hooks (Claude Code)

If `init` reports hooks are not installed, merge a bundled settings template
into `~/.claude/settings.json`:

- Single-skill project: `assets/single-skill-settings.json`
- Multi-skill or monorepo project: `assets/multi-skill-settings.json`
- Minimal hook reference: `settings_snippet.json`

Six hooks are required in the full Claude Code setup:

| Hook | Script | Purpose |
|------|--------|---------|
| `UserPromptSubmit` | `hooks/prompt-log.ts` | Log every user query |
| `UserPromptSubmit` | `hooks/auto-activate.ts` | Suggest skills before prompt processing |
| `PreToolUse` (Write/Edit) | `hooks/skill-change-guard.ts` | Detect uncontrolled skill edits |
| `PreToolUse` (Write/Edit) | `hooks/evolution-guard.ts` | Block SKILL.md edits on monitored skills |
| `PostToolUse` (Read) | `hooks/skill-eval.ts` | Track skill triggers |
| `Stop` | `hooks/session-stop.ts` | Capture session telemetry |

Derive the hook script paths from the `cli_path` field in `~/.selftune/config.json`.
The hooks directory is at `dirname(cli_path)/hooks/`.

**Codex agents:**
- Use `wrap-codex` for real-time telemetry capture (see `Workflows/Ingest.md`)
- Or batch-ingest existing sessions with `selftune ingest-codex`

**OpenCode agents:**
- Use `selftune ingest-opencode` to import sessions from the SQLite database
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

From the installed selftune skill directory, copy the default activation rules
template:

```bash
cp assets/activation-rules-default.json ~/.selftune/activation-rules.json
```

The activation rules file configures auto-activation behavior -- which skills
get suggested and under what conditions. Edit `~/.selftune/activation-rules.json`
to customize thresholds and skill mappings for your project.

### 7. Optional Repository Extensions

Some repositories also bundle Claude-specific helper agents in `.claude/agents/`
for diagnosis, evolution review, or guided setup. These are optional extensions,
not part of the core installed skill package.

If the current workspace already includes them, you can use them as helpers.
Otherwise skip this step.

### 8. Verify with Doctor

```bash
selftune doctor
```

Parse the JSON output. All checks should pass. If any fail, address the
reported issues before proceeding.

## Setup Patterns

For project-type-specific setup guidance, read
`references/setup-patterns.md`.

Bundled setup assets:
- `assets/single-skill-settings.json` — hooks for single-skill projects
- `assets/multi-skill-settings.json` — hooks for multi-skill and monorepo projects
- `assets/activation-rules-default.json` — default auto-activation rules

## Common Patterns

**"Initialize selftune"**
> Install the CLI (`npm install -g selftune`), run
> `selftune init --enable-autonomy`, install hooks if needed, and verify with
> `selftune doctor`.

**"Initialize and turn on the autonomous loop"**
> Run `selftune init --enable-autonomy`. Use `--schedule-format` if you need to override the platform default scheduler.

**"Hooks aren't capturing data"**
> Run `selftune doctor` to check hook installation. Verify paths in
> `~/.claude/settings.json` point to actual files.

**"Config exists but seems stale"**
> Run `selftune init --force` to reinitialize.
