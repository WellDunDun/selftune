# AGENTS.md

## Repository Overview

selftune — Self-improving skills for AI agents. Watches real sessions, learns how users actually work, and evolves skill descriptions to match. Supports Claude Code, Codex, OpenCode, and OpenClaw.

**Stack:** TypeScript on Bun for the CLI, append-only JSONL logs plus SQLite materialization, a local React/Vite dashboard SPA, and zero runtime dependencies in the core CLI.

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
│   │   └── skill-eval.ts    # PostToolUse hook
│   ├── ingestors/           # Platform adapters (Codex, OpenCode, Claude replay, OpenClaw)
│   │   ├── codex-wrapper.ts # Real-time Codex wrapper
│   │   ├── codex-rollout.ts # Batch Codex ingestor
│   │   ├── opencode-ingest.ts # OpenCode SQLite/JSON adapter
│   │   └── claude-replay.ts # Claude Code transcript replay ingestor
│   ├── repair/              # Rebuild repaired skill-usage overlays
│   ├── localdb/             # SQLite materialization + overview/report queries
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
│   ├── contribute/          # Opt-in anonymized data export (M7)
│   │   ├── bundle.ts        # Bundle assembler
│   │   ├── sanitize.ts      # Privacy sanitization (conservative/aggressive)
│   │   └── contribute.ts    # CLI entry point + GitHub submission
│   ├── observability.ts     # Health checks, log integrity
│   ├── status.ts            # Skill health summary (M6)
│   ├── last.ts              # Last session insight (M6)
│   └── workflows/           # Workflow discovery and persistence
├── apps/local-dashboard/    # React SPA for overview + per-skill report UI
│   ├── src/pages/           # Overview and skill report routes
│   ├── src/components/      # Dashboard UI building blocks
│   └── src/hooks/           # Data-fetching hooks against dashboard-server
├── bin/                     # npm/node CLI entry point
│   └── selftune.cjs
├── skill/                   # Agent-facing selftune skill
│   ├── SKILL.md             # Skill definition
│   ├── settings_snippet.json
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

## Development Workflow

1. Receive task via prompt
2. Read this file, then follow pointers to relevant docs
3. Read PRD.md for product context and the feedback loop model
4. Implement changes following ARCHITECTURE.md layer rules
5. Run sandbox harness: `bun run tests/sandbox/run-sandbox.ts`
6. Run `make check` (lint + test) or `bun test`
7. Verify JSONL output schema matches appendix in PRD.md
8. Self-review: check log schema compatibility across all three platforms
9. Open PR with concise summary

## Key Constraints

- All three platform adapters (Claude Code, Codex, OpenCode) write to the same shared log schema
- Source-truth transcripts/rollouts are authoritative; hooks are low-latency hints, not the canonical record
- Grading uses the user's existing agent subscription — no separate API key
- Hooks should be zero-config after installation where the host agent supports them
- Log files are append-only JSONL at `~/.claude/`
- Evolution proposals require validation against eval set before deploy
- `selftune orchestrate` and `selftune schedule --install` are the primary autonomous loop; `selftune cron` is the OpenClaw-specific adapter
- All knowledge lives in-repo, not in external tools
- The core CLI keeps zero runtime dependencies and uses only Bun built-ins

## Golden Principles

See docs/golden-principles.md for the full set of mechanical taste rules.
