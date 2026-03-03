<p align="center">
  <img src="assets/logo.svg" alt="selftune logo" width="80" />
</p>

<p align="center">

[![CI](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml)
[![CodeQL](https://github.com/WellDunDun/selftune/actions/workflows/codeql.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/WellDunDun/selftune/badge)](https://securityscorecards.dev/viewer/?uri=github.com/WellDunDun/selftune)
[![npm version](https://img.shields.io/npm/v/selftune)](https://www.npmjs.com/package/selftune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/selftune?activeTab=dependencies)
[![Bun](https://img.shields.io/badge/runtime-bun%20%7C%20node-black)](https://bun.sh)

</p>

# selftune

<div align="center">

<img src="./images/selftune-logo.svg" alt="selftune" width="250">

<br/>

[![Typing SVG](https://readme-typing-svg.demolab.com?font=Fira+Code&weight=500&size=20&pause=1000&color=3B82F6&center=true&vCenter=true&width=520&lines=Your+skills+trigger+half+the+time.;selftune+fixes+that+automatically.;Observe+%E2%86%92+Detect+%E2%86%92+Evolve+%E2%86%92+Watch+%E2%86%92+Repeat)](https://github.com/WellDunDun/selftune)

<br/>

![Stars](https://img.shields.io/github/stars/WellDunDun/selftune?style=social)
![Forks](https://img.shields.io/github/forks/WellDunDun/selftune?style=social)

[![CI](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml/badge.svg)](https://github.com/WellDunDun/selftune/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/selftune)](https://www.npmjs.com/package/selftune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/selftune?activeTab=dependencies)

**[Install](#install)** · **[Before / After](#before--after)** · **[Commands](#commands)** · **[Platforms](#platform-quick-start)** · **[Docs](docs/integration-guide.md)**

</div>

---

> [!NOTE]
> **Phase 0 — Foundation.** OpenClaw ingestor shipped, case studies in progress. [Show HN launch targeting March 17.](https://github.com/WellDunDun/selftune)

A user says "make me a slide deck" and your pptx skill doesn't fire. No error. No log. You never find out.

Skill descriptions are written based on what developers *think* users will say, not what they *actually* say. selftune observes real sessions, finds the mismatches, and rewrites your skill descriptions using evidence. Not vibes.

Works with **Claude Code**, **Codex**, **OpenCode**, and **OpenClaw**. Zero runtime dependencies.

## Install

```bash
npx skills add WellDunDun/selftune
```

Then tell your agent: **"initialize selftune"**

That's it. Within minutes you'll see which skills are undertriggering.

## Before / After

<p align="center">
  <img src="./images/selftune-before-after.png" alt="Before: 47% pass rate → After: 89% pass rate" width="800">
</p>

selftune found that real users say "slides", "deck", "presentation for Monday" — none of which matched the original skill description. It rewrote the triggers. Validated against the eval set. Deployed with a backup. Done.

## What It Does

<p align="center">
  <img src="./images/selftune-feedback-loop.png" alt="Observe → Detect → Diagnose → Propose → Validate → Deploy → Watch" width="800">
</p>

- **Observe** — Hooks capture every session automatically
- **Detect** — Finds queries where your skill *should* have fired but didn't
- **Evolve** — Rewrites skill descriptions based on real failure patterns
- **Watch** — Monitors post-deploy, auto-rollbacks if anything regresses

## Commands

| Command | What it does |
|---|---|
| `selftune status` | Which skills are undertriggering and why |
| `selftune evals --skill <name>` | Generate eval sets from real usage |
| `selftune grade --skill <name>` | Grade sessions with pre-gates + graduated 0-1 scores |
| `selftune evolve --skill <name>` | Propose, validate, deploy improved descriptions (`--pareto`, `--candidates N`) |
| `selftune watch --skill <name>` | Monitor post-deploy, auto-rollback on regressions |
| `selftune rollback --skill <name>` | Restore pre-evolution description |
| `selftune dashboard` | Visual skill-health dashboard |
| `selftune replay` | Backfill from existing Claude Code transcripts |
| `selftune doctor` | Health check on logs, hooks, config |

Full command reference: `selftune --help`

## Why Not Just Rewrite Skills Manually?

| Approach | Problem |
|---|---|
| Rewrite the description yourself | No data on what users actually say. No validation. No regression detection. |
| Add "ALWAYS invoke when..." directives | Brittle. One agent rewrite away from breaking. |
| Force-load skills on every prompt | Doesn't fix the description. Expensive band-aid. |
| **selftune** | Measures real failures, proposes fixes, validates against eval sets, auto-rollbacks on regressions. |

## Platform Quick Start

**Claude Code** — Hooks install automatically. `selftune replay` backfills existing transcripts.

**Codex** — `selftune wrap-codex -- <args>` or `selftune ingest-codex`

**OpenCode** — `selftune ingest-opencode`

**OpenClaw** — `selftune ingest-openclaw` + `selftune cron setup` for autonomous evolution

Requires [Bun](https://bun.sh) or Node.js 18+. No extra API keys.

---

<div align="center">

[Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Integration Guide](docs/integration-guide.md) · [Sponsor](https://github.com/sponsors/WellDunDun)

MIT License

</div>
