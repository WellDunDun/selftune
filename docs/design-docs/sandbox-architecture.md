<!-- Verified: 2026-03-02 -->

# Design Document: Sandbox Architecture

**Status:** Implemented
**Date:** 2026-03-01
**Updated:** 2026-03-02
**Authors:** Daniel Petro

## Problem

selftune had 499 unit tests covering individual functions, but zero integration tests exercising the full CLI pipeline. This meant:

- CLI commands were never tested against realistic multi-skill, multi-session data
- Hooks were never tested with actual stdin payloads
- LLM-dependent commands (grade, evolve) had no testing path
- Regressions in command routing, argument parsing, or file I/O went undetected

## Solution: Two-Layer Sandbox Architecture

### Layer 1: Local Sandbox (tests/sandbox/run-sandbox.ts)

**Purpose:** Test all non-LLM CLI commands and hooks in an isolated environment.

**Mechanism:** Sets `HOME` env var to a temp directory when spawning CLI subprocesses. Since all paths in `constants.ts` use `homedir()`, this redirects all file I/O to the sandbox.

**Performance:** ~400ms per agent's test suite.

### Layer 2: Docker Containers (tests/sandbox/<agent>/)

**Purpose:** Test LLM-dependent commands with real LLM calls in isolated containers.

**Mechanism:** Per-agent Docker containers with the agent's CLI installed. Uses existing agent subscription — no separate API key needed.

**Cost:** Uses existing agent subscription — no per-call API charges.

## Fixture Design Philosophy

Fixtures are organized into shared and per-agent directories:

```text
tests/sandbox/fixtures/
├── shared/          # Agent-agnostic (JSONL logs, skill definitions)
├── claude-code/     # Claude Code config, transcripts, hook payloads, settings
├── codex/           # Codex config, rollout sessions
└── opencode/        # OpenCode config, opencode.db
```

Three skills with deliberately different health profiles provide test coverage:

| Skill | Profile | Trigger Rate | Purpose |
|-------|---------|-------------|---------|
| `find-skills` | Healthy | 6/30 queries (20%) | Tests normal operation, deployed evolution |
| `frontend-design` | Sick | 0/30 queries (0%) | Tests undertrigger detection, evolution candidate |
| `ai-image-generation` | New | 1/30 queries (3%) | Tests minimal data handling |

**Data volume:** 15 sessions, 30 queries, 7 skill usage records, 3 evolution audit entries.

## Key Design Decisions

### 1. HOME Env Var Redirection
All selftune paths go through `homedir()` in `constants.ts`. Setting `HOME=/tmp/sandbox-*` redirects everything without modifying production code.

### 2. Two-Layer Architecture
- Layer 1 is free, fast (~400ms), and runs in CI
- Layer 2 costs tokens and requires Docker, reserved for pre-release validation
- Both share the same fixture data

### 3. Result Recording
Every test run saves a JSON report to `tests/sandbox/results/` with command, exit code, stdout, stderr, duration, and pass/fail. This creates a historical record of sandbox health.

## Makefile Targets

```bash
# Layer 1 (local, free, fast)
make sandbox                # Claude Code (default, backward-compatible)
make sandbox-codex          # Codex
make sandbox-opencode       # OpenCode
make sandbox-all            # All agents in sequence

# Layer 2 (Docker, LLM calls)
make sandbox-llm            # Claude Code (default)
make sandbox-llm-codex      # Codex
make sandbox-llm-opencode   # OpenCode

# Utility
make sandbox-shell          # Claude Code container
make sandbox-shell-codex    # Codex container
```

## Per-Agent Design Docs

| Agent | Design Doc | Status |
|-------|-----------|--------|
| Claude Code | [sandbox-claude-code.md](sandbox-claude-code.md) | Implemented |
| Codex | sandbox-codex.md | Planned |
| OpenCode | sandbox-opencode.md | Planned |

## Future Work

- CI integration: Run Layer 1 on every PR, Layer 2 on release branches
- Fixture expansion with codex and opencode skill profiles
- Per-agent design docs after sandbox implementation
