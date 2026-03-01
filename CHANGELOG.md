# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.3] - 2026-03-01

### Added

- `selftune status` — CLI skill health summary with pass rates, trends, and system health
- `selftune last` — Quick insight from the most recent session
- `selftune dashboard` — Skill-health-centric HTML dashboard with grid view and drill-down
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
