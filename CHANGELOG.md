# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-03-01

### Added

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
