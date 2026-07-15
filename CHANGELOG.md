# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Native desktop lifecycle** — installed macOS builds can run the authenticated local sidecar as a crash-restarting, login-started LaunchAgent independent of the Electron window, and signed desktop releases now download GitHub Release updates in the background with explicit restart controls.
- **Project Skill Sets** — cache immutable package revisions in a local Library, preview and apply conflict-free Codex or Claude Code project links, and roll back only receipt-owned paths through the CLI or native Projects screen.
- **Real-time improvement signal detection** — `prompt-log` hook detects user corrections ("why didn't you use X?") and explicit skill requests via pure regex patterns. Signals are logged to `~/.claude/improvement_signals.jsonl` with skill name extraction from installed skills.
- **Signal-reactive orchestration** — `session-stop` hook checks for pending improvement signals and spawns a focused `selftune orchestrate --max-skills 2` run in the background. Respects a 30-minute lockfile to prevent concurrent runs.
- **Signal-aware candidate selection** — Orchestrator reads pending signals and boosts priority for mentioned skills (+150 per signal, capped at +450). Signaled skills bypass the minimum evidence gate and the "UNGRADED with 0 missed queries" gate.
- **Orchestrate lockfile** — `acquireLock()`/`releaseLock()` with PID+timestamp in `~/.claude/.orchestrate.lock`. 30-minute stale threshold prevents deadlocks from crashed runs.
- **Signal consumption** — After an orchestrate run completes, consumed signals are marked with `consumed: true`, `consumed_at`, and `consumed_by_run` so they don't affect subsequent runs.

### Changed

- **Scoped desktop supervision** — Electron now composes an Effect-owned runtime with queued lifecycle transitions, connection-generation-safe health recovery, staged authenticated window rebinding, schema-decoded tray responses, removable IPC handlers, deterministic shutdown that preserves CLI and OS-service ownership, and a packaged JavaScript boundary for internal workspace modules.
- **Scoped local dashboard runtime** — dashboard workflows now run through a typed Effect service and managed Layer; auth, SSE resources, SPA transport, request validation, and SQLite read routes have independent owners while the Bun server remains the process composition root.
- **Lean npm distribution** — release packaging now flattens shared external runtimes into the root manifest and normalizes bundled workspace links, preventing npm from recursively embedding duplicate Effect and Zod development trees in the SelfTune tarball.
- **Faster native Library loading** — the desktop shell uses a compact summary instead of downloading the full analytics history, inventory no longer waits on GitHub update checks, repeated harness links share one package hash per scan, and portfolio combination analysis skips query-log work when it only needs positive examples.
- **Compact harness inventory** — the native Library shows harness logos without repeated labels in each row, preserves names in accessible tooltips, and scales the Pi mark to match the other harness icons.
- **Publish version ceiling now respects live npm** — export no longer reuses a stale repository `package.json` version when npm already has a newer release, so shipped OSS changes publish the next real patch version instead of colliding with the latest package on npm.
- **GitHub releases use curated changelog entries** — OSS publish now renders release bodies from the Mintlify changelog when a matching entry exists, with `CHANGELOG.md` used as the fallback body for unmatched versions.
- **Dedicated creator-loop workflow** — the shipped selftune skill now exposes "create, test, and deploy" as a first-class routed workflow while keeping `Evals`, `UnitTest`, `Baseline`, `Evolve`, and `Watch` as atomic workflow docs instead of demoting them to references.

## [0.2.0] — 2026-03-08

### Added

- **Full skill body evolution** — Teacher-student model for evolving routing tables and complete skill bodies with 3-gate validation (structural, trigger, quality)
- **Synthetic eval generation** — `selftune eval generate --synthetic --skill <name> --skill-path <path>` generates eval sets from SKILL.md via LLM without needing real session logs. Solves cold-start for new skills.
- **Batch trigger validation** — `validateProposalBatched()` batches 10 queries per LLM call (configurable via `TRIGGER_CHECK_BATCH_SIZE`). ~10x faster evolution loops. Sequential `validateProposalSequential()` kept for backward compat.
- **Cheap-loop evolution mode** — `selftune evolve --cheap-loop` uses haiku for proposal generation and validation, sonnet only for the final deployment gate. New `--gate-model` and `--proposal-model` flags for manual per-stage control.
- **Validation model selection** — `--validation-model` flag on `evolve` and `evolve body` commands (default: `haiku`).
- **Proposal model selection** — `--proposal-model` flag on `evolve`, passed through to `generateProposal()` and `generateMultipleProposals()`.
- **Gate validation dependency injection** — `gateValidateProposal` added to `EvolveDeps` for testability.
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

### Changed

- `validateProposal()` now delegates to `validateProposalBatched()` by default (was sequential).
- `hooks-to-evals.ts` `cliMain()` is now async to support synthetic generation.
- `EvolveOptions` extended with `validationModel`, `cheapLoop`, `gateModel`, `proposalModel`.
- `EvolveResult` extended with `gateValidation`.

## [0.1.4] - 2026-03-01

### Added

- `selftune status` — CLI skill health summary with pass rates, trends, and system health
- `selftune last` — Quick insight from the most recent session
- `selftune dashboard` — Skill-health-centric HTML dashboard with grid view and drill-down
- `selftune ingest claude` — Claude Code transcript replay for retroactive log backfill
- `selftune contribute` — Opt-in anonymized data export for community contribution
- CI/CD workflows: publish, auto-bump, CodeQL, scorecard
- FOSS governance: LICENSE (MIT), CODE_OF_CONDUCT, CONTRIBUTING, SECURITY
- npm package configuration with CJS bin entry point

## [0.1.0] - 2026-02-28

### Added

- CLI entry point with 10 commands: `init`, `eval generate`, `grade`, `evolve`, `evolve rollback`, `watch`, `doctor`, `ingest codex`, `ingest opencode`, `ingest wrap-codex`
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
