# selftune Initialize Workflow

Bootstrap selftune for first-time use or after changing environments.

## When to Use

- The user asks to set up selftune, configure selftune, or initialize selftune
- The agent detects `~/.selftune/config.json` does not exist
- The user has switched agent platforms (Claude Code, Codex, OpenCode)

## Default Command

```bash
selftune init [--agent <type>] [--cli-path <path>] [--force]
selftune init --alpha --alpha-email <email> [--alpha-name "Name"] [--force]
selftune init --no-alpha [--force]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--agent <type>` | Agent platform: `claude_code`, `codex`, `opencode`, `openclaw` | Auto-detected |
| `--cli-path <path>` | Override auto-detected CLI entry-point path | Auto-detected |
| `--force` | Reinitialize even if config already exists | Off |
| `--enable-autonomy` | Enable autonomous scheduling during init | Off |
| `--schedule-format <fmt>` | Schedule format: `cron`, `launchd`, `systemd` | Auto-detected |
| `--alpha` | Enroll in the selftune alpha program | Off |
| `--no-alpha` | Unenroll from the alpha program (preserves user_id) | Off |
| `--alpha-email <email>` | Email for alpha enrollment (required with `--alpha`) | - |
| `--alpha-name <name>` | Display name for alpha enrollment | - |
| `--alpha-key <key>` | API key for cloud uploads (`st_live_*` format) | - |

## Output Format

Creates `~/.selftune/config.json`:

```json
{
  "agent_type": "claude_code",
  "cli_path": "/Users/you/selftune/cli/selftune/index.ts",
  "llm_mode": "agent",
  "agent_cli": "claude",
  "hooks_installed": true,
  "initialized_at": "2026-02-28T10:00:00Z",
  "alpha": {
    "enrolled": true,
    "user_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "email": "user@example.com",
    "display_name": "User Name",
    "consent_timestamp": "2026-02-28T10:00:00Z"
  }
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
| `alpha` | object? | Alpha program enrollment (present only if enrolled) |
| `alpha.enrolled` | boolean | Whether the user is currently enrolled |
| `alpha.user_id` | string | Stable UUID, generated once, preserved across reinits |
| `alpha.email` | string? | Email provided at enrollment |
| `alpha.display_name` | string? | Optional display name |
| `alpha.consent_timestamp` | string | ISO 8601 timestamp of consent |

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

Templates for each project type are in the `assets/` directory:
- `assets/settings_snippet.json` — hooks for Claude Code projects
- `assets/activation-rules-default.json` — default auto-activation rule configuration

## Subagent Escalation

For complex project structures (monorepos, multi-skill repos, mixed agent
platforms), read `agents/integration-guide.md` and spawn a subagent with
those instructions. That agent handles project-type detection, per-package
configuration, and verification steps that go beyond what the basic init
workflow covers.

## Alpha Enrollment

Enroll the user in the selftune alpha program for early access features.

Before running the alpha command:
1. Ask whether the user wants to opt into the selftune alpha data-sharing program
2. If they opt in, ask for their email and optional display name
3. If they decline, skip alpha enrollment and continue with plain `selftune init`

The CLI stays non-interactive. The agent is responsible for collecting consent
and the required `--alpha-email` value before invoking the command.

## Alpha Enrollment (Agent-First Flow)

The alpha program sends canonical telemetry to the selftune cloud for analysis.
Setup is agent-first — the cloud app is a one-time control-plane handoff, not the main UX.

### Setup Sequence

1. **Check local config**: Run `selftune status` — look for the "Alpha Upload" section
2. **If not linked**: Tell the user:
   > To join the selftune alpha program, you need to create an account at https://app.selftune.dev and issue an upload credential. This is a one-time step — afterwards everything runs locally through the CLI.
3. **User completes cloud enrollment**: Signs in, enrolls, copies the `st_live_*` credential
4. **Store credential locally**:
   ```bash
   selftune init --alpha --alpha-email <user-email> --alpha-key <st_live_credential>
   ```
5. **Verify readiness**: The init command prints a readiness check. If all checks pass, alpha upload is active.
6. **If readiness fails**: Run `selftune doctor` to diagnose. Common issues:
   - `api_key not set` → re-run init with `--alpha-key`
   - `api_key has invalid format` → credential must start with `st_live_` or `st_test_`
   - `not enrolled` → re-run init with `--alpha --alpha-email <email> --alpha-key <key>`

### Key Principle

The cloud app is used **only** for:
- Sign-in
- Alpha enrollment
- Upload credential issuance

All other selftune operations happen through the local CLI and this agent.

### Enroll

```bash
selftune init --alpha --alpha-email user@example.com --alpha-name "User Name" --force
selftune init --alpha-key st_live_abc123...  # after enrollment, store the API key
```

The `--alpha-email` flag is required. The command will:
1. Generate a stable UUID (preserved across reinits)
2. Write the alpha block to `~/.selftune/config.json`
3. Print an `alpha_enrolled` JSON message to stdout
4. Print the consent notice to stderr

The consent notice explicitly states that the friendly alpha cohort shares raw
prompt/query text in addition to skill/session/evolution metadata.

### API Key Provisioning

After enrollment, users need to configure an API key for cloud uploads:

1. Create a cloud account at the selftune web app
2. Generate an API key (format: `st_live_*`)
3. Store the key locally:

```bash
selftune init --alpha-key st_live_abc123...
```

Without an API key, alpha enrollment is recorded locally but no uploads are attempted.

### Upload Behavior

Once enrolled and an API key is configured, `selftune orchestrate` automatically
uploads new session, invocation, and evolution data to the cloud API at the end of
each run. This upload step is fail-open -- errors never block the orchestrate loop.
Use `selftune alpha upload` for manual uploads or `selftune alpha upload --dry-run`
to preview what would be sent.

The upload endpoint is `https://api.selftune.dev/api/v1/push`, authenticated with
the stored API key via `Authorization: Bearer` header. The endpoint can be
overridden with the `SELFTUNE_ALPHA_ENDPOINT` environment variable.

### Unenroll

```bash
selftune init --no-alpha --force
```

Sets `enrolled: false` in the alpha block but preserves the `user_id` so re-enrollment does not create a new identity.

### Error Handling

If `--alpha` is passed without `--alpha-email`, the CLI throws a JSON error:

```json
{
  "error": "alpha_email_required",
  "message": "The --alpha-email flag is required for alpha enrollment.",
  "next_command": "selftune init --alpha --alpha-email <email>"
}
```

## Common Patterns

**User asks to set up or initialize selftune**
> Run `which selftune` to check installation. If missing, install with
> `npm install -g selftune`. Run `selftune init`, then verify with
> `selftune doctor`. Report results to the user.

**User wants alpha enrollment**
> Ask whether they want to opt into alpha data sharing. If yes, collect email
> and optional display name, then run `selftune init --alpha --alpha-email ...`.
> If no, continue with plain `selftune init`.

**Hooks not capturing data**
> Run `selftune doctor` to check hook installation. Parse the JSON output
> for failed hook checks. If paths are wrong, update
> `~/.claude/settings.json` to point to actual files.

**Config exists but appears stale**
> Run `selftune init --force` to reinitialize. Verify with `selftune doctor`.
