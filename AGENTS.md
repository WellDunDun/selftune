# AGENTS.md

## Repository Overview

selftune — Self-improving skills for AI agents. Watches real sessions, learns how users actually work, and evolves skill descriptions to match. Supports Claude Code, Codex, OpenCode, and OpenClaw.

**Stack:** TypeScript on Bun for the CLI, append-only JSONL logs plus SQLite materialization, a local React/Vite dashboard SPA, and zero runtime dependencies in the core CLI.

## Agent-First Architecture

**selftune is a skill consumed by AI agents, not a CLI tool used by humans directly.**

The user's interaction model is:
1. Install the skill: `npx skills add selftune-dev/selftune`
2. Tell their agent: "set up selftune" / "improve my skills" / "how are my skills doing?"
3. The agent reads `skill/SKILL.md`, routes to the correct workflow, and runs CLI commands

The CLI (`cli/selftune/`) is the **agent's API**. The skill definition (`skill/SKILL.md`) is the **product surface**. Workflow docs (`skill/Workflows/`) are the **agent's instruction manual**. Users rarely if ever run `selftune` commands directly — their coding agent does it for them.

**When developing selftune:**
- Changes to CLI behavior must be reflected in the corresponding `skill/Workflows/*.md` doc
- New CLI commands need a workflow doc and a routing entry in `skill/SKILL.md`
- Error messages should guide the agent, not the human (e.g., suggest the next CLI command, not "check the docs")
- The SKILL.md routing table and trigger keywords are as important as the CLI code itself — they determine whether the agent can find and use the feature

## Project Structure

```text
selftune/
├── cli/selftune/            # TypeScript package — the CLI
│   ├── index.ts             # CLI entry point
│   ├── init.ts              # Agent identity bootstrap + config init
│   ├── sync.ts              # Source-truth sync orchestration
│   ├── orchestrate.ts       # Autonomy-first loop: sync → evolve → watch
│   ├── schedule.ts          # Generic scheduling install/preview
│   ├── dashboard.ts         # Dashboard command entry point
│   ├── dashboard-server.ts  # Bun.serve API + SPA server
│   ├── dashboard-contract.ts # Shared dashboard payload types
│   ├── export.ts             # SQLite → JSONL export command
│   ├── types.ts             # Shared interfaces
│   ├── constants.ts         # Log paths, known tools, skip prefixes
│   ├── utils/               # Shared utilities
│   │   ├── jsonl.ts         # JSONL read/write/append
│   │   ├── transcript.ts    # Transcript parsing
│   │   ├── logging.ts       # Structured JSON logging
│   │   ├── seeded-random.ts # Deterministic PRNG
│   │   ├── llm-call.ts      # Shared LLM call utility
│   │   └── schema-validator.ts # JSONL schema validation
│   ├── hooks/               # Telemetry capture + activation hints (Claude Code hooks)
│   │   ├── prompt-log.ts    # UserPromptSubmit hook
│   │   ├── session-stop.ts  # Stop hook
│   │   ├── skill-eval.ts    # PostToolUse hook
│   │   ├── auto-activate.ts # UserPromptSubmit activation suggestions
│   │   ├── skill-change-guard.ts # PreToolUse guard for uncontrolled edits
│   │   └── evolution-guard.ts    # PreToolUse guard for monitored skills
│   ├── ingestors/           # Platform adapters (Codex, OpenCode, Claude replay, OpenClaw)
│   │   ├── claude-replay.ts # Claude Code transcript replay ingestor
│   │   ├── codex-wrapper.ts # Real-time Codex wrapper (experimental)
│   │   ├── codex-rollout.ts # Batch Codex ingestor (experimental)
│   │   ├── opencode-ingest.ts # OpenCode SQLite/JSON adapter (experimental)
│   │   └── openclaw-ingest.ts # OpenClaw session importer (experimental)
│   ├── routes/              # HTTP route handlers (extracted from dashboard-server)
│   ├── repair/              # Rebuild repaired skill-usage overlays
│   ├── localdb/             # SQLite schema, direct-write, queries, materialization, canonical_upload_staging
│   │   ├── db.ts            # Database lifecycle + singleton
│   │   ├── direct-write.ts  # Fail-open insert functions for all tables
│   │   ├── queries.ts       # Read queries for dashboard + CLI consumers
│   │   ├── schema.ts        # Table DDL + indexes (includes canonical_upload_staging)
│   │   └── materialize.ts   # JSONL → SQLite rebuild (startup/backfill only)
│   ├── cron/                # Optional OpenClaw-specific scheduler adapter
│   ├── memory/              # Evolution memory persistence
│   ├── eval/                # False negative detection, eval set generation
│   │   └── hooks-to-evals.ts
│   ├── grading/             # 3-tier session grading
│   │   └── grade-session.ts
│   ├── evolution/           # Skill description/body/routing evolution
│   │   ├── extract-patterns.ts   # Failure pattern extractor
│   │   ├── propose-description.ts # Description proposal generator
│   │   ├── validate-proposal.ts   # Proposal validator
│   │   ├── audit.ts              # Evolution audit trail
│   │   ├── evolve.ts             # Description evolution command
│   │   ├── deploy-proposal.ts    # SKILL.md writer + deploy
│   │   ├── rollback.ts           # Rollback mechanism
│   │   └── stopping-criteria.ts  # Stopping criteria evaluator
│   ├── monitoring/          # Post-deploy monitoring (M4)
│   │   └── watch.ts
│   ├── alpha-identity.ts    # Alpha user identity (UUID, consent, persistence)
│   ├── alpha-upload-contract.ts # Upload queue infrastructure types + PushUploadResult
│   ├── alpha-upload/        # Alpha remote data pipeline (V2 canonical push to cloud API)
│   │   ├── index.ts         # Upload orchestration (prepareUploads, runUploadCycle)
│   │   ├── queue.ts         # Local upload queue + watermark tracking
│   │   ├── stage-canonical.ts # JSONL + SQLite → canonical_upload_staging writer
│   │   ├── build-payloads.ts # Staging table → V2 canonical push payload builders
│   │   ├── client.ts        # HTTP upload client with Bearer auth (never throws)
│   │   └── flush.ts         # Queue flush with exponential backoff (409=success, 401/403=non-retryable)
│   ├── contribute/          # Opt-in anonymized data export (M7)
│   │   ├── bundle.ts        # Bundle assembler
│   │   ├── sanitize.ts      # Privacy sanitization (conservative/aggressive)
│   │   └── contribute.ts    # CLI entry point + GitHub submission
│   ├── observability.ts     # Health checks, log integrity, alpha queue health
│   ├── status.ts            # Skill health summary (M6)
│   ├── last.ts              # Last session insight (M6)
│   └── workflows/           # Workflow discovery and persistence
├── apps/local-dashboard/    # React SPA for overview + per-skill report UI
│   ├── src/pages/           # Overview and skill report routes
│   ├── src/components/      # Dashboard UI building blocks
│   └── src/hooks/           # Data-fetching hooks against dashboard-server
├── bin/                     # npm/node CLI entry point
│   └── selftune.cjs
├── skill/                   # Agent-facing selftune skill (self-contained)
│   ├── SKILL.md             # Skill definition + routing
│   ├── settings_snippet.json
│   ├── agents/              # Specialized subagents (bundled, copied to ~/.claude/agents/ on init)
│   │   ├── diagnosis-analyst.md
│   │   ├── evolution-reviewer.md
│   │   ├── integration-guide.md
│   │   └── pattern-analyst.md
│   ├── assets/              # Config templates (activation rules, settings)
│   ├── Workflows/           # Skill workflow routing docs
│   │   ├── Contribute.md
│   │   ├── Cron.md
│   │   ├── Dashboard.md
│   │   ├── Doctor.md
│   │   ├── Evals.md
│   │   ├── Evolve.md
│   │   ├── EvolveBody.md
│   │   ├── Grade.md
│   │   ├── Ingest.md
│   │   ├── Initialize.md
│   │   ├── Orchestrate.md
│   │   ├── Replay.md
│   │   ├── Rollback.md
│   │   ├── Schedule.md
│   │   ├── Sync.md
│   │   └── Watch.md
│   └── references/
│       ├── grading-methodology.md
│       ├── interactive-config.md
│       ├── invocation-taxonomy.md
│       └── logs.md
├── tests/                   # Test suite (bun test)
│   └── sandbox/             # Sandbox test harness (Layer 1 local + Layer 2 Docker)
│       ├── fixtures/        # Test skills, transcripts, JSONL logs, hook payloads
│       └── docker/          # Dockerfile, docker-compose, LLM test runner
├── docs/                    # Product, architecture, and execution docs
└── [root configs]           # package.json, tsconfig.json, Makefile, CI, etc.
```

## Architecture

See ARCHITECTURE.md for domain map, module layering, and dependency rules.

## Documentation Map

| Topic | Location | Status |
|-------|----------|--------|
| System Overview | docs/design-docs/system-overview.md | Current |
| Operator Guide | docs/operator-guide.md | Current |
| Architecture | ARCHITECTURE.md | Current |
| Product Requirements | PRD.md | Current |
| Skill Definition | skill/SKILL.md | Current |
| Design Docs | docs/design-docs/index.md | Current |
| Core Beliefs | docs/design-docs/core-beliefs.md | Current |
| Live Dashboard SSE | docs/design-docs/live-dashboard-sse.md | Current |
| SQLite-First Migration | docs/design-docs/sqlite-first-migration.md | Current |
| Product Specs | docs/product-specs/index.md | Current |
| Active Plans | docs/exec-plans/active/ | Current |
| Completed Plans | docs/exec-plans/completed/ | Current |
| Technical Debt | docs/exec-plans/tech-debt-tracker.md | Current |
| Risk Policy | risk-policy.json | Current |
| Golden Principles | docs/golden-principles.md | Current |
| Escalation Policy | docs/escalation-policy.md | Current |
| References | skill/references/ | Current |
| Launch Playbook | docs/launch-playbook-tracker.md | Current |
| Security Policy | SECURITY.md | Current |
| Contributing Guide | CONTRIBUTING.md | Current |
| Code of Conduct | CODE_OF_CONDUCT.md | Current |
| License | LICENSE | Current |

## Change Propagation Map

When changing one part of selftune, check if dependent files need updating.
This prevents stale docs and broken contracts.

| If you change... | Also update... |
|------------------|---------------|
| CLI commands in `index.ts` (add/rename/remove) | `skill/SKILL.md` Quick Reference + Workflow Routing table, `README.md` Commands table, `AGENTS.md` project tree |
| CLI flags on any command | The command's `skill/Workflows/*.md` doc (flags table + examples) |
| JSONL log schema or new log file | `constants.ts`, `types.ts`, `skill/references/logs.md`, `localdb/schema.ts` + `materialize.ts` + `direct-write.ts` + `queries.ts`, `ARCHITECTURE.md` data architecture |
| Dashboard contract (`dashboard-contract.ts`) | `apps/local-dashboard/src/types.ts`, dashboard components that consume the changed fields |
| Hook behavior (`hooks/*.ts`) | `skill/Workflows/Initialize.md` hook table, `skill/settings_snippet.json` |
| Orchestrate behavior | `skill/Workflows/Orchestrate.md`, `ARCHITECTURE.md` operating modes |
| Agent files (`skill/agents/*.md`) | `skill/SKILL.md` Specialized Agents table |
| New workflow file | `skill/SKILL.md` Workflow Routing table + Resource Index |
| Evolution pipeline changes | `skill/Workflows/Evolve.md`, `docs/design-docs/evolution-pipeline.md` |
| Platform adapter (ingestor) changes | `skill/Workflows/Ingest.md`, `README.md` Platforms section |
| Repo org/name change | `README.md` badges + install, `llms.txt`, `SECURITY.md`, `CONTRIBUTING.md`, `contribute.ts` repo constant, `package.json` (homepage/repo/bugs) |

## Development Workflow

1. Receive task via prompt
2. Read this file, then follow pointers to relevant docs
3. Read PRD.md for product context and the feedback loop model
4. Implement changes following ARCHITECTURE.md layer rules
5. **Check the Change Propagation Map above** — update dependent docs before committing
6. Run sandbox harness: `bun run tests/sandbox/run-sandbox.ts`
7. Run `make check` (lint + test) or `bun test`
8. Verify JSONL output schema matches appendix in PRD.md
9. Self-review: check log schema compatibility across all platforms
10. Open PR with concise summary

## Key Constraints

- **selftune is agent-first:** users interact through their coding agent, not the CLI directly. SKILL.md and workflow docs are the product surface; the CLI is the agent's API.
- Claude Code is the primary supported platform; Codex, OpenCode, and OpenClaw adapters are experimental (they exist but are not actively tested). All four write to the same shared log schema
- Source-truth transcripts/rollouts are authoritative; hooks are low-latency hints, not the canonical record
- Grading uses the user's existing agent subscription — no separate API key
- Hooks should be zero-config after installation where the host agent supports them
- Log files are append-only JSONL at `~/.claude/`
- Evolution proposals require validation against eval set before deploy
- `selftune orchestrate` is the primary autonomous loop; `selftune cron setup` installs OS-level scheduling (`selftune schedule` is a backward-compatible alias)
- All knowledge lives in-repo, not in external tools
- The core CLI keeps zero runtime dependencies and uses only Bun built-ins

## Golden Principles

See docs/golden-principles.md for the full set of mechanical taste rules.
