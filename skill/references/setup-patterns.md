# selftune Setup Patterns

This reference keeps the core initialize workflow portable. Use it when the
user needs project-type-specific setup guidance after `selftune init`.

## Single-Skill Project

Use when the workspace has one primary `SKILL.md`.

- Merge `assets/single-skill-settings.json` into `~/.claude/settings.json`
- Keep `settings_snippet.json` nearby as the minimal hook reference
- Verify with `selftune doctor`

## Multi-Skill Project

Use when the workspace has multiple `SKILL.md` files that coexist in one repo.

- Merge `assets/multi-skill-settings.json` into `~/.claude/settings.json`
- Copy `assets/activation-rules-default.json` to
  `~/.selftune/activation-rules.json`
- Tune activation rules after `selftune doctor` reports healthy hooks
- Use `selftune workflows` once telemetry accumulates to discover repeated
  multi-skill chains

## Monorepo

Use the same template as a multi-skill project, but run `selftune init` from
the repo root so hook paths and telemetry cover the whole workspace.

## Codex-Only

- Install the CLI and run `selftune init --agent codex`
- Use `selftune wrap-codex -- <args>` for real-time capture or
  `selftune ingest-codex` for batch ingestion
- Use `selftune doctor` to verify the shared logs are healthy

## OpenCode-Only

- Run `selftune init --agent opencode`
- Use `selftune ingest-opencode` to backfill session data into the shared logs

## OpenClaw-Only

- Run `selftune init --agent openclaw`
- Use `selftune ingest-openclaw` for ingestion
- Use `selftune doctor` to verify the shared logs are healthy
- Use `selftune cron setup` if the user wants autonomous recurring runs

## Mixed-Agent Setup

Use when telemetry from Claude Code, Codex, OpenCode, or OpenClaw should be
combined.

- Initialize each platform against the same `~/.selftune/` data directory
- Ingest platform-specific logs into the shared JSONL schema
- Use `selftune status`, `selftune dashboard`, and `selftune workflows` on the
  merged dataset

## Optional Repository Extensions

Some repositories also bundle Claude-specific helper agents in `.claude/agents/`
for diagnosis, evolution review, or setup help. These are optional extensions,
not part of the core skill package installed by `npx skills add`.
