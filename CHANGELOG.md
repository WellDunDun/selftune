# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Local Dashboard SPA** — React + Vite + TypeScript SPA replacing the legacy embedded-HTML dashboard as the default view
  - Overview page with KPI cards, skill health grid with status filters, evolution feed, unmatched queries
  - Per-skill drilldown with usage stats, invocation records, evidence viewer, evolution timeline, pending proposals
  - Collapsible sidebar navigation listing all skills by health status
  - shadcn/ui component library with dark/light theme toggle and selftune branding
  - TanStack Query for data fetching with smart caching, background refetch, and instant back-navigation
  - 15-second background polling against SQLite-backed v2 API endpoints via TanStack Query `refetchInterval` (SSE was removed — SQLite reads are cheap enough for polling)
  - New components: `EvidenceViewer`, `EvolutionTimeline`, `ActivityTimeline`, `SkillHealthGrid`, `SectionCards`, `InfoTip`
  - Glossary tooltips on all metric labels (overview KPI cards, skill report KPI cards) explaining what each metric measures
  - Tab description tooltips on skill report tabs (Evidence, Invocations, Prompts, Sessions, Pending)
  - Collapsible lifecycle legend in evolution timeline explaining proposal stages (Created, Validated, Deployed, Rejected, Rolled Back)
  - Evidence context banner explaining the evidence trail concept
  - Renamed "Per-Entry Results" to "Individual Test Cases" for clarity
  - Onboarding flow: full empty-state guide for first-time users (3-step setup), dismissible welcome banner for returning users (localStorage-persisted)
- **SQLite v2 API endpoints** — `GET /api/v2/overview` and `GET /api/v2/skills/:name` backed by materialized SQLite queries (`getOverviewPayload()`, `getSkillReportPayload()`, `getSkillsList()`)
- **SQL query optimizations** — Replaced `NOT IN` subqueries with `LEFT JOIN + IS NULL`, moved JS-side dedup to SQL `GROUP BY`, added `LIMIT 200` to unbounded evidence queries
- **SPA serving from dashboard server** — Built SPA served at `/` as the supported local dashboard experience
- **Orchestrate decision report** — `selftune orchestrate` now prints a 5-phase human-readable decision report (sync, status, decisions, evolution results, watch) to stderr, and enriched JSON with a per-skill `decisions` array to stdout
- **Source-truth-driven pipeline** — Transcripts and rollouts are now the authoritative source; `sync` rebuilds repaired overlays from source data rather than relying solely on hook-time capture
- **Telemetry contract package** — `@selftune/telemetry-contract` workspace package with canonical schema types, validators, versioning, metadata, and golden fixture tests
- **Test split** — `make test-fast` / `make test-slow` and `bun run test:fast` / `bun run test:slow` for faster development feedback loop

## [0.2.1] — 2026-03-10

### Changed

- Updated package metadata to point to the new `selftune-dev/selftune` GitHub org and repository URLs.
- Organizational move follow-up release so npm metadata resolves to the new public repo.

## [0.2.0] — 2026-03-08

### Added

- **Full skill body evolution** — Teacher-student model for evolving routing tables and complete skill bodies with 3-gate validation (structural, trigger, quality)
- **Synthetic eval generation** — `selftune evals --synthetic --skill <name> --skill-path <path>` generates eval sets from SKILL.md via LLM without needing real session logs. Solves cold-start for new skills.
- **Batch trigger validation** — `validateProposalBatched()` batches 10 queries per LLM call (configurable via `TRIGGER_CHECK_BATCH_SIZE`). ~10x faster evolution loops. Sequential `validateProposalSequential()` kept for backward compat.
- **Cheap-loop evolution mode** — `selftune evolve --cheap-loop` uses haiku for proposal generation and validation, sonnet only for the final deployment gate. New `--gate-model` and `--proposal-model` flags for manual per-stage control.
- **Validation model selection** — `--validation-model` flag on `evolve` and `evolve-body` commands (default: `haiku`).
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
