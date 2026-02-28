# selftune Initialize Workflow

Bootstrap selftune for first-time use or after changing environments.

## When to Use

- First time using selftune in a new environment
- After switching agent platforms (Claude Code, Codex, OpenCode)
- After reinstalling or moving the selftune repository
- When `~/.selftune/config.json` does not exist

## Default Command

```bash
CLI_PATH=$(cat ~/.selftune/config.json | jq -r .cli_path)
bun run $CLI_PATH init [--agent <type>] [--cli-path <path>] [--llm-mode agent|api]
```

Fallback (if config does not exist yet):
```bash
bun run <repo-path>/cli/selftune/index.ts init [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--agent <type>` | Agent platform: `claude`, `codex`, `opencode` | Auto-detected |
| `--cli-path <path>` | Absolute path to `cli/selftune/index.ts` | Derived from repo location |
| `--llm-mode <mode>` | `agent` (use agent subprocess) or `api` (use Anthropic API directly) | `agent` |

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

### 1. Check Existing Config

```bash
cat ~/.selftune/config.json 2>/dev/null
```

If the file exists and is valid JSON, selftune is already initialized.
Skip to Step 5 (verify with doctor) unless the user wants to reinitialize.

### 2. Run Init

```bash
bun run /path/to/cli/selftune/index.ts init --agent claude --cli-path /path/to/cli/selftune/index.ts
```

Replace paths with the actual selftune repository location.

### 3. Install Hooks (Claude Code)

For Claude Code agents, merge the hooks from `skill/settings_snippet.json`
into `~/.claude/settings.json`. Three hooks are required:

| Hook | Script | Purpose |
|------|--------|---------|
| `UserPromptSubmit` | `hooks/prompt-log.ts` | Log every user query |
| `PostToolUse` (Read) | `hooks/skill-eval.ts` | Track skill triggers |
| `Stop` | `hooks/session-stop.ts` | Capture session telemetry |

Replace `/PATH/TO/` in the snippet with the actual `cli/selftune/` directory.

### 4. Platform-Specific Setup

**Codex agents:**
- Use `wrap-codex` for real-time telemetry capture (see `Workflows/Ingest.md`)
- Or batch-ingest existing sessions with `ingest-codex`

**OpenCode agents:**
- Use `ingest-opencode` to import sessions from the SQLite database
- See `Workflows/Ingest.md` for details

### 5. Verify with Doctor

```bash
CLI_PATH=$(cat ~/.selftune/config.json | jq -r .cli_path)
bun run $CLI_PATH doctor
```

Parse the JSON output. All checks should pass. If any fail, address the
reported issues before proceeding.

## Common Patterns

**"I just cloned the selftune repo"**
> Run init with `--cli-path` pointing to the cloned `cli/selftune/index.ts`.
> Then install hooks for your agent platform.

**"I moved the repo to a new directory"**
> Re-run init with the updated `--cli-path`. The config will be overwritten.

**"Hooks aren't capturing data"**
> Run `doctor` to check hook installation. Verify paths in
> `~/.claude/settings.json` point to actual files.

**"Config exists but seems stale"**
> Delete `~/.selftune/config.json` and re-run init, or run init with
> `--cli-path` to update the path.
