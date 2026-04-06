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

Your agent skills learn how you work. Detect what's broken. Fix it automatically.

**[Install](#install)** · **[Use Cases](#built-for-how-you-actually-work)** · **[How It Works](#how-it-works)** · **[Commands](#commands)** · **[Platforms](#platforms)** · **[Docs](docs/integration-guide.md)**

</div>

---

Your skills don't understand how you talk. You say "make me a slide deck" and nothing happens — no error, no log, no signal. selftune watches your real sessions, learns how you actually speak, and rewrites skill descriptions to match. Automatically.

Works with **Claude Code** (primary). Codex, OpenCode, and OpenClaw adapters are experimental. Zero runtime dependencies.

## Install

```bash
npx skills add selftune-dev/selftune
```

Then tell your agent: **"initialize selftune"**

Two minutes. No API keys. No external services. No configuration ceremony. Uses your existing agent subscription. You'll see which skills are undertriggering.

**CLI only** (no skill, just the CLI):

```bash
npx selftune@latest doctor
```

## Updating

The skill and CLI ship together as one npm package. To update:

```bash
npx skills add selftune-dev/selftune
```

This reinstalls the latest version of both the skill (SKILL.md, workflows) and the CLI. `selftune doctor` will warn you when a newer version is available.

## Before / After

<p align="center">
  <img src="./assets/BeforeAfter.gif" alt="Before: 47% pass rate → After: 89% pass rate" width="800">
</p>

selftune learned that real users say "slides", "deck", "presentation for Monday" — none of which matched the original skill description. It rewrote the description to match how people actually talk. Validated against the eval set. Deployed with a backup. Done.

## Built for How You Actually Work

**I write and use my own skills** — Your skill descriptions don't match how you actually talk. Tell your agent "improve my skills" and selftune learns your language from real sessions, evolves descriptions to match, and validates before deploying. No manual tuning.

**I publish skills others install** — Your skill works for you, but every user talks differently. selftune ships skills that get better for every user automatically — adapting descriptions to how each person actually works.

**I manage an agent setup with many skills** — You have 15+ skills installed. Some work. Some don't. Some conflict. Tell your agent "how are my skills doing?" and selftune gives you a health dashboard and automatically improves the skills that aren't keeping up.

**I use skills for non-coding work** — Marketing workflows, research pipelines, compliance checks, slide decks. You say "make me a presentation" and nothing happens. selftune learns that "slides", "deck", and "presentation for Monday" all mean the same skill — and fixes the routing automatically.

## How It Works

<p align="center">
  <img src="./assets/FeedbackLoop.gif" alt="Observe → Detect → Evolve → Watch" width="800">
</p>

A continuous feedback loop that makes your skills learn and adapt. Automatically. Your agent runs everything — you just install the skill and talk naturally.

**Observe** — Seven real-time hooks capture every query, every skill invocation, and every correction signal. Structured telemetry — not raw logs. On Claude Code, hooks install automatically during `selftune init`. Backfill existing transcripts with `selftune ingest claude`.

**Detect** — Finds the gap between how you talk and how your skills are described. You say "make me a slide deck" and your pptx skill stays silent — selftune catches that mismatch. Clusters missed queries by invocation type. Detects correction signals ("why didn't you use X?") and triggers immediate improvement.

**Evolve** — Generates multiple proposals biased toward different invocation types, validates each against your real eval set with majority voting, runs constitutional checks, then gates with an expensive model before deploying. Not guesswork — evidence. Automatic backup on every deploy.

**Watch** — After deploying changes, selftune monitors trigger rates, false negatives, and per-invocation-type scores. If anything regresses, it rolls back automatically. No manual monitoring needed.

**Automate** — Run `selftune cron setup` to install OS-level scheduling. selftune syncs, grades, evolves, and watches on a schedule — fully autonomous.

## How Is This Different from Agents That "Learn"?

Some agents claim self-improvement by saving notes about what worked. That's knowledge persistence — not a closed loop. There's no measurement, no validation, and no way to know if the saved notes are actually correct.

selftune is empirical. It observes real sessions, grades execution quality, detects missed triggers, proposes changes, validates them against eval sets, deploys with automatic backup, monitors for regressions, and rolls back on failure. Twelve interlocking mechanisms — not one background thread writing markdown.

| Approach                  | Measures quality? | Validates changes?          | Detects regressions?   | Rolls back? |
| ------------------------- | ----------------- | --------------------------- | ---------------------- | ----------- |
| Agent saves its own notes | No                | No                          | No                     | No          |
| Manual skill rewrites     | No                | No                          | No                     | No          |
| **selftune**              | 3-tier grading    | Eval sets + majority voting | Post-deploy monitoring | Automatic   |

## Commands

Your agent runs these — you just say what you want ("improve my skills", "show the dashboard").

| Group      | Command                                      | What it does                                                                                |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
|            | `selftune status`                            | Get a one-line health summary plus compact attention / improving highlights                 |
|            | `selftune last`                              | Quick insight from the most recent session                                                  |
|            | `selftune orchestrate`                       | Run the full autonomous loop (sync → grade → evolve → watch)                                |
|            | `selftune sync`                              | Replay source-truth transcripts/rollouts into SQLite and refresh repair state               |
|            | `selftune dashboard`                         | Open the visual skill health dashboard                                                      |
|            | `selftune doctor`                            | Health check: logs, hooks, config, permissions                                              |
| **ingest** | `selftune ingest claude`                     | Backfill from Claude Code transcripts                                                       |
|            | `selftune ingest codex`                      | Import Codex rollout logs (experimental)                                                    |
| **grade**  | `selftune grade --skill <name>`              | Grade a skill session with evidence                                                         |
|            | `selftune grade auto`                        | Auto-grade recent sessions for ungraded skills                                              |
|            | `selftune grade baseline --skill <name>`     | Measure skill value vs no-skill baseline                                                    |
| **evolve** | `selftune evolve --skill <name>`             | Propose, validate, and deploy improved descriptions                                         |
|            | `selftune evolve body --skill <name>`        | Evolve full skill body or routing table                                                     |
|            | `selftune evolve rollback --skill <name>`    | Rollback a previous evolution                                                               |
| **eval**   | `selftune eval generate --skill <name>`      | Generate eval sets (`--synthetic` for cold-start)                                           |
|            | `selftune eval unit-test --skill <name>`     | Run or generate skill-level unit tests                                                      |
|            | `selftune eval composability --skill <name>` | Detect conflicts between co-occurring skills                                                |
|            | `selftune eval family-overlap --prefix sc-`  | Detect sibling overlap and suggest when a skill family should be consolidated               |
|            | `selftune eval import`                       | Import external eval corpus from [SkillsBench](https://github.com/benchflow-ai/skillsbench) |
| **hooks**  | `selftune codex install`                     | Install selftune hooks into Codex (`--dry-run`, `--uninstall`)                              |
|            | `selftune opencode install`                  | Install selftune hooks into OpenCode                                                        |
|            | `selftune cline install`                     | Install selftune hooks into Cline                                                           |
| **auto**   | `selftune cron setup`                        | Install OS-level scheduling (cron/launchd/systemd)                                          |
|            | `selftune watch --skill <name>`              | Monitor after deploy. Auto-rollback on regression.                                          |
| **other**  | `selftune workflows`                         | Discover and manage multi-skill workflows                                                   |
|            | `selftune contributions`                    | Manage creator-directed sharing preferences                                                  |
|            | `selftune creator-contributions`            | Create or remove bundled `selftune.contribute.json` configs for skill creators              |
|            | `selftune contribute`                       | Export an anonymized community contribution bundle                                           |
|            | `selftune recover`                           | Recover SQLite from legacy/exported JSONL during migration or disaster recovery             |
|            | `selftune badge --skill <name>`              | Generate a health badge for your skill's README                                             |
|            | `selftune telemetry`                         | Manage anonymous usage analytics (status, enable, disable)                                  |
|            | `selftune alpha upload`                      | Run a manual SQLite-backed alpha upload cycle and emit a JSON send summary                  |

Full command reference: `selftune --help`

## Why Not Just Rewrite Skills Manually?

| Approach                               | Problem                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Rewrite the description yourself       | No data on how users actually talk. No validation. No regression detection.                                                      |
| Add "ALWAYS invoke when..." directives | Brittle. One agent rewrite away from breaking.                                                                                   |
| Force-load skills on every prompt      | Doesn't fix the description. Expensive band-aid.                                                                                 |
| **selftune**                           | Learns from real usage, rewrites descriptions to match how you work, validates against eval sets, auto-rollbacks on regressions. |

## Different Layer, Different Problem

LLM observability tools trace API calls. Infrastructure tools monitor servers. Neither knows whether the right skill fired for the right person. selftune does — and fixes it automatically.

selftune is complementary to these tools, not competitive. They trace what happens inside the LLM. selftune makes sure the right skill is called in the first place.

| Dimension    | selftune                                          | Langfuse             | LangSmith      | OpenLIT        |
| ------------ | ------------------------------------------------- | -------------------- | -------------- | -------------- |
| **Layer**    | Skill-specific                                    | LLM call             | Agent trace    | Infrastructure |
| **Detects**  | Missed triggers, false negatives, skill conflicts | Token usage, latency | Chain failures | System metrics |
| **Improves** | Descriptions, body, and routing automatically     | —                    | —              | —              |
| **Setup**    | Zero deps, zero API keys                          | Self-host or cloud   | Cloud required | Helm chart     |
| **Price**    | Free (MIT)                                        | Freemium             | Paid           | Free           |
| **Unique**   | Self-improving skills + auto-rollback             | Prompt management    | Evaluations    | Dashboards     |

## Platforms

| Platform | Support | Real-time Hooks | Eval/Optimizer Agents | Batch Ingest | Config Location |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | Full | Automatic via `selftune init` | `claude --agent` (native) | `selftune ingest claude` | `~/.claude/settings.json` |
| **Codex** | Experimental | `selftune codex install` | `codex exec` (inlined) | `selftune ingest codex` | `~/.codex/hooks.json` |
| **OpenCode** | Experimental | `selftune opencode install` | `opencode run --agent` (native) | `selftune ingest opencode` | `./opencode.json` or `~/.config/opencode/opencode.json` |
| **Cline** | Experimental | `selftune cline install` | — | — | `~/Documents/Cline/Hooks/` |
| **OpenClaw** | Experimental | — | — | `selftune ingest openclaw` | — |

OpenCode and Codex now support eval/optimizer agent workflows (evolution-reviewer, diagnosis-analyst, pattern-analyst, integration-guide). OpenCode agents are registered in the config during `selftune opencode install`; Codex inlines agent instructions into the prompt since it lacks a native `--agent` flag. OpenCode lacks a prompt-submission hook event, so prompt logging and auto-activate are unavailable. Cline only exposes PostToolUse and task lifecycle events, limiting coverage to commit tracking and session telemetry. All platforms write to the same shared log schema.

Requires [Bun](https://bun.sh) or Node.js 18+. No extra API keys.

---

<div align="center">

[Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Integration Guide](docs/integration-guide.md) · [Sponsor](https://github.com/sponsors/WellDunDun)

MIT licensed. Free forever. Hooks for Claude Code, Codex, OpenCode, and Cline; batch ingest for OpenClaw.

</div>
