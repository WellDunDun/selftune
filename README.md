[![CI](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml)
[![CodeQL](https://github.com/WellDunDun/selftune/actions/workflows/codeql.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/WellDunDun/selftune/badge)](https://securityscorecards.dev/viewer/?uri=github.com/WellDunDun/selftune)
[![npm version](https://img.shields.io/npm/v/selftune)](https://www.npmjs.com/package/selftune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/selftune?activeTab=dependencies)
[![Bun](https://img.shields.io/badge/runtime-bun%20%7C%20node-black)](https://bun.sh)

# selftune — Skill Observability & Continuous Improvement CLI

Observe real sessions, detect missed triggers, grade execution quality, and automatically evolve skill descriptions toward the language real users actually use.

Works with **Claude Code**, **Codex**, and **OpenCode**.

```
Observe → Detect → Diagnose → Propose → Validate → Deploy → Watch → Repeat
```

---

## Install

```bash
npx selftune@latest doctor
```

Or install globally:

```bash
npm install -g selftune
selftune doctor
```

Requires [Bun](https://bun.sh) or Node.js 18+ with [tsx](https://github.com/privatenumber/tsx).

---

## Why

Agent skills are static, but users are not. When a skill undertriggers — when someone says "make me a slide deck" and the pptx skill doesn't fire — that failure is invisible. The user concludes "AI doesn't follow directions" rather than recognizing the skill description doesn't match how real people talk.

selftune closes this feedback loop.

---

## What It Does

| Capability | Description |
|---|---|
| **Session telemetry** | Captures per-session process metrics across all three platforms |
| **False negative detection** | Surfaces queries where a skill should have fired but didn't |
| **Eval set generation** | Converts hook logs into trigger eval sets with real usage as ground truth |
| **Session grading** | 3-tier evaluation (Trigger / Process / Quality) using the agent you already have |
| **Skill evolution** | Proposes improved descriptions, validates them, deploys with audit trail |
| **Post-deploy monitoring** | Watches evolved skills for regressions, auto-rollback on pass rate drops |
| **Retroactive replay** | Backfills JSONL logs from existing Claude Code session transcripts |
| **Community contribution** | Opt-in export of anonymized observability data for cross-developer signal pooling |

---

## Setup

### 1. Add the skill

```bash
npx skills add WellDunDun/selftune
```

### 2. Initialize

Tell your agent: **"initialize selftune"**

The agent will install the CLI (`npm install -g selftune`) if needed, run `selftune init` to bootstrap config, install hooks, and verify with `selftune doctor`.

---

## Development

For contributors running from source.

### 1. Initialize

```bash
npx selftune@latest init
```

The `init` command auto-detects your agent environment (Claude Code, Codex, or OpenCode), resolves the CLI path, determines the LLM mode, and writes config to `~/.selftune/config.json`. All subsequent commands read from this config.

Use `--agent claude_code|codex|opencode` to override detection, `--llm-mode agent|api` to override LLM mode, or `--force` to reinitialize.

### 4. Install hooks (Claude Code)

If `init` reports hooks are not installed, merge the entries from `skill/settings_snippet.json` into `~/.claude/settings.json`. Derive hook script paths from the `cli_path` field in `~/.selftune/config.json` — the hooks directory is at `dirname(cli_path)/hooks/`.

### 5. Verify setup

```bash
selftune doctor
```

Doctor checks log file health, hook installation, schema validity, and config status.

### Platform-Specific Notes

**Claude Code** — Hooks capture telemetry automatically after installation. Zero configuration once hooks are in `settings.json`. Use `selftune replay` to backfill logs from existing transcripts in `~/.claude/projects/`.

**Codex** — Use the wrapper for real-time capture or the batch ingestor for historical logs:
```bash
selftune wrap-codex -- <your codex args>
selftune ingest-codex
```

**OpenCode** — Backfill historical sessions from SQLite:
```bash
selftune ingest-opencode
```

All platforms write to the same shared JSONL log schema at `~/.claude/`.

---

## Commands

```
selftune <command> [options]
```

| Command | Purpose |
|---|---|
| `init` | Auto-detect agent environment, write `~/.selftune/config.json` |
| `grade --skill <name>` | Grade a session (3-tier: trigger, process, quality) |
| `evals --skill <name>` | Generate eval set from real usage logs |
| `evals --list-skills` | Show logged skills and query counts |
| `evolve --skill <name> --skill-path <path>` | Analyze failures, propose and deploy improved description |
| `rollback --skill <name> --skill-path <path>` | Restore pre-evolution description |
| `watch --skill <name> --skill-path <path>` | Monitor post-deploy pass rates, detect regressions |
| `status` | Show skill health summary (pass rates, trends, missed queries) |
| `last` | Show quick insight from the most recent session |
| `doctor` | Health checks on logs, hooks, config, and schema |
| `dashboard` | Open skill-health-centric HTML dashboard in browser |
| `replay` | Backfill JSONL logs from existing Claude Code transcripts |
| `contribute` | Export anonymized skill observability data for community contribution |
| `ingest-codex` | Batch ingest Codex rollout logs |
| `ingest-opencode` | Backfill historical OpenCode sessions from SQLite |
| `wrap-codex -- <args>` | Real-time Codex wrapper with telemetry |

No separate API key required — grading and evolution use whatever agent CLI you already have installed (Claude Code, Codex, or OpenCode).

See `skill/Workflows/` for detailed step-by-step guides for each command.

---

## How It Works

### Telemetry Capture

```
Claude Code (hooks):                 OpenCode (hooks):
  UserPromptSubmit → prompt-log.ts     message.*        → opencode-prompt-log.ts
  PostToolUse      → skill-eval.ts     tool.execute.after → opencode-skill-eval.ts
  Stop             → session-stop.ts   session.idle     → opencode-session-stop.ts
          │                                    │
          └──────────┬─────────────────────────┘
                     ▼
          Shared JSONL Log Schema (~/.claude/)
            ├── all_queries_log.jsonl
            ├── skill_usage_log.jsonl
            └── session_telemetry_log.jsonl

Claude Code (replay — retroactive backfill):
  claude-replay.ts  (batch ingest from ~/.claude/projects/)
          │
          └──→ Same shared JSONL schema

Codex (wrapper/ingestor — hooks not yet available):
  codex-wrapper.ts  (real-time tee of JSONL stream)
  codex-rollout.ts  (batch ingest from rollout logs)
          │
          └──→ Same shared JSONL schema
```

### Eval & Grading

```
selftune evals cross-references the two query logs:
  Positives  = skill_usage_log entries for target skill
  Negatives  = all_queries_log entries NOT in positives

selftune grade reads:
  session_telemetry_log → process metrics (tool calls, errors, turns)
  transcript JSONL       → what actually happened
  expectations           → what should have happened
```

### Evolution Loop

```
selftune evolve:
  1. Load eval set (or generate from logs)
  2. Extract failure patterns (missed queries grouped by invocation type)
  3. Generate improved description via LLM
  4. Validate against eval set (must improve, <5% regression)
  5. Deploy updated SKILL.md + PR + audit trail

selftune watch:
  Monitor pass rate over sliding window of recent sessions
  Alert (or auto-rollback) on regression > threshold
```

---

## Architecture

```
cli/selftune/
├── index.ts                     CLI entry point (command router)
├── init.ts                      Agent detection, config bootstrap
├── types.ts, constants.ts       Shared interfaces and constants
├── observability.ts             Health checks (doctor command)
├── status.ts                    Skill health summary (status command)
├── last.ts                      Last session insight (last command)
├── dashboard.ts                 HTML dashboard builder (dashboard command)
├── utils/                       JSONL, transcript parsing, LLM calls, schema validation
├── hooks/                       Claude Code + OpenCode telemetry capture
├── ingestors/                   Codex, OpenCode, Claude Code replay adapters
├── contribute/                  Anonymized data export (bundle, sanitize, submit)
├── eval/                        False negative detection, eval set generation
├── grading/                     3-tier session grading (agent or API mode)
├── evolution/                   Failure extraction, proposal, validation, deploy, rollback
└── monitoring/                  Post-deploy regression detection

dashboard/
└── index.html                   Skill-health-centric HTML dashboard template

skill/
├── SKILL.md                     Routing table (~120 lines)
├── settings_snippet.json        Claude Code hook config template
├── references/                  Domain knowledge (logs, grading methodology, taxonomy)
└── Workflows/                   Step-by-step guides (1 per command)
```

Dependencies flow forward only: `shared → hooks/ingestors → eval → grading → evolution → monitoring → contribute`. Enforced by `lint-architecture.ts`.

Config persists at `~/.selftune/config.json` (written by `init`, read by all commands via skill workflows).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full domain map and module rules.

---

## Log Schema

Three append-only JSONL files at `~/.claude/`:

| File | Record type | Key fields |
|---|---|---|
| `all_queries_log.jsonl` | `QueryLogRecord` | `timestamp`, `session_id`, `query`, `source?` |
| `skill_usage_log.jsonl` | `SkillUsageRecord` | `timestamp`, `session_id`, `skill_name`, `query`, `triggered` |
| `session_telemetry_log.jsonl` | `SessionTelemetryRecord` | `timestamp`, `session_id`, `tool_calls`, `bash_commands`, `skills_triggered`, `errors_encountered` |
| `evolution_audit_log.jsonl` | `EvolutionAuditEntry` | `timestamp`, `proposal_id`, `action`, `details`, `eval_snapshot?` |

The `source` field identifies the platform: `claude_code`, `claude_code_replay`, `codex`, `opencode`, or `opencode_json`.

---

## Development

```bash
make check    # lint + architecture lint + all tests
make lint     # biome check + architecture lint
make test     # bun test
```

Zero runtime dependencies. Uses Bun built-ins only.

---

## Tips

- Run `selftune init` first — everything else reads from the config it writes.
- Let logs accumulate over several days before running evals — more diverse real queries = more reliable signal.
- All hooks are silent (exit 0) and take <50ms. Negligible overhead.
- Logs are append-only JSONL. Safe to delete to start fresh, or archive old files.
- Use `--max 75` to increase eval set size once you have enough data.
- Use `--seed 123` for a different random sample of negatives.
- Use `--dry-run` with `evolve` to preview proposals without deploying.
- The `doctor` command checks log health, hook presence, config status, and schema validity.
- Run `selftune replay` to backfill logs from existing Claude Code sessions before running evals.
- Use `selftune contribute --preview` to inspect what data would be exported before submitting.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture rules, and PR guidelines.

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## Sponsor

If selftune saves you time, consider [sponsoring the project](https://github.com/sponsors/WellDunDun).

---

## Milestones

| Version | Scope | Status |
|---|---|---|
| v0.1 | Hooks, ingestors, shared schema, eval generation | Done |
| v0.2 | Session grading, grader skill | Done |
| v0.3 | Evolution loop (propose, validate, deploy, rollback) | Done |
| v0.4 | Post-deploy monitoring, regression detection | Done |
| v0.5 | Agent-first skill restructure, `init` command, config bootstrap | Done |
| v0.6 | Three-layer observability: `status`, `last`, redesigned dashboard | Done |
| v0.7 | Retroactive replay + community contribution export | Done |
