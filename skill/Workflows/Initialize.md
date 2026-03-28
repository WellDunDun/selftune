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

| Flag                      | Description                                                               | Default       |
| ------------------------- | ------------------------------------------------------------------------- | ------------- |
| `--agent <type>`          | Agent platform: `claude_code`, `codex`, `opencode`, `openclaw`            | Auto-detected |
| `--cli-path <path>`       | Override auto-detected CLI entry-point path                               | Auto-detected |
| `--force`                 | Reinitialize even if config already exists                                | Off           |
| `--no-sync`               | Skip historical transcript backfill during init                           | Sync on       |
| `--no-autonomy`           | Skip autonomous scheduling setup during init                              | Autonomy on   |
| `--enable-autonomy`       | (Deprecated alias) Enable autonomous scheduling — now on by default       | On            |
| `--schedule-format <fmt>` | Schedule format: `cron`, `launchd`, `systemd`                             | Auto-detected |
| `--alpha`                 | Enroll in the selftune alpha program (opens browser for device-code auth) | Off           |
| `--no-alpha`              | Unenroll from the alpha program (preserves user_id)                       | Off           |
| `--alpha-email <email>`   | Email for alpha enrollment (required with `--alpha`)                      | -             |
| `--alpha-name <name>`     | Display name for alpha enrollment                                         | -             |

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
    "cloud_user_id": "cloud-uuid-...",
    "cloud_org_id": "org-uuid-...",
    "email": "user@example.com",
    "display_name": "User Name",
    "consent_timestamp": "2026-02-28T10:00:00Z",
    "api_key": "<provisioned automatically via device-code flow>"
  }
}
```

### Field Descriptions

| Field                     | Type    | Description                                                       |
| ------------------------- | ------- | ----------------------------------------------------------------- |
| `agent_type`              | string  | Detected or specified agent platform                              |
| `cli_path`                | string  | Absolute path to the CLI entry point                              |
| `llm_mode`                | string  | How LLM calls are made: `agent` or `api`                          |
| `agent_cli`               | string  | CLI binary name for the detected agent                            |
| `hooks_installed`         | boolean | Whether telemetry hooks are installed                             |
| `initialized_at`          | string  | ISO 8601 timestamp                                                |
| `alpha`                   | object? | Alpha program enrollment (present only if enrolled)               |
| `alpha.enrolled`          | boolean | Whether the user is currently enrolled                            |
| `alpha.user_id`           | string  | Stable UUID, generated once, preserved across reinits             |
| `alpha.cloud_user_id`     | string? | Cloud account UUID (set by device-code flow)                      |
| `alpha.cloud_org_id`      | string? | Cloud organization UUID (set by device-code flow)                 |
| `alpha.email`             | string? | Email provided at enrollment                                      |
| `alpha.display_name`      | string? | Optional display name                                             |
| `alpha.consent_timestamp` | string  | ISO 8601 timestamp of consent                                     |
| `alpha.api_key`           | string? | Upload credential (provisioned automatically by device-code flow) |

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

For Claude Code, `selftune init` also syncs selftune's bundled specialized
agents from `skill/agents/` into `~/.claude/agents/`. The bundled files remain
the source of truth; the `~/.claude/agents/` copies exist only so native Claude
Code subagent calls stay up to date.

**Hook reference** (for troubleshooting):

| Hook                       | Script                        | Purpose                                         | Notes                                           |
| -------------------------- | ----------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `UserPromptSubmit`         | `hooks/prompt-log.ts`         | Log every user query                            | Accepts both `prompt` and legacy `user_prompt`   |
| `UserPromptSubmit`         | `hooks/auto-activate.ts`      | Suggest skills before prompt processing         | Uses `additionalContext` JSON for suggestions    |
| `PreToolUse` (Write/Edit)  | `hooks/skill-change-guard.ts` | Detect uncontrolled skill edits                 | `if` filter: only fires on `*SKILL.md` paths     |
| `PreToolUse` (Write/Edit)  | `hooks/evolution-guard.ts`    | Block SKILL.md edits on monitored skills        | `if` filter: only fires on `*SKILL.md` paths     |
| `PostToolUse` (Read/Skill) | `hooks/skill-eval.ts`         | Track skill triggers and Skill tool invocations |                                                  |
| `Stop`                     | `hooks/session-stop.ts`       | Capture session telemetry                       | Runs async (non-blocking), 60s timeout           |

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

### 8. Sync Historical Transcripts

Init automatically runs `selftune sync` to backfill existing session
transcripts into the SQLite database. This replays Claude Code transcripts,
Codex rollouts, OpenCode sessions, and OpenClaw sessions so the eval set
and evolution pipeline have data to work with immediately.

The sync step is fail-open — if it encounters errors, init continues.
Skip with `--no-sync` if you only want hooks for forward-looking data.

### 9. Autonomy Scheduling

Init automatically installs OS-level scheduling (launchd on macOS, cron/systemd
on Linux) so `selftune orchestrate` runs in the background. This is equivalent
to running `selftune cron setup` manually.

Skip with `--no-autonomy` if you prefer manual orchestration only.

### 10. Offer Alpha Enrollment

After local setup passes, always offer alpha enrollment before ending the setup
workflow.

Use the `AskUserQuestion` tool to ask:

- `Would you like to enroll in the selftune alpha program for cloud-synced analytics?`

Options:

- `Yes — enable alpha uploads and richer cloud analytics`
- `No — keep local-only selftune`

If the user chooses yes, continue with the Alpha Enrollment steps below. If they
choose no, explicitly confirm that local-only setup is complete.

### 11. Initial Data Upload

After alpha enrollment succeeds and sync has backfilled historical data, init
automatically triggers an upload cycle to push data to the cloud immediately.
This ensures the cloud has data from the moment the user finishes setup — they
don't have to wait for the next scheduled orchestrate run.

The upload is fail-open — if it fails, init still completes successfully.

Additionally, every `selftune sync` run now triggers an upload cycle when alpha
is enrolled, so data flows to the cloud every 30 minutes (matching the sync
schedule) rather than waiting for the 2-hour orchestrate cycle.

## Integration Guide

For project-type-specific setup (single-skill, multi-skill, monorepo, Codex,
OpenCode, mixed agents), see [docs/integration-guide.md](../../docs/integration-guide.md).

Templates for each project type are bundled with the skill:

- `skill/settings_snippet.json` — hooks for Claude Code projects
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

1. Use `AskUserQuestion` to ask whether the user wants to opt into the selftune alpha data-sharing program
   Options:
   - `Yes — enable cloud-synced analytics and alpha uploads`
   - `No — keep local-only selftune`
2. If they opt in, ask for their email and optional display name
3. If they decline, skip alpha enrollment and continue with plain `selftune init`

The CLI stays non-interactive. The agent is responsible for collecting consent
and the required `--alpha-email` value before invoking the command.

## Alpha Enrollment (Device-Code Flow)

The alpha program sends canonical telemetry to the selftune cloud for analysis.
Enrollment uses a device-code flow — one command, one browser approval, fully automatic.

### Setup Sequence

1. **Check local config**: Run `selftune status` — look for the "Alpha Upload" section
2. **If not linked**: First use `AskUserQuestion` for the opt-in decision. Only if the user says yes, collect their email and run:

   ```bash
   selftune init --alpha --alpha-email <user-email> --force
   ```

3. **Browser opens automatically**: The CLI requests a device code, opens the verification URL in the browser with the code pre-filled, and polls for approval.
4. **User approves in browser**: One click to authorize.
5. **CLI receives credentials**: API key, cloud_user_id, and org_id are automatically provisioned and stored in `~/.selftune/config.json` with `0600` permissions.
6. **Verify readiness**: The init command prints a readiness check. If all checks pass, alpha upload is active.
   The readiness JSON includes a `guidance` object with:
   - `message`
   - `next_command`
   - `suggested_commands[]`
   - `blocking`
7. **If readiness fails**: Run `selftune doctor` to diagnose. Common issues:
   - `not enrolled` → re-run `selftune init --alpha --alpha-email <email> --force`
   - Device-code expired → re-run the init command (codes expire after ~15 minutes)

### Key Principle

The cloud app is used **only** for the one-time browser approval during device-code auth. All other selftune operations happen through the local CLI and this agent.

### Enroll

```bash
selftune init --alpha --alpha-email user@example.com --alpha-name "User Name" --force
```

The `--alpha-email` flag is required. The command will:

1. Generate a stable UUID (preserved across reinits)
2. Request a device code from the cloud API
3. Open the browser to the verification URL
4. Poll until the user approves
5. Receive and store the API key, cloud_user_id, and org_id automatically
6. Write the alpha block to `~/.selftune/config.json` with `0600` permissions
7. Print an `alpha_enrolled` JSON message to stdout
8. Print the consent notice to stderr

The consent notice explicitly states that the friendly alpha cohort shares raw
prompt/query text in addition to skill/session/evolution metadata.

### Upload Behavior

Once enrolled, `selftune orchestrate` automatically uploads new session,
invocation, and evolution data to the cloud API at the end of each run.
This upload step is fail-open -- errors never block the orchestrate loop.
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
  "code": "alpha_email_required",
  "error": "alpha_email_required",
  "message": "The --alpha-email flag is required for alpha enrollment.",
  "next_command": "selftune init --alpha --alpha-email <email>",
  "suggested_commands": ["selftune status", "selftune doctor"],
  "blocking": true
}
```

If the device-code flow fails (network error, timeout, user denied), the CLI throws
with a descriptive error message. The agent should relay this to the user and suggest
retrying with `selftune init --alpha --alpha-email <email> --force`.

## Common Patterns

**User asks to set up or initialize selftune**

> Run `which selftune` to check installation. If missing, install with
> `npm install -g selftune`. Run `selftune init`, then verify with
> `selftune doctor`. Report results to the user.

**User wants alpha enrollment**

> Use `AskUserQuestion` for the yes or no opt-in decision. If yes, collect email
> and optional display name in chat, then run `selftune init --alpha --alpha-email ...`.
> The browser opens automatically for approval. No manual key management needed.

**Hooks not capturing data**

> Run `selftune doctor` to check hook installation. Parse the JSON output
> for failed hook checks. If paths are wrong, update
> `~/.claude/settings.json` to point to actual files.

**Config exists but appears stale**

> Run `selftune init --force` to reinitialize. Verify with `selftune doctor`.
