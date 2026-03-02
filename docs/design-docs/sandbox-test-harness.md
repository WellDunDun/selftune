# Design Document: Sandbox Test Harness

**Status:** Implemented
**Date:** 2026-03-01
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

### Layer 2: Devcontainer + `claude -p` (tests/sandbox/docker/)

**Purpose:** Test LLM-dependent commands with real LLM calls.

**Mechanism:** Uses `claude -p --dangerously-skip-permissions` via the official Claude Code devcontainer. Uses existing Claude subscription — no API key needed.

**What it tests:**
| Command | Expected Behavior |
|---------|-------------------|
| `grade --skill find-skills` | LLM evaluates session against expectations |
| `evolve --skill frontend-design --dry-run` | LLM proposes improved description |
| `watch --skill find-skills` | Monitoring snapshot computed (no regression for healthy skill) |

**Cost:** Uses existing Claude subscription — no per-call API charges.

## Fixture Design

Three skills with deliberately different health profiles:

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

### 3. Devcontainer-Based Isolation
Extends the official Claude Code devcontainer reference with firewall, Bun runtime, and sandbox HOME. Production code is unchanged and maintains zero dependencies.

### 4. Result Recording
Every test run saves a JSON report to `tests/sandbox/results/` with command, exit code, stdout, stderr, duration, and pass/fail. This creates a historical record of sandbox health.

## Running

```bash
# Layer 1: Local (free, fast)
make sandbox

# Layer 2: Devcontainer + LLM (uses existing Claude subscription)
make sandbox-llm

# Full check: lint + unit tests + sandbox
make check
```

### Layer 1: OpenClaw Sandbox Tests

**Added to** `tests/sandbox/run-sandbox.ts`:

| Test Name | Command | Verification |
|-----------|---------|-------------|
| `ingest-openclaw` | `ingest-openclaw --agents-dir <sandbox>` | Exit 0 + openclaw records in logs |
| `ingest-openclaw --dry-run` | `ingest-openclaw --agents-dir <sandbox> --dry-run` | Exit 0 + no new log records |
| `ingest-openclaw (idempotent)` | Run ingest twice | Second run: "0 not yet ingested" |
| `cron list` | `cron list` | Exit 0 + shows selftune-ingest |
| `cron setup --dry-run` | `cron setup --dry-run --tz UTC` | Exit 0 + shows [DRY RUN] |

**Fixtures:** 5 sessions across 2 agents, 2 skills (Deploy, CodeReview), cron jobs.

### Layer 2: OpenClaw Docker Integration

**Purpose:** Test selftune against a real OpenClaw gateway in Docker.

**Architecture:**
- `openclaw-gateway` service: Real OpenClaw gateway with health check
- `selftune-openclaw` service: Runs test orchestrator after gateway is healthy
- Named Docker volumes persist data across container restarts

**Tests:**

| Test Name | What It Does | Verification |
|-----------|-------------|-------------|
| `gateway-health` | Curl gateway /healthz | HTTP 200 |
| `ingest-openclaw` | Run ingestion against gateway data | Exit 0 + log records |
| `cron setup --dry-run` | Register cron jobs (dry-run) | Exit 0 + dry-run output |
| `cron list` | List registered jobs | Exit 0 + shows jobs |
| `status` | Show skill health post-ingestion | Exit 0 + output |
| `doctor` | Run health checks | JSON with checks array |

**Persistence:**

| What | Volume | Persists? |
|------|--------|-----------|
| OpenClaw gateway data | `openclaw-config` | Yes |
| Selftune log data | `selftune-data` | Yes |
| Selftune config/markers | `selftune-config` | Yes |
| Test result reports | `selftune-results` | Yes |

**Running:**

```bash
# Build and run OpenClaw Docker tests
make sandbox-openclaw

# Run with data preservation for inspection
make sandbox-openclaw-keep

# Clean up all volumes
make sandbox-openclaw-clean
```

## Future Work

- Add `replay` command testing with simulated `~/.claude/projects/` transcripts
- Add `init` command testing with mocked `Bun.which()` for agent detection
- CI integration: Run Layer 1 on every PR, Layer 2 on release branches
- Fixture expansion: Add codex and opencode skill profiles
