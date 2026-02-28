---
name: Reins
description: Reins CLI skill for scaffold/audit/doctor/evolve workflows. Use when setting up or evaluating harness-engineering repo readiness and maturity with Reins commands.
---

# Reins

Use the Reins CLI to operationalize harness engineering in any repository.

## Execution Model (Critical)

1. The CLI is the execution engine and scoring source of truth.
2. This skill is the control plane for agent behavior (routing, command order, JSON parsing discipline).
3. Humans steer goals and tradeoffs; agents execute the loop.

Do not re-implement CLI logic in skill instructions. Always run commands and parse JSON outputs.

## Use When

Use this skill when the user asks to:
- Scaffold repository readiness artifacts (`AGENTS.md`, `ARCHITECTURE.md`, `docs/`, `risk-policy.json`)
- Audit or score agent-readiness/maturity (0-18, maturity levels, weakest dimensions)
- Diagnose readiness gaps with `doctor` (pass/fail/warn health checks with prescriptive fixes)
- Evolve the repository to the next Reins maturity level
- Improve docs-drift/policy-as-code enforcement tied to Reins outputs
- Understand harness engineering methodology or maturity levels

## Don't Use When

Do not use this skill for:
- Generic code implementation/debugging unrelated to Reins workflows
- General-purpose lint/test/security checks that do not request Reins scoring or scaffolding
- Product/domain feature design that does not involve harness-engineering structure
- Questions about installing random third-party skills (use skill discovery/installer flows instead)

## Command Execution Policy

Use this order when running commands:

1. In user repositories, check if installed skills are stale:
`npx skills check`
If updates are available, refresh before running workflow commands:
`npx skills update`
2. If working inside the Reins repository itself:
`cd cli/reins && bun src/index.ts <command> ../..`
3. Otherwise (or if local source is unavailable):
`npx reins-cli@latest <command> <target-path>`

All Reins commands output deterministic JSON. **Always parse JSON output** — never text-match against findings strings.

## Quick Reference

### CLI Commands

```bash
# Scaffold harness engineering structure
reins init <path> [--name <name>] [--force] [--pack <auto|agent-factory>]

# Score maturity across 6 dimensions (0-18)
reins audit <path>

# Health check with prescriptive fixes
reins doctor <path>

# Roadmap to next maturity level
reins evolve <path> [--apply]

# Show usage
reins help
```

### Maturity Levels

| Score | Level | Description |
|-------|-------|-------------|
| 0-4 | **L0: Manual** | Traditional engineering, no agent infrastructure |
| 5-8 | **L1: Assisted** | Agents help, but humans still write code |
| 9-13 | **L2: Steered** | Humans steer, agents execute most code |
| 14-16 | **L3: Autonomous** | Agents handle full lifecycle with human oversight |
| 17-18 | **L4: Self-Correcting** | Agents maintain, clean, and evolve the system |

## Core Reins Principles

1. **Repository is the system of record** -- Knowledge stays in versioned files.
2. **Humans steer, agents execute** -- Prompt-first workflows over manual edits where possible.
3. **Mechanical enforcement over intent-only docs** -- CI and policy-as-code back every rule.
4. **Progressive disclosure** -- AGENTS.md is the map, deep docs hold details.
5. **Continuous cleanup** -- Track debt, docs drift, and stale patterns as first-class work.

## Workflow Routing

| Trigger | Workflow | File |
|---------|----------|------|
| scaffold, init, setup, bootstrap | Scaffold | Workflows/Scaffold.md |
| audit, score, assess, readiness | Audit | Workflows/Audit.md |
| doctor, health check, diagnose, gaps | Doctor | Workflows/Doctor.md |
| evolve, improve, mature, level up | Evolve | Workflows/Evolve.md |

## Resource Index

| Resource | Purpose |
|----------|---------|
| `SKILL.md` | Skill routing, triggers, quick reference |
| `HarnessMethodology.md` | Full methodology reference (5 pillars, 10 production patterns) |
| `Workflows/Scaffold.md` | Scaffold workflow with step-by-step guide |
| `Workflows/Audit.md` | Audit workflow with dimension details and output format |
| `Workflows/Doctor.md` | Doctor workflow with health checks and fix guidance |
| `Workflows/Evolve.md` | Evolve workflow with level-up paths |

## Examples

- "Scaffold this repo for Reins"
- "Audit this project with Reins and summarize the weakest dimensions"
- "Run doctor on this repo and fix everything that fails"
- "Evolve this repo to the next Reins maturity level"
- "What's the harness engineering maturity of this project?"

## Negative Examples

These should not trigger Reins:
- "Fix this React hydration bug"
- "Add OAuth login to the API"
- "Run normal project lint and unit tests"

Route to general coding workflows unless the user explicitly asks for Reins scaffolding, audit, doctor, or evolve operations.
