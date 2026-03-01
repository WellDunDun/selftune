# selftune Initialize Workflow

Bootstrap selftune for first-time use or after changing environments.

## When to Use

- First time using selftune in a new environment
- After switching agent platforms (Claude Code, Codex, OpenCode)
- When `~/.selftune/config.json` does not exist

## Default Command

```bash
selftune init [--agent <type>] [--llm-mode agent|api] [--force]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--agent <type>` | Agent platform: `claude`, `codex`, `opencode` | Auto-detected |
| `--llm-mode <mode>` | `agent` (use agent subprocess) or `api` (use Anthropic API directly) | `agent` |
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

### 1. Install the CLI

```bash
npm install -g selftune
```

Verify the CLI is on `PATH`:

```bash
selftune --help
```

### 2. Check Existing Config

```bash
cat ~/.selftune/config.json 2>/dev/null
```

If the file exists and is valid JSON, selftune is already initialized.
Skip to Step 6 (verify with doctor) unless the user wants to reinitialize.

### 3. Run Init

```bash
selftune init
```

The command auto-detects the agent platform, resolves the CLI path,
determines the LLM mode, and writes `~/.selftune/config.json`.

### 4. Install Hooks (Claude Code)

If `init` reports hooks are not installed, merge the entries from
`skill/settings_snippet.json` into `~/.claude/settings.json`. Three hooks
are required:

| Hook | Script | Purpose |
|------|--------|---------|
| `UserPromptSubmit` | `hooks/prompt-log.ts` | Log every user query |
| `PostToolUse` (Read) | `hooks/skill-eval.ts` | Track skill triggers |
| `Stop` | `hooks/session-stop.ts` | Capture session telemetry |

Derive hook script paths from the `cli_path` field in
`~/.selftune/config.json` — the hooks directory is at
`dirname(cli_path)/hooks/`.

### 5. Platform-Specific Setup

**Codex agents:**
- Use `selftune wrap-codex` for real-time telemetry capture (see `Workflows/Ingest.md`)
- Or batch-ingest existing sessions with `selftune ingest-codex`

**OpenCode agents:**
- Use `selftune ingest-opencode` to import sessions from the SQLite database
- See `Workflows/Ingest.md` for details

### 6. Verify with Doctor

```bash
selftune doctor
```

Parse the JSON output. All checks should pass. If any fail, address the
reported issues before proceeding.

## Common Patterns

**"Initialize selftune"**
> Install the CLI (`npm install -g selftune`), run `selftune init`,
> install hooks, and verify with `selftune doctor`.

**"Hooks aren't capturing data"**
> Run `selftune doctor` to check hook installation. Verify paths in
> `~/.claude/settings.json` point to actual files.

**"Config exists but seems stale"**
> Run `selftune init --force` to reinitialize.
