# selftune — Skill Observability & Continuous Improvement CLI

Observe real sessions, detect missed triggers, grade execution quality, and automatically evolve skill descriptions toward the language real users actually use.

Works with **Claude Code**, **Codex**, and **OpenCode**.

```
Observe → Detect → Diagnose → Propose → Validate → Deploy → Watch → Repeat
```

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

---

## Installation

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Install dependencies

```bash
bun install
```

### 3. Register hooks (Claude Code)

Edit `~/.claude/settings.json`. Merge the entries below — don't replace the whole `hooks` block if you already have one.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run /PATH/TO/cli/selftune/hooks/prompt-log.ts",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "bun run /PATH/TO/cli/selftune/hooks/skill-eval.ts",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run /PATH/TO/cli/selftune/hooks/session-stop.ts",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

Replace `/PATH/TO/` with the absolute path to this repository.

### 4. Verify hooks are running

Start a Claude Code session, send a message, then check:

```bash
cat ~/.claude/all_queries_log.jsonl      # every query
cat ~/.claude/skill_usage_log.jsonl      # skill trigger events
cat ~/.claude/session_telemetry_log.jsonl # session metrics (after session ends)
```

### 5. For Codex / OpenCode users

No hooks needed — use the ingestors instead:

```bash
# Codex: real-time wrapper (drop-in replacement for codex exec)
bun run cli/selftune/index.ts wrap-codex -- <your codex args>

# Codex: batch ingest from rollout logs
bun run cli/selftune/index.ts ingest-codex

# OpenCode: ingest from SQLite database
bun run cli/selftune/index.ts ingest-opencode
```

All three platforms write to the same shared JSONL log schema at `~/.claude/`.

---

## Commands

```
selftune <command> [options]
```

### Observe & Detect

| Command | Purpose |
|---|---|
| `evals --list-skills` | Show logged skills and query counts |
| `evals --skill <name>` | Generate eval set from real usage logs |
| `evals --skill <name> --stats` | Show telemetry stats for a skill |
| `doctor` | Health checks on logs, hooks, and schema |

### Grade

| Command | Purpose |
|---|---|
| `grade --skill <name> --expectations "..."` | Grade a session against explicit expectations |
| `grade --skill <name> --evals-json <path> --eval-id <n>` | Grade using a pre-built eval set |

Grading uses a 3-tier model:
- **Tier 1 — Trigger:** Did the skill fire at all?
- **Tier 2 — Process:** Given it fired, did it follow the right steps?
- **Tier 3 — Quality:** Was the output actually good?

No separate API key required — grading uses whatever agent you already have installed (`claude`, `codex`, or `opencode`). Set `ANTHROPIC_API_KEY` to use the API directly instead.

### Evolve (v0.3)

| Command | Purpose |
|---|---|
| `evolve --skill <name> --skill-path <path>` | Analyze failures, propose improved description, validate, deploy |
| `evolve --skill <name> --skill-path <path> --dry-run` | Propose and validate without deploying |
| `rollback --skill <name> --skill-path <path>` | Restore pre-evolution description |

The evolution loop:
1. Extracts failure patterns from eval set + grading results
2. Generates a candidate description that would catch missed queries
3. Validates the candidate against the eval set (must improve pass rate with <5% regressions)
4. Deploys the updated SKILL.md with PR and audit trail
5. Retries up to `--max-iterations` times if validation fails

### Watch (v0.4)

| Command | Purpose |
|---|---|
| `watch --skill <name> --skill-path <path>` | Monitor post-evolution pass rates |
| `watch --skill <name> --skill-path <path> --auto-rollback` | Auto-revert on regression |

### Ingest (Codex / OpenCode)

| Command | Purpose |
|---|---|
| `ingest-codex` | Batch ingest Codex rollout logs |
| `ingest-opencode` | Ingest OpenCode sessions from SQLite |
| `wrap-codex` | Real-time Codex wrapper with telemetry |

---

## How It Works

### Telemetry Capture

```
Claude Code (hooks):                    Codex / OpenCode (ingestors):
  UserPromptSubmit → prompt-log.ts        codex-wrapper.ts (real-time)
  PostToolUse      → skill-eval.ts        codex-rollout.ts (batch)
  Stop             → session-stop.ts      opencode-ingest.ts (SQLite)
          │                                        │
          └──────────┬─────────────────────────────┘
                     ▼
          Shared JSONL Log Schema (~/.claude/)
            ├── all_queries_log.jsonl
            ├── skill_usage_log.jsonl
            └── session_telemetry_log.jsonl
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
├── types.ts, constants.ts       Shared interfaces and constants
├── utils/                       JSONL, transcript parsing, LLM calls, schema validation
├── hooks/                       Claude Code telemetry capture (3 hooks)
├── ingestors/                   Codex + OpenCode adapters (3 ingestors)
├── eval/                        False negative detection, eval set generation
├── grading/                     3-tier session grading (agent or API mode)
├── evolution/                   v0.3: failure extraction, proposal, validation, deploy, rollback
└── monitoring/                  v0.4: post-deploy regression detection
```

Dependencies flow forward only: `shared → hooks/ingestors → eval → grading → evolution → monitoring`. Enforced by `lint-architecture.ts`.

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

The `source` field identifies the platform: `claude_code`, `codex`, or `opencode`.

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

- Let logs accumulate over several days before running evals — more diverse real queries = more reliable signal.
- All hooks are silent (exit 0) and take <50ms. Negligible overhead.
- Logs are append-only JSONL. Safe to delete to start fresh, or archive old files.
- Use `--max 75` to increase eval set size once you have enough data.
- Use `--seed 123` for a different random sample of negatives.
- Use `--dry-run` with `evolve` to preview proposals without deploying.
- The `doctor` command checks log health, hook presence, and schema validity.

---

## Milestones

| Version | Scope | Status |
|---|---|---|
| v0.1 | Hooks, ingestors, shared schema, eval generation | Done |
| v0.2 | Session grading, grader skill | Done |
| v0.3 | Evolution loop (propose, validate, deploy, rollback) | Done |
| v0.4 | Post-deploy monitoring, regression detection | Done |
