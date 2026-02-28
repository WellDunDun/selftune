# Architecture — selftune

## Domain Map

| Domain | Directory | Description | Quality Grade |
|--------|-----------|-------------|---------------|
| Telemetry | `cli/selftune/hooks/` | Session capture hooks and log writers | B |
| Ingestors | `cli/selftune/ingestors/` | Platform adapters (Claude Code, Codex, OpenCode) | B |
| Eval | `cli/selftune/eval/` | False negative detection and eval set generation | C |
| Grading | `cli/selftune/grading/` | 3-tier session grading (trigger/process/quality) | C |
| Evolution | (v0.3 — not yet implemented) | Description improvement loop and PR generation | — |
| Skill | `skill/` | Claude Code grader skill | B |

## The Feedback Loop

```
Observe → Detect → Diagnose → Propose → Validate → Deploy → Watch → Repeat
```

Telemetry feeds Ingestors, Ingestors feed Eval, Eval feeds Grading, Grading feeds Evolution.

## Module Architecture

Dependencies flow forward only through the pipeline.

```
cli/selftune/
├── hooks/           Telemetry (capture)
│     │
│     v
├── ingestors/       Platform adapters (normalize)
│     │
│     v
│   Shared Log Schema (~/.claude/*.jsonl)
│     │
│     v
├── eval/            False negative detection (analyze)
│     │
│     v
├── grading/         Session grading (assess)
│     │
│     v
└── (evolution/)     Description improvement (propose) [v0.3]

skill/               Claude Code skill (user-facing grader)
```

### Module Definitions

| Module | Directory | Files | Responsibility | May Import From |
|--------|-----------|-------|---------------|-----------------|
| Telemetry | `cli/selftune/hooks/` | `prompt_log_hook.py`, `session_stop_hook.py`, `skill_eval_hook.py` | Capture session data via hooks | Standard library only |
| Ingestors | `cli/selftune/ingestors/` | `codex_wrapper.py`, `codex_rollout_ingest.py`, `opencode_ingest.py` | Normalize platform data | Telemetry (schema only) |
| Eval | `cli/selftune/eval/` | `hooks_to_evals.py` | Detect false negatives, generate eval sets | Shared log schema |
| Grading | `cli/selftune/grading/` | `grade_session.py` | Grade sessions across 3 tiers | Eval, Shared log schema |
| Evolution | (TBD) | (v0.3) | Propose and validate description improvements | Grading, Eval |
| Skill | `skill/` | `SKILL.md`, `settings_snippet.json` | User-facing grader skill | Reads log schema |

### Enforcement

These rules are enforced mechanically:
- [x] Import direction lint: hooks must not import from grading/eval (`lint_architecture.py`)
- [ ] Schema validation: all JSONL writers validate against shared schema (TODO)
- [x] CI gate: `make check` must pass before merge (`.github/workflows/ci.yml`)

## Log Schema (Shared Interface)

All modules communicate through three JSONL files:

| File | Writer | Reader |
|------|--------|--------|
| `~/.claude/session_telemetry_log.jsonl` | Telemetry, Ingestors | Eval, Grading |
| `~/.claude/skill_usage_log.jsonl` | Telemetry | Eval |
| `~/.claude/all_queries_log.jsonl` | Telemetry, Ingestors | Eval |

## Three-Tier Evaluation Model

| Tier | What It Checks | Automated |
|------|---------------|-----------|
| Tier 1 — Trigger | Did the skill fire at all? | Yes |
| Tier 2 — Process | Did it follow the right steps? | Yes |
| Tier 3 — Quality | Was the output actually good? | Yes (agent-as-grader) |

## Invocation Taxonomy

| Type | Description |
|------|-------------|
| Explicit | Names the skill directly |
| Implicit | Describes the task without naming the skill |
| Contextual | Implicit with domain noise |
| Negative | Adjacent queries that should NOT trigger |
