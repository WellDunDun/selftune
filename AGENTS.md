# AGENTS.md

## Repository Overview

selftune — Skill observability and continuous improvement for Claude Code, Codex, and OpenCode. Observes real sessions, detects missed skill triggers, grades execution quality, and evolves skill descriptions toward the language real users actually use.

**Stack:** TypeScript on Bun, JSONL log schema, zero runtime dependencies.

## Project Structure

```
selftune/
├── cli/selftune/            # TypeScript package — the CLI
│   ├── types.ts             # Shared interfaces
│   ├── constants.ts         # Log paths, known tools, skip prefixes
│   ├── utils/               # Shared utilities
│   │   ├── jsonl.ts         # JSONL read/write/append
│   │   ├── transcript.ts    # Transcript parsing
│   │   ├── logging.ts       # Structured JSON logging
│   │   ├── seeded-random.ts # Deterministic PRNG
│   │   ├── llm-call.ts      # Shared LLM call utility
│   │   └── schema-validator.ts # JSONL schema validation
│   ├── hooks/               # Telemetry capture (Claude Code hooks)
│   │   ├── prompt-log.ts    # UserPromptSubmit hook
│   │   ├── session-stop.ts  # Stop hook
│   │   └── skill-eval.ts    # PostToolUse hook
│   ├── ingestors/           # Platform adapters (Codex, OpenCode)
│   │   ├── codex-wrapper.ts # Real-time Codex wrapper
│   │   ├── codex-rollout.ts # Batch Codex ingestor
│   │   └── opencode-ingest.ts # OpenCode SQLite/JSON adapter
│   ├── eval/                # False negative detection, eval set generation
│   │   └── hooks-to-evals.ts
│   ├── grading/             # 3-tier session grading
│   │   └── grade-session.ts
│   ├── evolution/           # Skill description evolution (v0.3)
│   │   ├── extract-patterns.ts   # Failure pattern extractor
│   │   ├── propose-description.ts # Description proposal generator
│   │   ├── validate-proposal.ts   # Proposal validator
│   │   ├── audit.ts              # Evolution audit trail
│   │   ├── evolve.ts             # Orchestrator + CLI
│   │   ├── deploy-proposal.ts    # SKILL.md writer + deploy
│   │   ├── rollback.ts           # Rollback mechanism
│   │   └── stopping-criteria.ts  # Stopping criteria evaluator
│   ├── monitoring/          # Post-deploy monitoring (v0.4)
│   │   └── watch.ts
│   ├── observability.ts     # Health checks, log integrity
│   └── index.ts             # CLI entry point
├── skill/                   # Claude Code skill (skill-eval-grader)
│   ├── SKILL.md             # Skill definition
│   ├── settings_snippet.json
│   └── references/
├── tests/                   # Test suite (bun test)
├── docs/                    # Reins harness docs
└── [root configs]           # package.json, tsconfig.json, Makefile, CI, etc.
```

## Architecture

See ARCHITECTURE.md for domain map, module layering, and dependency rules.

## Documentation Map

| Topic | Location | Status |
|-------|----------|--------|
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
| References | docs/references/ | Current |

## Key Files

| File | Purpose |
|------|---------|
| `cli/selftune/hooks/prompt-log.ts` | Claude Code UserPromptSubmit hook — logs queries |
| `cli/selftune/hooks/session-stop.ts` | Claude Code Stop hook — captures session telemetry |
| `cli/selftune/hooks/skill-eval.ts` | Claude Code PostToolUse hook — tracks skill triggers |
| `cli/selftune/ingestors/codex-wrapper.ts` | Codex real-time wrapper — tees JSONL stream |
| `cli/selftune/ingestors/codex-rollout.ts` | Codex batch ingestor — reads rollout session files |
| `cli/selftune/ingestors/opencode-ingest.ts` | OpenCode adapter — reads SQLite database |
| `cli/selftune/eval/hooks-to-evals.ts` | False negative detection — generates eval sets from logs |
| `cli/selftune/grading/grade-session.ts` | Session grader — 3-tier eval (trigger/process/quality) |
| `cli/selftune/evolution/evolve.ts` | Evolution orchestrator — coordinates the full improvement loop |
| `cli/selftune/evolution/deploy-proposal.ts` | SKILL.md writer and deploy/PR generator |
| `cli/selftune/evolution/rollback.ts` | Rollback to pre-evolution SKILL.md |
| `cli/selftune/monitoring/watch.ts` | Post-deploy regression monitoring |
| `cli/selftune/utils/llm-call.ts` | Shared LLM call utility (agent/API) |

## Development Workflow

1. Receive task via prompt
2. Read this file, then follow pointers to relevant docs
3. Read PRD.md for product context and the feedback loop model
4. Implement changes following ARCHITECTURE.md layer rules
5. Run `make check` (lint + test) or `bun test`
6. Verify JSONL output schema matches appendix in PRD.md
7. Self-review: check log schema compatibility across all three platforms
8. Open PR with concise summary

## Key Constraints

- All three platform adapters (Claude Code, Codex, OpenCode) write to the same shared log schema
- Grading uses the user's existing agent subscription — no separate API key
- Hooks must be zero-config after installation
- Log files are append-only JSONL at `~/.claude/`
- Evolution proposals require validation against eval set before deploy
- All knowledge lives in-repo, not in external tools
- Zero runtime dependencies — uses only Bun built-ins

## Golden Principles

See docs/golden-principles.md for the full set of mechanical taste rules.
