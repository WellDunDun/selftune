# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Synthetic eval generation** — `selftune evals --synthetic --skill <name> --skill-path <path>` generates eval sets from SKILL.md via LLM without needing real session logs. New `cli/selftune/eval/synthetic-evals.ts` module with `generateSyntheticEvals()`. Solves cold-start for new skills.
- **Batch trigger validation** — `validateProposalBatched()` batches 10 queries per LLM call (configurable via `TRIGGER_CHECK_BATCH_SIZE`). New `buildBatchTriggerCheckPrompt()` and `parseBatchTriggerResponse()` in `trigger-check.ts`. Sequential `validateProposalSequential()` kept for backward compat.
- **Validation model selection** — `--validation-model` flag on `evolve` and `evolve-body` commands (default: `haiku`). Passed through to all `validateProposal()` and `measureBaseline()` calls.
- **Cheap-loop evolution mode** — `selftune evolve --cheap-loop` uses haiku for proposal generation and validation, sonnet only for the final deployment gate. New `--gate-model` and `--proposal-model` flags for manual per-stage control. Gate validation step (Step 13c) re-runs validation with the expensive model before deploy.
- **Proposal model selection** — `--proposal-model` flag on `evolve`, passed through to `generateProposal()` and `generateMultipleProposals()`.
- **Gate validation dependency injection** — `gateValidateProposal` added to `EvolveDeps` for testability.

### Changed

- `validateProposal()` now delegates to `validateProposalBatched()` by default (was sequential).
- `hooks-to-evals.ts` `cliMain()` is now async to support synthetic generation.
- `EvolveOptions` extended with `validationModel`, `cheapLoop`, `gateModel`, `proposalModel`.
- `EvolveResult` extended with `gateValidation`.

## [0.2.0] — 2026-03-05

### Added

- **Auto-activation system** — `auto-activate.ts` UserPromptSubmit hook detects when selftune should run and outputs formatted suggestions; session state tracking prevents repeated nags; PAI coexistence support
- **Skill change guard** — `skill-change-guard.ts` PreToolUse hook detects Write/Edit to SKILL.md files and suggests running `selftune watch`
- **Evolution memory** — 3-file persistence system at `~/.selftune/memory/` (context.md, plan.md, decisions.md) survives context resets; auto-maintained by evolve, rollback, and watch commands
- **Specialized agents** — 4 purpose-built Claude Code agents: diagnosis-analyst, pattern-analyst, evolution-reviewer, integration-guide
- **Enforcement guardrails** — `evolution-guard.ts` PreToolUse hook blocks SKILL.md edits on actively monitored skills unless `selftune watch` has been run recently
- **Integration guide** — Comprehensive `docs/integration-guide.md` with project-type patterns (single-skill, multi-skill, monorepo, Codex-only, OpenCode-only, mixed)
- **Settings templates** — `templates/single-skill-settings.json`, `templates/multi-skill-settings.json`, `templates/activation-rules-default.json`
- **Enhanced init** — `selftune init` now detects workspace structure (skill count, monorepo layout) and suggests appropriate template
- **Dashboard server** — `selftune dashboard --serve` launches live Bun.serve server with SSE auto-refresh, action buttons (watch/evolve/rollback), and evolution timeline
- **Activation rules engine** — Configurable trigger rules for auto-activation (grading thresholds, stale evolutions, regression detection)
- **Sandbox test harness** (`tests/sandbox/run-sandbox.ts`): Exercises all CLI commands and hooks against fixture data in an isolated `/tmp` environment. Runs in ~400ms with 10/10 tests passing.
- **Devcontainer-based LLM testing** (`.devcontainer/` + `tests/sandbox/docker/`): Based on the official Claude Code devcontainer reference. Uses `claude -p` with `--dangerously-skip-permissions` for unattended LLM-dependent testing (grade, evolve, watch). No API key required — uses existing Claude subscription.
- **Realistic test fixtures**: 3 skills from skills.sh (find-skills, frontend-design, ai-image-generation) with 15 sessions, 30 queries, 7 skill usage records, and evolution audit history.
- **Hook integration tests**: All 3 Claude Code hooks (prompt-log, skill-eval, session-stop) tested via stdin payload injection.

## [0.1.4] - 2026-03-01

### Added

- `selftune status` — CLI skill health summary with pass rates, trends, and system health
- `selftune last` — Quick insight from the most recent session
- `selftune dashboard` — Skill-health-centric HTML dashboard with grid view and drill-down
- `selftune replay` — Claude Code transcript replay for retroactive log backfill
- `selftune contribute` — Opt-in anonymized data export for community contribution
- CI/CD workflows: publish, auto-bump, CodeQL, scorecard
- FOSS governance: LICENSE (MIT), CODE_OF_CONDUCT, CONTRIBUTING, SECURITY
- npm package configuration with CJS bin entry point

## [0.1.0] - 2026-02-28

### Added

- CLI entry point with 10 commands: `init`, `evals`, `grade`, `evolve`, `rollback`, `watch`, `doctor`, `ingest-codex`, `ingest-opencode`, `wrap-codex`
- Agent auto-detection for Claude Code, Codex, and OpenCode
- Telemetry hooks for Claude Code (`prompt-log`, `skill-eval`, `session-stop`)
- Codex wrapper and batch ingestor for rollout logs
- OpenCode session backfill from SQLite
- False negative detection and eval set generation from real usage logs
- 3-tier session grading (Trigger / Process / Quality)
- Skill evolution loop: extract patterns, propose description, validate, deploy
- Post-deploy monitoring with sliding window regression detection and auto-rollback
- Health check system (`doctor` command)
- Architecture enforcement via custom lint rules
- Comprehensive test suite (27 test files)
