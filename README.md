<div align="center">

<img src="assets/logo.svg" alt="selftune logo" width="80" />

# selftune

**Self-improving skills for AI agents.**

[![CI](https://github.com/selftune-dev/selftune/actions/workflows/ci.yml/badge.svg)](https://github.com/selftune-dev/selftune/actions/workflows/ci.yml)
[![CodeQL](https://github.com/selftune-dev/selftune/actions/workflows/codeql.yml/badge.svg)](https://github.com/selftune-dev/selftune/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/selftune-dev/selftune/badge)](https://securityscorecards.dev/viewer/?uri=github.com/selftune-dev/selftune)
[![npm version](https://img.shields.io/npm/v/selftune)](https://www.npmjs.com/package/selftune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/selftune?activeTab=dependencies)
[![Bun](https://img.shields.io/badge/runtime-bun%20%7C%20node-black)](https://bun.sh)

Your agent skills learn how you work. Detect what's broken. Improve low-risk skill behavior automatically.

**[Install](#install)** · **[Use Cases](#built-for-how-you-actually-work)** · **[How It Works](#how-it-works)** · **[Commands](#commands)** · **[Platforms](#platforms)** · **[Docs](docs/integration-guide.md)**

</div>

---

Your skills do not understand how you talk. You say "make me a slide deck" and nothing happens: no error, no signal, no clue why the right skill never fired. selftune reads the transcripts and telemetry your agent already saves, learns how you actually speak, and improves skill descriptions to match. It validates changes before deployment, watches for regressions after, and rolls back when needed.

Built for **Claude Code**. Also works with Codex, OpenCode, and OpenClaw. Zero runtime dependencies.

## Install

```bash
npx skills add selftune-dev/selftune
```

Then tell your agent: **"initialize selftune"**

Two minutes. No API keys. No external services. No configuration ceremony. Uses your existing agent subscription.

Quick proof path:

```bash
npx selftune@latest doctor
npx selftune@latest sync
npx selftune@latest status
npx selftune@latest dashboard
```

Use `--force` only when you explicitly need to rebuild local state from scratch.

Autonomy quick start:

```bash
npx selftune@latest init --enable-autonomy
npx selftune@latest orchestrate --dry-run
npx selftune@latest schedule --install --dry-run
```

**CLI only** (no installed skill):

```bash
npx selftune@latest doctor
```

## Before / After

<p align="center">
  <img src="./assets/BeforeAfter.gif" alt="Before: 47% pass rate → After: 89% pass rate" width="800">
</p>

selftune learned that real users say "slides", "deck", "presentation for Monday" — none of which matched the original skill description. It rewrote the description to match how people actually talk. Validated against the eval set. Deployed with a backup. Done.

## Built for How You Actually Work

**I write and use my own skills** — You built skills for your workflow but your descriptions don't match how you actually talk. selftune learns your language from real sessions and evolves descriptions to match — no more manual tuning. `selftune status` · `selftune evolve` · `selftune baseline`

**I publish skills others install** — Your skill works for you, but every user talks differently. selftune ships skills that get better for every user automatically — adapting descriptions to how each person actually works. `selftune status` · `selftune evals` · `selftune badge`

**I manage an agent setup with many skills** — You have 15+ skills installed.
Some work. Some chain together. Some conflict. selftune shows which
combinations repeat, which ones help, and where the friction is.
`selftune dashboard` · `selftune composability` · `selftune workflows`

## How It Works

<p align="center">
  <img src="./assets/FeedbackLoop.gif" alt="Observe → Detect → Evolve → Watch" width="800">
</p>

A continuous feedback loop that makes your skills learn and adapt from real work.

**Observe** — selftune reads the transcripts and telemetry your agents already save. On Claude Code, hooks can add low-latency hints, but transcripts and logs are the source of truth. Use `selftune sync` to ingest current activity and `selftune replay` to backfill older Claude Code sessions.

**Detect** — selftune finds the gap between how you talk and how your skills are described. It spots missed triggers, underperforming descriptions, noisy environments, and regressions in real usage.

**Evolve** — For low-risk changes, selftune can autonomously rewrite skill descriptions to match how you actually work. Every proposal is validated before deploy. Full skill-body or routing changes stay available for higher-touch workflows.

**Watch** — After deploying changes, selftune monitors trigger quality and post-deploy evidence. If something regresses, it can roll back automatically. The goal is autonomous improvement with safeguards, not blind self-editing.

## What's New in v0.2.x

- **Source-truth sync** — `selftune sync` now leads the product loop, using transcripts/logs as truth and hooks as hints
- **SQLite-backed local app** — `selftune dashboard` now serves the React SPA by default with faster overview/report routes on top of materialized local data
- **Autonomous low-risk evolution** — description evolution is autonomous by default, with explicit review-required mode for stricter policies
- **Autonomous scheduling** — `selftune init --enable-autonomy` and `selftune schedule --install` make the orchestrated loop the default recurring runtime
- **Full skill body evolution** — evolve routing tables and entire skill bodies using teacher-student model with structural, trigger, and quality gates
- **Synthetic eval generation** — `selftune evals --synthetic` generates eval sets from `SKILL.md` for cold-start skills
- **Cheap-loop evolution** — `selftune evolve --cheap-loop` uses haiku for proposal generation and validation, sonnet only for the final deployment gate
- **Per-stage model control** — `--validation-model`, `--proposal-model`, and `--gate-model` give fine-grained control over each evolution stage
- **Sandbox test harness** — automated coverage, including devcontainer-based LLM testing
- **Workflow discovery + codification** — `selftune workflows` finds repeated multi-skill sequences from telemetry and can append them to `## Workflows` in `SKILL.md`

## Commands

| Command | What it does |
|---|---|
| `selftune doctor` | Health check: logs, config, permissions, dashboard build/runtime expectations |
| `selftune sync` | Ingest source-truth activity from supported agents and rebuild local state |
| `selftune status` | See which skills are undertriggering and why |
| `selftune dashboard` | Open the React SPA dashboard (SQLite-backed) |
| `selftune orchestrate` | Run the core loop: sync, inspect candidates, evolve, and watch |
| `selftune schedule --install` | Install platform-native scheduling for the autonomous loop |
| `selftune evals --skill <name>` | Generate eval sets from real session data (`--synthetic` for cold-start) |
| `selftune evolve --skill <name>` | Propose, validate, and deploy improved descriptions (`--cheap-loop`, `--with-baseline`) |
| `selftune evolve-body --skill <name>` | Evolve full skill body or routing table (teacher-student, 3-gate validation) |
| `selftune watch --skill <name>` | Monitor after deploy. Auto-rollback on regression. |
| `selftune replay` | Backfill data from existing Claude Code transcripts |
| `selftune baseline --skill <name>` | Measure skill value vs no-skill baseline |
| `selftune unit-test --skill <name>` | Run or generate skill-level unit tests |
| `selftune composability --skill <name>` | Measure synergy and conflicts between co-occurring skills, with workflow-candidate hints |
| `selftune workflows` | Discover repeated multi-skill workflows and save a discovered workflow into `SKILL.md` |
| `selftune import-skillsbench` | Import external eval corpus from [SkillsBench](https://github.com/benchflow-ai/skillsbench) |
| `selftune badge --skill <name>` | Generate skill health badge SVG |
| `selftune cron setup` | Optional scheduler helper for OpenClaw-oriented automation |

Full command reference: `selftune --help`

## Why Not Just Rewrite Skills Manually?

| Approach | Problem |
|---|---|
| Rewrite the description yourself | No data on how users actually talk. No validation. No regression detection. |
| Add "ALWAYS invoke when..." directives | Brittle. One agent rewrite away from breaking. |
| Force-load skills on every prompt | Doesn't fix the description. Expensive band-aid. |
| **selftune** | Learns from real usage, rewrites descriptions to match how you work, validates against eval sets, auto-rollbacks on regressions. |

## Different Layer, Different Problem

Observability tools trace LLM calls. Skill authoring tools help you write skills. Neither knows whether the right skill fired for the right person. selftune does — and fixes it automatically.

| Dimension | selftune | Braintrust / Langfuse | skill-creator / SkillForge |
|-----------|----------|-----------------------|---------------------------|
| **Layer** | Skill-specific | LLM call / agent trace | Skill authoring |
| **When** | Runtime (real sessions) | Runtime (traces) | Authoring time (manual) |
| **Detects** | Missed triggers, false negatives, conflicts | Token usage, latency, chain failures | — |
| **Improves** | Descriptions, body, routing — automatically | — | Helps you write better manually |
| **Closed loop** | Yes — observe → evolve → watch → repeat | No | No |
| **Setup** | Zero deps, zero API keys | Self-host or cloud | Included with agent |
| **Price** | Free (MIT) | Freemium / Paid | Free |

## Platforms

**Claude Code** (primary) — Reads saved transcripts and telemetry directly. Hooks install automatically and add low-latency hints. `selftune replay` backfills older Claude Code sessions. Full feature support.

**Codex** — `selftune wrap-codex -- <args>` or `selftune ingest-codex`

**OpenCode** — `selftune ingest-opencode`

**OpenClaw** — `selftune ingest-openclaw`. `selftune cron setup` remains available as an optional OpenClaw-oriented scheduler helper, but the main product loop is still `selftune orchestrate` plus generic scheduling.

Requires [Bun](https://bun.sh) or Node.js 18+. No extra API keys.

---

<div align="center">

[Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Integration Guide](docs/integration-guide.md) · [Sponsor](https://github.com/sponsors/WellDunDun)

MIT licensed. Free forever. Built for Claude Code.

</div>
