# AGENTS.md

## Repository Overview

selftune — Skill observability and continuous improvement for Claude Code, Codex, and OpenCode. Observes real sessions, detects missed skill triggers, grades execution quality, and evolves skill descriptions toward the language real users actually use.

**Stack:** Python 3.12, JSONL log schema, no external dependencies beyond standard library.

## Project Structure

```
selftune/
├── cli/selftune/            # Python package — the CLI
│   ├── hooks/               # Telemetry capture (Claude Code hooks)
│   ├── ingestors/           # Platform adapters (Codex, OpenCode)
│   ├── eval/                # False negative detection, eval set generation
│   ├── grading/             # 3-tier session grading
│   ├── observability.py     # Health checks, log integrity
│   └── logging_config.py    # Structured JSON logging
├── skill/                   # Claude Code skill (skill-eval-grader)
│   ├── SKILL.md             # Skill definition
│   ├── settings_snippet.json
│   └── references/
├── tests/                   # Test suite
├── docs/                    # Reins harness docs
└── [root configs]           # pyproject.toml, Makefile, CI, etc.
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
| `cli/selftune/hooks/prompt_log_hook.py` | Claude Code UserPromptSubmit hook — logs queries |
| `cli/selftune/hooks/session_stop_hook.py` | Claude Code Stop hook — captures session telemetry |
| `cli/selftune/hooks/skill_eval_hook.py` | Claude Code PostToolUse hook — tracks skill triggers |
| `cli/selftune/ingestors/codex_wrapper.py` | Codex real-time wrapper — tees JSONL stream |
| `cli/selftune/ingestors/codex_rollout_ingest.py` | Codex batch ingestor — reads rollout session files |
| `cli/selftune/ingestors/opencode_ingest.py` | OpenCode adapter — reads SQLite database |
| `cli/selftune/eval/hooks_to_evals.py` | False negative detection — generates eval sets from logs |
| `cli/selftune/grading/grade_session.py` | Session grader — 3-tier eval (trigger/process/quality) |

## Development Workflow

1. Receive task via prompt
2. Read this file, then follow pointers to relevant docs
3. Read PRD.md for product context and the feedback loop model
4. Implement changes following ARCHITECTURE.md layer rules
5. Run `make check` (lint + test) or `python3 -m pytest tests/`
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

## Golden Principles

See docs/golden-principles.md for the full set of mechanical taste rules.
