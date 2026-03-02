<!-- Verified: 2026-03-02 -->

# Design Document: Claude Code Sandbox

**Status:** Implemented
**Date:** 2026-03-01
**Updated:** 2026-03-02
**Authors:** Daniel Petro
**Parent:** [Sandbox Architecture](sandbox-architecture.md)

## Overview

Claude Code-specific sandbox configuration, tests, and Docker container. See [sandbox-architecture.md](sandbox-architecture.md) for the shared two-layer architecture, HOME redirection trick, and fixture philosophy.

## Layer 1: Local Tests

**What it tests:**

| Command | Expected Behavior |
|---------|-------------------|
| `doctor` | Config + logs validated, hooks detected in settings.json |
| `evals --skill find-skills` | 6 positives, 24 negatives generated |
| `evals --skill frontend-design` | 0 positives (correctly identifies undertriggering) |
| `status` | Colored table with per-skill health |
| `last` | Latest session insight with unmatched queries |
| `dashboard --export` | Standalone HTML with embedded data |
| `contribute --preview` | Sanitized contribution bundle |
| Hook: prompt-log | Record appended to all_queries_log.jsonl |
| Hook: skill-eval | Record appended to skill_usage_log.jsonl |
| Hook: session-stop | Record appended to session_telemetry_log.jsonl |

**Performance:** 10 tests in ~400ms.

## Layer 2: Devcontainer + `claude -p`

**Location:** `tests/sandbox/docker/` (Docker files)

**Mechanism:** Uses `claude -p --dangerously-skip-permissions` via the official Claude Code devcontainer. Extends the [official Claude Code devcontainer reference](https://code.claude.com/docs/en/devcontainer) with Bun runtime and sandbox HOME. Production code is unchanged and maintains zero dependencies.

**What it tests:**

| Command | Expected Behavior |
|---------|-------------------|
| `grade --skill find-skills` | LLM evaluates session against expectations |
| `evolve --skill frontend-design --dry-run` | LLM proposes improved description |
| `watch --skill find-skills` | Monitoring snapshot computed (no regression for healthy skill) |

### Test 1: Grade (`find-skills`, session-001)

Runs `selftune grade --skill find-skills --session-id session-001` which calls `claude -p` (real LLM call) to evaluate whether session-001 met two expectations:

1. "Skill was triggered"
2. "User query was about finding skills"

The LLM reads the session telemetry, sees that `find-skills` fired and `npx skills add brightdata/skills` was run, and grades each expectation with evidence. This is the **only test that uses LLM tokens** (~56 seconds). The grading output includes structured claims, evidence, and eval feedback suggesting improvements to the expectation set.

### Test 2: Evolve (`frontend-design`, dry-run)

Runs `selftune evolve --skill frontend-design --dry-run`. This is the "sick" skill — it has zero triggers across all 30 queries. Queries like "I need to make my website look better" and "improve the visual hierarchy of my landing page" should trigger it but don't.

The evolve pipeline runs but returns `"reason": "No failure patterns found"` because it needs graded sessions (not just missing triggers) to identify failure patterns. **No SKILL.md is modified** — `--dry-run` prevents deployment even if a proposal were generated. No LLM call is made (~70ms).

### Test 3: Watch (`find-skills`, no LLM)

Runs `selftune watch --skill find-skills` — pure computation, no LLM. Computes a monitoring snapshot from the fixture data:

- **pass_rate:** 0.2 (6 triggers out of 30 total queries)
- **baseline_pass_rate:** 0.5 (from evolution audit log)
- **regression_detected:** true (0.20 is below 0.50 minus the 0.10 threshold)
- Recommends `selftune rollback --skill "find-skills"`

This correctly detects the regression scenario encoded in the fixture data (~30ms).

### What the tests validate

| Concern | How it's validated |
|---------|-------------------|
| LLM integration | `grade` calls `claude -p`, parses response, produces structured output |
| CLI argument parsing | All commands receive correct flags and produce valid JSON |
| File I/O in sandbox | Commands read from and write to the sandboxed HOME directory |
| Evolution pipeline | `evolve` reads skill files, analyzes logs, returns valid result |
| Monitoring math | `watch` computes pass rates and detects regressions from log data |

### What the tests don't cover

| Gap | Why |
|-----|-----|
| All 3 skills graded | Only `find-skills` session-001 is graded (cost control) |
| Actual skill rewriting | `evolve --dry-run` never modifies SKILL.md |
| Rollback after regression | `watch` detects regression but doesn't test `rollback` |
| Multi-session grading | Only 1 of 15 sessions is graded |
| `ai-image-generation` in Layer 2 | Only exercised in Layer 1 via `evals` |

These are candidates for future test expansion.

## Running

```bash
# Layer 1: Local (free, fast)
make sandbox

# Layer 2: First-time auth setup (one-time)
make sandbox-shell       # drop into container
claude login             # paste token, then exit

# Layer 2: Run LLM tests (auth persists in Docker volume)
make sandbox-llm

# Interactive container access
make sandbox-shell

# Full check: lint + unit tests + sandbox
make check
```

**Auth options:** `claude login` inside the container (persists in Docker volume), `ANTHROPIC_API_KEY` in `.env.local`, or VS Code devcontainer.

## Future Work

- Add `replay` command testing with simulated `~/.claude/projects/` transcripts
- Add `init` command testing with mocked `Bun.which()` for agent detection
