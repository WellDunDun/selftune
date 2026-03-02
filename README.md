[![CI](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml)
[![CodeQL](https://github.com/WellDunDun/selftune/actions/workflows/codeql.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/WellDunDun/selftune/badge)](https://securityscorecards.dev/viewer/?uri=github.com/WellDunDun/selftune)
[![npm version](https://img.shields.io/npm/v/selftune)](https://www.npmjs.com/package/selftune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/selftune?activeTab=dependencies)
[![Bun](https://img.shields.io/badge/runtime-bun%20%7C%20node-black)](https://bun.sh)

# selftune

**Agent skills fail silently. selftune makes them self-correcting.**

Your skills trigger about half the time. A user says "make me a slide deck" and the pptx skill doesn't fire. No error. No log. The user blames the AI. You never find out.

This isn't a prompt engineering problem — it's a feedback loop problem. Skill descriptions are written once based on what developers *think* users will say, then never updated based on what users *actually* say.

selftune closes this loop. It observes real sessions, detects missed triggers, and evolves skill descriptions using your actual usage data — not vibes.

Works with **Claude Code**, **Codex**, **OpenCode**, and **OpenClaw**. Zero runtime dependencies.

---

## Quick Start

### 1. Add the skill

```bash
npx skills add WellDunDun/selftune
```

### 2. Initialize

Tell your agent: **"initialize selftune"**

The agent installs the CLI if needed, runs `selftune init` to bootstrap config, installs hooks, and verifies with `selftune doctor`.

### 3. See your data

Tell your agent: **"replay my sessions and open the dashboard"**

This backfills logs from your existing transcripts and opens the skill-health dashboard — you'll see which skills are undertriggering within minutes of installing.

### Platform Notes

**Claude Code** — `selftune replay` backfills from existing transcripts in `~/.claude/projects/`. Hooks capture new sessions automatically after init.

**Codex** — Use the wrapper or batch ingestor:
```bash
selftune wrap-codex -- <your codex args>
selftune ingest-codex
```

**OpenCode** — Backfill from SQLite:
```bash
selftune ingest-opencode
```

**OpenClaw** — Backfill from session transcripts and set up autonomous cron:

```bash
selftune ingest-openclaw
selftune cron setup    # Register autonomous evolution cron jobs
```

Requires [Bun](https://bun.sh) or Node.js 18+. No extra API keys — selftune uses your existing Claude Code, Codex, or OpenCode subscription for grading and evolution.

---

## The Problem

270,000+ agent skills exist across marketplaces. Most are unreliable because:

- **Skill descriptions don't match how people actually talk.** You wrote "generate PowerPoint presentation." Users say "make me some slides."
- **Missed triggers are invisible.** When a skill *doesn't* fire, there's no error, no log, no signal. You only know if someone complains.
- **Current fixes are workarounds.** Directive language hacks, forced-loading hooks, prompt engineering your own tools. None of these address the root cause.

selftune is the infrastructure-level solution. It doesn't hack around the problem — it measures it, diagnoses it, and fixes it automatically.

---

## How It Works

```
Observe → Detect → Diagnose → Propose → Validate → Deploy → Watch → Repeat
```

```
Claude Code (hooks):                 OpenCode (hooks):
  UserPromptSubmit → prompt-log.ts     message.*        → opencode-prompt-log.ts
  UserPromptSubmit → auto-activate.ts  tool.execute.after → opencode-skill-eval.ts
  PostToolUse      → skill-eval.ts     session.idle     → opencode-session-stop.ts
  PreToolUse       → skill-change-guard.ts
  PreToolUse       → evolution-guard.ts
  Stop             → session-stop.ts
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

**1. Observe** — Hooks capture every session: what the user asked, which skills fired, what happened.

**2. Detect** — Cross-reference query logs against skill usage logs. Surface the queries where your skill *should* have fired but didn't.

**3. Diagnose** — Group failures by invocation pattern. "Users say X, Y, Z but the skill only matches A, B."

**4. Propose** — Generate an improved skill description via LLM, trained on your actual failure patterns.

**5. Validate** — Test the proposal against your eval set. Must improve overall. Less than 5% regression on existing triggers.

**6. Deploy** — Update SKILL.md with full audit trail. Every change is recorded.

**7. Watch** — Monitor pass rates post-deploy. Auto-rollback if performance drops.

This isn't a one-shot tool. It's a continuous loop that runs alongside your agent, making your skills better every week.

### Auto-Activation

The `auto-activate.ts` UserPromptSubmit hook runs on every prompt and checks activation rules (grading thresholds, stale evolutions, regression signals). When selftune should run, it outputs formatted suggestions inline. Session state tracking prevents repeated nags within the same session. The `skill-change-guard.ts` and `evolution-guard.ts` PreToolUse hooks provide enforcement guardrails that detect direct SKILL.md edits and suggest or require running `selftune watch` first.

### Evolution Memory

The 3-file memory system at `~/.selftune/memory/` (context.md, plan.md, decisions.md) persists evolution state across context resets. The evolve, rollback, and watch commands automatically maintain these files so agents can resume work without losing prior analysis.

---

## Commands

| Command | What it does |
|---|---|
| `selftune init` | Auto-detect your agent environment, bootstrap config |
| `selftune status` | See which skills are undertriggering and why |
| `selftune last` | Quick insight from your most recent session |
| `selftune evals --skill <name>` | Generate eval sets from real usage logs |
| `selftune grade --skill <name>` | Grade sessions: trigger accuracy, process quality, output quality |
| `selftune evolve --skill <name>` | Propose, validate, and deploy improved skill descriptions |
| `selftune watch --skill <name>` | Monitor post-deploy pass rates, auto-rollback on regressions |
| `selftune rollback --skill <name>` | Restore pre-evolution description |
| `selftune replay` | Backfill logs from existing Claude Code transcripts |
| `selftune contribute` | Export anonymized data for community signal pooling |
| `selftune dashboard` | Open a visual skill-health dashboard |
| `selftune doctor` | Health check on logs, hooks, config, and schema |
| `selftune ingest-openclaw` | Ingest OpenClaw session transcripts |
| `selftune cron setup` | Register autonomous cron jobs with OpenClaw |
| `selftune cron list` | Show registered selftune cron jobs |
| `selftune cron remove` | Remove selftune cron jobs |

---

## What Makes This Different

| Approach | How it works | Limitation |
|---|---|---|
| **Directive language** | Write "ALWAYS invoke..." in SKILL.md | Brittle. One rewrite away from breaking. |
| **Forced-loading hooks** | Inject skill instructions on every prompt | Doesn't fix the description. Band-aid. |
| **Manual rewrites** | Developer guesses better phrasing | No data. No validation. No regression detection. |
| **selftune** | Measures real failures, proposes fixes, validates against eval sets, auto-rollbacks on regressions | Needs a few days of logs to build signal. |

selftune is the only tool that treats skill descriptions as living artifacts that evolve based on evidence.

---

## Tips

- Run `selftune init` first — everything else reads from the config it writes.
- Let logs accumulate a few days before running evals. More real queries = more reliable signal.
- All hooks are silent (exit 0) and take <50ms. Negligible overhead.
- Use `--dry-run` with `evolve` to preview proposals without deploying.
- Use `selftune contribute --preview` to inspect anonymized data before sharing.
- Use `selftune replay` to unlock months of existing signal immediately.

---

## Testing & Development

### Unit Tests

```bash
bun test
```

530 tests across 36 files. Runs in ~600ms.

### Sandbox Harness

The sandbox harness exercises every CLI command and hook against realistic fixture data in an isolated `/tmp` directory — your real `~/.claude/` and `~/.selftune/` are never touched.

```bash
make sandbox
```

Tests 3 real skills from [skills.sh](https://skills.sh): `find-skills` (healthy), `frontend-design` (undertriggering), `ai-image-generation` (newly installed). Runs 10 tests in ~400ms.

### Devcontainer + LLM Testing

For commands that require LLM calls (`grade`, `evolve`, `watch`), use the devcontainer with the Claude Code CLI. Based on the [official Claude Code devcontainer reference](https://code.claude.com/docs/en/devcontainer).

**First-time setup** (one-time, auth persists in a Docker volume):
```bash
make sandbox-shell       # drop into the container
claude login             # paste your token
exit
```

**Run LLM tests:**
```bash
make sandbox-llm
```

**Alternative auth:** Set `ANTHROPIC_API_KEY` in `.env.local` at the project root.

**VS Code:** Open the repo and click "Reopen in Container" when prompted.

Uses the official Claude Code CLI with `claude -p`. Auth persists across runs — no need to log in again.

### All Checks

```bash
make check   # lint + architecture lint + unit tests + sandbox
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full domain map, module rules, and dependency structure.

## Sponsor

If selftune saves you time, consider [sponsoring the project](https://github.com/sponsors/WellDunDun).

## License

[MIT](LICENSE)
