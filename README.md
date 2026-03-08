<div align="center">

<img src="assets/logo.svg" alt="selftune logo" width="80" />

# selftune

**Self-improving skills for AI agents.**

[![CI](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml)
[![CodeQL](https://github.com/WellDunDun/selftune/actions/workflows/codeql.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/WellDunDun/selftune/badge)](https://securityscorecards.dev/viewer/?uri=github.com/WellDunDun/selftune)
[![npm version](https://img.shields.io/npm/v/selftune)](https://www.npmjs.com/package/selftune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/selftune?activeTab=dependencies)
[![Bun](https://img.shields.io/badge/runtime-bun%20%7C%20node-black)](https://bun.sh)

Your agent skills learn how you work. Detect what's broken. Fix it automatically.

**[Install](#install)** · **[Use Cases](#built-for-how-you-actually-work)** · **[How It Works](#how-it-works)** · **[Commands](#commands)** · **[Platforms](#platforms)** · **[Docs](docs/integration-guide.md)**

</div>

---

Your skills don't understand how you talk. You say "make me a slide deck" and nothing happens — no error, no log, no signal. selftune watches your real sessions, learns how you actually speak, and rewrites skill descriptions to match. Automatically.

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
  <img src="./assets/BeforeAfter.gif" alt="Before: 47% pass rate → After: 89% pass rate" width="800">
</p>

selftune learned that real users say "slides", "deck", "presentation for Monday" — none of which matched the original skill description. It rewrote the description to match how people actually talk. Validated against the eval set. Deployed with a backup. Done.

## Built for How You Actually Work

**I write and use my own skills** — You built skills for your workflow but your descriptions don't match how you actually talk. selftune learns your language from real sessions and evolves descriptions to match — no more manual tuning. `selftune status` · `selftune evolve` · `selftune baseline`

**I publish skills others install** — Your skill works for you, but every user talks differently. selftune ships skills that get better for every user automatically — adapting descriptions to how each person actually works. `selftune status` · `selftune evals` · `selftune badge`

**I manage an agent setup with many skills** — You have 15+ skills installed. Some work. Some don't. Some conflict. selftune gives you a health dashboard and automatically improves the skills that aren't keeping up with how your team works. `selftune dashboard` · `selftune composability` · `selftune doctor`

## How It Works

<p align="center">
  <img src="./assets/FeedbackLoop.gif" alt="Observe → Detect → Evolve → Watch" width="800">
</p>

A continuous feedback loop that makes your skills learn and adapt. Automatically.

**Observe** — Hooks capture every user query and which skills fired. On Claude Code, hooks install automatically. Use `selftune replay` to backfill existing transcripts. This is how your skills start learning.

**Detect** — selftune finds the gap between how you talk and how your skills are described. You say "make me a slide deck" and your pptx skill stays silent — selftune catches that mismatch.

**Evolve** — Rewrites skill descriptions — and full skill bodies — to match how you actually work. Batched validation with per-stage model control (`--cheap-loop` uses haiku for the loop, sonnet for the gate). Teacher-student body evolution with 3-gate validation. Baseline comparison gates on measurable lift. Automatic backup.

**Watch** — After deploying changes, selftune monitors skill trigger rates. If anything regresses, it rolls back automatically. Your skills keep improving without you touching them.

## What's New in v0.2.0

- **Full skill body evolution** — Beyond descriptions: evolve routing tables and entire skill bodies using teacher-student model with structural, trigger, and quality gates
- **Synthetic eval generation** — `selftune evals --synthetic` generates eval sets from SKILL.md via LLM, no session logs needed. Solves cold-start: new skills get evals immediately.
- **Cheap-loop evolution** — `selftune evolve --cheap-loop` uses haiku for proposal generation and validation, sonnet only for the final deployment gate. ~80% cost reduction.
- **Batch trigger validation** — Validation now batches 10 queries per LLM call instead of one-per-query. ~10x faster evolution loops.
- **Per-stage model control** — `--validation-model`, `--proposal-model`, and `--gate-model` flags give fine-grained control over which model runs each evolution stage.
- **Auto-activation system** — Hooks detect when selftune should run and suggest actions
- **Enforcement guardrails** — Blocks SKILL.md edits on monitored skills unless `selftune watch` has been run
- **Live dashboard server** — `selftune dashboard --serve` with SSE auto-refresh and action buttons
- **Evolution memory** — Persists context, plans, and decisions across context resets
- **4 specialized agents** — Diagnosis analyst, pattern analyst, evolution reviewer, integration guide
- **Sandbox test harness** — Comprehensive automated test coverage, including devcontainer-based LLM testing

## Commands

| Command | What it does |
|---|---|
| `selftune status` | See which skills are undertriggering and why |
| `selftune evals --skill <name>` | Generate eval sets from real session data (`--synthetic` for cold-start) |
| `selftune evolve --skill <name>` | Propose, validate, and deploy improved descriptions (`--cheap-loop`, `--with-baseline`) |
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
| Rewrite the description yourself | No data on how users actually talk. No validation. No regression detection. |
| Add "ALWAYS invoke when..." directives | Brittle. One agent rewrite away from breaking. |
| Force-load skills on every prompt | Doesn't fix the description. Expensive band-aid. |
| **selftune** | Learns from real usage, rewrites descriptions to match how you work, validates against eval sets, auto-rollbacks on regressions. |

## Different Layer, Different Problem

LLM observability tools trace API calls. Infrastructure tools monitor servers. Neither knows whether the right skill fired for the right person. selftune does — and fixes it automatically.

selftune is complementary to these tools, not competitive. They trace what happens inside the LLM. selftune makes sure the right skill is called in the first place.

| Dimension | selftune | Langfuse | LangSmith | OpenLIT |
|-----------|----------|----------|-----------|---------|
| **Layer** | Skill-specific | LLM call | Agent trace | Infrastructure |
| **Detects** | Missed triggers, false negatives, skill conflicts | Token usage, latency | Chain failures | System metrics |
| **Improves** | Descriptions, body, and routing automatically | — | — | — |
| **Setup** | Zero deps, zero API keys | Self-host or cloud | Cloud required | Helm chart |
| **Price** | Free (MIT) | Freemium | Paid | Free |
| **Unique** | Self-improving skills + auto-rollback | Prompt management | Evaluations | Dashboards |

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
