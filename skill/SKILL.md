---
name: selftune
description: >
  Self-improving skills toolkit that watches real agent sessions, detects missed
  triggers, grades execution quality, and evolves skill descriptions to match how
  users actually talk. Use when grading sessions, generating evals, evolving skill
  descriptions or routing tables, checking skill health, viewing the dashboard,
  ingesting sessions from other platforms, or running autonomous improvement loops.
  Make sure to use this skill whenever the user mentions skill improvement, skill
  performance, skill triggers, skill evolution, skill health, undertriggering,
  overtriggering, session grading, or wants to know how their skills are doing —
  even if they don't say "selftune" explicitly.
metadata:
  author: selftune-dev
  version: 1.0.0
  category: developer-tools
---

# selftune

Observe real agent sessions, detect missed triggers, grade execution quality,
and evolve skill descriptions toward the language real users actually use.

**You are the operator.** The user installed this skill so YOU can manage their
skill health autonomously. They will say things like "set up selftune",
"improve my skills", or "how are my skills doing?" — and you route to the
correct workflow below. The user does not run CLI commands directly; you do.

## Why this matters

Skills are only useful when they trigger at the right time with the right
instructions. But user language drifts — the phrases people use to ask for help
rarely match the trigger keywords a skill author imagined. selftune closes this
gap by observing real sessions, finding where skills fail to activate or
execute poorly, and rewriting descriptions to match actual usage patterns. The
result: skills that get better over time without manual tuning.

## Communicating with the user

Users range from experienced developers who'll say "evolve the pptx description
using the latest eval set" to non-technical users who'll say "make my skills
better". Pay attention to context cues:

- If they use terms like "eval set", "routing table", "JSONL" — match their precision
- If they say "improve my skills" or "how's it going" — explain what you're doing in plain language, summarize results, and suggest next steps
- When in doubt, briefly explain what a command does before running it

## Bootstrap

If `~/.selftune/config.json` does not exist, read `Workflows/Initialize.md`
first. The CLI must be installed (`selftune` on PATH) before other commands
will work. Do not proceed with other commands until initialization is complete.

## Command Execution Policy

```bash
selftune <command> [options]
```

Commands vary in output format. `selftune orchestrate`, `selftune watch`, and
`selftune evolve --dry-run` emit structured JSON on stdout. `selftune status`,
`selftune last`, and `selftune doctor` print human-readable text with embedded
JSON. `selftune dashboard` starts a local SPA server — it does not emit data.

## Quick Reference

```bash
# Ingest group
selftune ingest claude   [--since DATE] [--dry-run] [--force] [--verbose]
selftune ingest codex                                                          # (experimental)
selftune ingest opencode                                                       # (experimental)
selftune ingest openclaw [--agents-dir PATH] [--since DATE] [--dry-run] [--force] [--verbose]  # (experimental)
selftune ingest wrap-codex -- <codex args>                                     # (experimental)

# Grade group
selftune grade auto      --skill <name> [--expectations "..."] [--agent <name>]
selftune grade baseline  --skill <name> --skill-path <path> [--eval-set <path>] [--agent <name>]

# Evolve group
selftune evolve          --skill <name> --skill-path <path> [--dry-run]
selftune evolve body     --skill <name> --skill-path <path> --target <body|routing> [--dry-run]
selftune evolve rollback --skill <name> --skill-path <path> [--proposal-id <id>]

# Eval group
selftune eval generate      --skill <name> [--list-skills] [--stats] [--max N] [--seed N] [--output PATH]
selftune eval unit-test      --skill <name> --tests <path> [--run-agent] [--generate]
selftune eval import         --dir <path> --skill <name> --output <path> [--match-strategy exact|fuzzy]
selftune eval composability  --skill <name> [--window N] [--telemetry-log <path>]

# Other commands
selftune watch    --skill <name> --skill-path <path> [--auto-rollback]
selftune status
selftune last
selftune doctor
selftune dashboard [--port <port>] [--no-open]
selftune contribute [--skill NAME] [--preview] [--sanitize LEVEL] [--submit]
selftune cron setup [--dry-run]                         # auto-detect platform (cron/launchd/systemd)
selftune cron setup --platform openclaw [--dry-run] [--tz <timezone>]  # OpenClaw-specific
selftune cron list
selftune cron remove [--dry-run]
selftune telemetry [status|enable|disable]
selftune export    [TABLE...] [--output/-o DIR] [--since DATE]
```

## Workflow Routing

| Trigger keywords | Workflow | File |
|------------------|----------|------|
| grade, score, evaluate, assess session, auto-grade | Grade | Workflows/Grade.md |
| evals, eval set, undertriggering, skill stats, eval generate | Evals | Workflows/Evals.md |
| evolve, improve, optimize skills, make skills better, triggers, catch more queries | Evolve | Workflows/Evolve.md |
| evolve body, evolve routing, full body evolution, rewrite skill, teacher student | EvolveBody | Workflows/EvolveBody.md |
| evolve rollback, undo, restore, revert evolution, go back, undo last change | Rollback | Workflows/Rollback.md |
| watch, monitor, regression, post-deploy, keep an eye on | Watch | Workflows/Watch.md |
| doctor, health, hooks, broken, diagnose, not working, something wrong | Doctor | Workflows/Doctor.md |
| ingest, import, codex logs, opencode, openclaw, wrap codex | Ingest | Workflows/Ingest.md |
| replay, backfill, claude transcripts, historical sessions | Replay | Workflows/Replay.md |
| contribute, share, community, export data, anonymized, give back | Contribute | Workflows/Contribute.md |
| init, setup, set up, bootstrap, first time, install, configure selftune | Initialize | Workflows/Initialize.md |
| cron, schedule, autonomous, automate evolution, run automatically | Cron | Workflows/Cron.md |
| auto-activate, suggestions, activation rules, nag, why suggest | AutoActivation | Workflows/AutoActivation.md |
| dashboard, visual, open dashboard, show dashboard, serve dashboard, live dashboard | Dashboard | Workflows/Dashboard.md |
| evolution memory, session continuity, what happened last | EvolutionMemory | Workflows/EvolutionMemory.md |
| grade baseline, baseline lift, adds value, skill value, no-skill comparison | Baseline | Workflows/Baseline.md |
| eval unit-test, skill test, test skill, generate tests, run tests | UnitTest | Workflows/UnitTest.md |
| eval composability, co-occurrence, skill conflicts, skills together | Composability | Workflows/Composability.md |
| eval import, skillsbench, external evals, benchmark tasks | ImportSkillsBench | Workflows/ImportSkillsBench.md |
| telemetry, analytics, disable analytics, opt out, tracking, privacy | Telemetry | Workflows/Telemetry.md |
| orchestrate, autonomous, full loop, improve all skills, run selftune loop | Orchestrate | Workflows/Orchestrate.md |
| sync, refresh, replay, source truth, rescan sessions | Sync | Workflows/Sync.md |
| badge, readme badge, skill badge, health badge | Badge | Workflows/Badge.md |
| workflows, discover workflows, list workflows, multi-skill workflows | Workflows | Workflows/Workflows.md |
| export, dump, jsonl, export sqlite, debug export | Export | *(direct command — no workflow file)* |
| status, health summary, skill health, how are skills, skills doing, run selftune | Status | *(direct command — no workflow file)* |
| last, last session, recent session, what happened, what changed | Last | *(direct command — no workflow file)* |

Workflows Grade, Evolve, Watch, and Ingest also run autonomously via `selftune orchestrate`.

## Interactive Configuration

Before running mutating workflows (evolve, evolve-body, evals, baseline), consult
`references/interactive-config.md` for the pre-flight configuration pattern, model
tier reference, and quick-path rules.

## The Feedback Loop

The core idea: observe how users actually talk, find where skills miss, propose
better descriptions, validate them, and deploy — with automatic rollback if things
get worse. Every step produces evidence so you can explain *why* a change was made.

```text
Observe --> Detect --> Diagnose --> Propose --> Validate --> Audit --> Deploy --> Watch --> Rollback
   |                                                                    |
   +--------------------------------------------------------------------+
```

1. **Observe** — Hooks capture every session (queries, triggers, metrics)
2. **Detect** — `selftune eval generate` extracts missed-trigger patterns
3. **Diagnose** — `selftune grade` evaluates session quality with evidence
4. **Propose** — `selftune evolve` generates description improvements
5. **Validate** — Evolution is tested against the eval set before deploying
6. **Audit** — Persist proposal, evidence, and decision metadata for traceability
7. **Deploy** — Updated description replaces the original (backup kept)
8. **Watch** — `selftune watch` monitors for regressions post-deploy
9. **Rollback** — `selftune evolve rollback` restores previous version if needed

## Specialized Agents

selftune bundles focused agents in `agents/`. When you need deeper analysis,
read the relevant agent file and follow its instructions — either inline or
by spawning a subagent with those instructions as its prompt.

| Trigger keywords | Agent file | When to use |
|------------------|-----------|-------------|
| diagnose, root cause, why failing, debug performance | `agents/diagnosis-analyst.md` | After doctor finds persistent issues or grades are consistently low |
| patterns, conflicts, cross-skill, overlap, optimize skills | `agents/pattern-analyst.md` | When composability scores indicate moderate-to-severe conflicts |
| review evolution, check proposal, safe to deploy | `agents/evolution-reviewer.md` | Before deploying high-stakes or low-confidence proposals |
| set up selftune, integrate, configure project | `agents/integration-guide.md` | For complex project structures (monorepo, multi-skill, mixed platforms) |

## Examples

### Scenario 1: First-time setup

User says: "Set up selftune" or "Install selftune"

Actions:
1. Read `Workflows/Initialize.md`
2. Run `selftune init` to bootstrap config (hooks are installed automatically)
3. Run `selftune doctor` to verify

Result: Config at `~/.selftune/config.json`, hooks active, ready for session capture.

### Scenario 2: Improve a skill

User says: "Make the pptx skill catch more queries" or "Evolve the Research skill"

Actions:
1. `selftune eval generate --skill pptx` to find missed triggers
2. `selftune evolve --skill pptx --skill-path <path>` to propose changes
3. `selftune watch --skill pptx --skill-path <path>` to monitor post-deploy

Result: Skill description updated to match real user language, with rollback available.

### Scenario 3: Check skill health

User says: "How are my skills doing?" or "Run selftune"

Actions:
1. `selftune status` for overall health summary
2. `selftune last` for most recent session insight
3. `selftune doctor` if issues detected

Result: Pass rates, trend data, and actionable recommendations.

### Scenario 4: Autonomous operation

User says: "Set up cron jobs" or "Run selftune automatically"

Actions:
1. `selftune cron setup` to install OS-level scheduling
2. Orchestrate loop runs: ingest → grade → evolve → watch

Result: Skills improve continuously without manual intervention.

## Troubleshooting

### CLI not found

Error: `command not found: selftune`

Cause: CLI not installed or not on PATH.

Solution:
1. Run `npm install -g selftune` or check `bin/selftune.cjs` exists
2. Verify with `which selftune`
3. If using bun: `bun link` in the repo root

### No sessions to grade

Error: `selftune grade` returns empty results.

Cause: Hooks not capturing sessions, or no sessions since last ingest.

Solution:
1. Run `selftune doctor` to verify hook installation
2. Run `selftune ingest claude --force` to re-ingest
3. Check `~/.claude/` for telemetry JSONL files

### Evolution proposes no changes

Cause: Eval set too small or skill already well-tuned.

Solution:
1. Run `selftune eval generate --skill <name> --max 50` for a larger eval set
2. Check `selftune status` — if pass rate is >90%, evolution may not be needed
3. Try `selftune evolve body` for deeper structural changes

### Dashboard won't serve

Error: Port already in use or blank page.

Solution:
1. Try a different port: `selftune dashboard --port 3142`
2. Check if another process holds the port: `lsof -i :3141`
3. Use `--no-open` to start the server without opening a browser

## Negative Examples

These should NOT trigger selftune — note that several are near-misses that
share keywords but need different solutions:

- "Fix this React hydration bug" — general debugging, not skill improvement
- "Create a PowerPoint about Q3 results" — this is pptx skill, not selftune
- "Run my unit tests" — project tests, not skill eval tests (even though selftune has "eval unit-test", this is about *project* tests)
- "How do I use the Research skill?" — skill *usage*, not skill *improvement* (route to the Research skill itself)
- "Generate a report from this data" — content generation, not skill evolution
- "My build is failing" — project issue, not selftune health issue (even though "failing" overlaps with skill diagnostics language)
- "Evaluate this code for security issues" — "evaluate" here means code review, not session grading
- "Improve this function's performance" — code optimization, not skill optimization (even though "improve" and "performance" are selftune keywords)

The key distinction: selftune is about improving *skills themselves* (their
descriptions, triggers, and execution quality). If the user is trying to
accomplish a task *using* a skill, route to that skill instead.

## Resource Index

| Resource | Purpose | When to read |
|----------|---------|--------------|
| `SKILL.md` | This file — routing, triggers, quick reference | Always loaded |
| `Workflows/*.md` | Step-by-step instructions for each workflow | When routing to a workflow |
| `agents/diagnosis-analyst.md` | Deep-dive skill failure analysis | Spawn when doctor/grades show persistent issues |
| `agents/pattern-analyst.md` | Cross-skill conflict detection | Spawn when composability flags conflicts |
| `agents/evolution-reviewer.md` | Safety gate for evolution proposals | Spawn before deploying high-stakes evolutions |
| `agents/integration-guide.md` | Guided setup for complex projects | Spawn for monorepos, multi-skill setups |
| `references/logs.md` | Log file formats (telemetry, usage, queries, audit) | When parsing or debugging log files |
| `references/grading-methodology.md` | 3-tier grading model, evidence standards | When grading sessions or interpreting grades |
| `references/invocation-taxonomy.md` | 4 invocation types, coverage analysis | When analyzing trigger coverage |
| `references/interactive-config.md` | Pre-flight config pattern, model tiers | Before running mutating workflows |
| `references/setup-patterns.md` | Platform-specific setup patterns | During complex setup scenarios |
| `settings_snippet.json` | Claude Code hook configuration template | During initialization |
| `assets/*.json` | Config templates (activation rules, settings) | During initialization |
