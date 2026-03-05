<div align="center">

<img src="assets/logo.svg" alt="selftune logo" width="80" />

# selftune

**Your skills trigger half the time. selftune fixes that.**

[![CI](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml)
[![CodeQL](https://github.com/WellDunDun/selftune/actions/workflows/codeql.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/WellDunDun/selftune/badge)](https://securityscorecards.dev/viewer/?uri=github.com/WellDunDun/selftune)
[![npm version](https://img.shields.io/npm/v/selftune)](https://www.npmjs.com/package/selftune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/selftune?activeTab=dependencies)
[![Bun](https://img.shields.io/badge/runtime-bun%20%7C%20node-black)](https://bun.sh)

Skill observability & self-improving toolkit for agent skills.

**[Install](#install)** · **[Use Cases](#built-for-how-you-actually-work)** · **[How It Works](#how-it-works)** · **[Commands](#commands)** · **[Platforms](#platforms)** · **[Docs](docs/integration-guide.md)**

</div>

---

You installed skills. You wrote some yourself. But when you say "make me a slide deck" and nothing happens — there's no error, no log, no signal. selftune watches your real sessions, finds what's failing, and fixes it automatically.

Works with **Claude Code**, **Codex**, **OpenCode**, and **OpenClaw**. Zero runtime dependencies.

## Install

```bash
npx skills add WellDunDun/selftune
```

Then tell your agent: **"initialize selftune"**

Two minutes. No API keys. No external services. No configuration ceremony. Uses your existing agent subscription. Within minutes you'll see which skills are undertriggering.

**CLI only** (no skill, just the CLI):

```bash
npx selftune@latest doctor
```

## Before / After

<p align="center">
  <img src="./images/selftune-before-after.png" alt="Before: 47% pass rate → After: 89% pass rate" width="800">
</p>

selftune found that real users say "slides", "deck", "presentation for Monday" — none of which matched the original skill description. It rewrote the triggers. Validated against the eval set. Deployed with a backup. Done.

## Built for How You Actually Work

**I write and use my own skills** — You built skills for your workflow. You tune descriptions by hand. selftune replaces the guesswork — it watches your sessions, finds what's undertriggering, and evolves your descriptions automatically. `selftune status` · `selftune evolve` · `selftune baseline`

**I publish skills others install** — Your skill works on your machine. But what about the people who installed it? selftune gives you post-publish telemetry — trigger rates, false negatives, and automated fixes for descriptions that don't match how real users talk. `selftune status` · `selftune evals` · `selftune badge`

**I manage an agent setup with many skills** — You have 15+ skills installed. Some work. Some don't. Some conflict with each other. selftune gives you a health dashboard across all your skills — see what's firing, what's missing, and what's interfering. `selftune dashboard` · `selftune composability` · `selftune doctor`

## How It Works

<p align="center">
  <img src="./images/selftune-feedback-loop.png" alt="Observe → Detect → Evolve → Watch" width="800">
</p>

A continuous feedback loop that finds undertriggering skills and fixes them. Automatically.

**Observe** — Hooks automatically record every user query and which skills fired. On Claude Code, hooks install automatically. Use `selftune replay` to backfill existing transcripts.

**Detect** — selftune analyzes sessions to find queries where your skill should have fired but didn't. A user says "make me a slide deck" and your pptx skill stays silent — selftune catches that.

**Evolve** — Proposes improved skill descriptions — and full skill bodies — based on real user language. Teacher-student body evolution with 3-gate validation. Baseline comparison gates on measurable lift. Automatic backup.

**Watch** — After deploying changes, selftune monitors skill trigger rates. If anything regresses, it rolls back automatically. No manual intervention needed.

## What's New in v0.2.0

- **Full skill body evolution** — Beyond descriptions: evolve routing tables and entire skill bodies using teacher-student model with structural, trigger, and quality gates
- **Auto-activation system** — Hooks detect when selftune should run and suggest actions
- **Enforcement guardrails** — Blocks SKILL.md edits on monitored skills unless `selftune watch` has been run
- **Live dashboard server** — `selftune dashboard --serve` with SSE auto-refresh and action buttons
- **Evolution memory** — Persists context, plans, and decisions across context resets
- **4 specialized agents** — Diagnosis analyst, pattern analyst, evolution reviewer, integration guide
- **Sandbox test harness** — 949 tests across 60 files, including devcontainer-based LLM testing

## Commands

| Command | What it does |
|---|---|
| `selftune status` | See which skills are undertriggering and why |
| `selftune evals --skill <name>` | Generate eval sets from real session data |
| `selftune evolve --skill <name>` | Propose, validate, and deploy improved descriptions (`--with-baseline`, `--token-efficiency`) |
| `selftune evolve-body --skill <name>` | Evolve full skill body or routing table (teacher-student, 3-gate validation) |
| `selftune baseline --skill <name>` | Measure skill value vs no-skill baseline |
| `selftune unit-test --skill <name>` | Run or generate skill-level unit tests |
| `selftune composability --skill <name>` | Detect conflicts between co-occurring skills |
| `selftune import-skillsbench` | Import external eval corpus from [SkillsBench](https://github.com/benchflow-ai/skillsbench) |
| `selftune badge --skill <name>` | Generate skill health badge SVG |
| `selftune watch --skill <name>` | Monitor after deploy. Auto-rollback on regression. |
| `selftune dashboard` | Open the visual skill health dashboard |
| `selftune replay` | Backfill data from existing Claude Code transcripts |
| `selftune doctor` | Health check: logs, hooks, config, permissions |

Full command reference: `selftune --help`

## Why Not Just Rewrite Skills Manually?

| Approach | Problem |
|---|---|
| Rewrite the description yourself | No data on what users actually say. No validation. No regression detection. |
| Add "ALWAYS invoke when..." directives | Brittle. One agent rewrite away from breaking. |
| Force-load skills on every prompt | Doesn't fix the description. Expensive band-aid. |
| **selftune** | Measures real failures, proposes description and body fixes, validates against eval sets and baselines, auto-rollbacks on regressions. |

## Different Layer, Different Problem

General LLM observability tools trace API calls. Infrastructure tools monitor servers. Neither sees the skill layer — where a user says "make me a slide deck" and nothing happens. selftune does.

selftune is complementary to these tools, not competitive. They trace what happens inside the LLM. selftune traces what happens before the LLM is even called.

| Dimension | selftune | Langfuse | LangSmith | OpenLIT |
|-----------|----------|----------|-----------|---------|
| **Layer** | Skill-specific | LLM call | Agent trace | Infrastructure |
| **Detects** | Missed triggers, false negatives, skill conflicts | Token usage, latency | Chain failures | System metrics |
| **Improves** | Descriptions, body, and routing automatically | — | — | — |
| **Setup** | Zero deps, zero API keys | Self-host or cloud | Cloud required | Helm chart |
| **Price** | Free (MIT) | Freemium | Paid | Free |
| **Unique** | Evolution loop + auto-rollback | Prompt management | Evaluations | Dashboards |

## Platforms

**Claude Code** — Hooks install automatically. `selftune replay` backfills existing transcripts.

**Codex** — `selftune wrap-codex -- <args>` or `selftune ingest-codex`

**OpenCode** — `selftune ingest-opencode`

**OpenClaw** — `selftune ingest-openclaw` + `selftune cron setup` for autonomous evolution

Requires [Bun](https://bun.sh) or Node.js 18+. No extra API keys.

---

<div align="center">

[Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Integration Guide](docs/integration-guide.md) · [Sponsor](https://github.com/sponsors/WellDunDun)

MIT licensed. Free forever. Works with Claude Code, Codex, OpenCode, and OpenClaw.

</div>
