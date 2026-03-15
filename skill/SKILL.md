---
name: selftune
description: >
  Observe agent-skill usage, generate evals, grade sessions, evolve SKILL.md
  descriptions or bodies, monitor regressions, ingest telemetry, and analyze
  cross-skill interactions. Use when the user wants help with selftune,
  skill observability, routing, evolution, workflow discovery, or telemetry.
compatibility: >
  Designed for Claude Code, Codex, OpenCode, and OpenClaw with the selftune CLI
  available on PATH. Setup flows read local files under ~/.selftune/ and may
  optionally integrate with ~/.claude/settings.json.
metadata:
  version: "0.2.2"
  last_updated: "2026-03-15"
---

# selftune

Observe real agent sessions, detect missed triggers, grade execution quality,
and evolve skill descriptions toward the language real users actually use.

## Bootstrap

If `~/.selftune/config.json` does not exist, read `Workflows/Initialize.md`
first. The CLI must be installed (`selftune` on PATH) before other commands
will work. Do not proceed with other commands until initialization is complete.
For most users, initialization should end with the autonomous scheduler enabled.

## Command Execution Policy

```bash
selftune <command> [options]
```

Most commands output deterministic JSON. Parse JSON output for machine-readable commands.
`selftune dashboard` is an exception: it starts a local SPA server and may print
informational progress lines.

## Quick Reference

```bash
selftune grade    --skill <name> [--expectations "..."] [--agent <name>]
selftune evals    --skill <name> [--list-skills] [--stats] [--max N]
selftune evolve   --skill <name> --skill-path <path> [--dry-run]
selftune orchestrate [--dry-run] [--review-required] [--max-skills N] [--skill <name>]
selftune rollback --skill <name> --skill-path <path> [--proposal-id <id>]
selftune watch    --skill <name> --skill-path <path> [--auto-rollback]
selftune status
selftune last
selftune doctor
selftune dashboard [--port <port>] [--no-open]
selftune ingest-codex
selftune ingest-opencode
selftune ingest-openclaw [--agents-dir PATH] [--since DATE] [--dry-run] [--force] [--verbose]
selftune wrap-codex -- <codex args>
selftune replay     [--since DATE] [--dry-run] [--force] [--verbose]
selftune sync       [--since DATE] [--dry-run] [--force]
selftune schedule   [--format <cron|launchd|systemd>] [--install] [--dry-run]
selftune contribute [--skill NAME] [--preview] [--sanitize LEVEL] [--submit]
selftune cron setup [--dry-run] [--tz <timezone>]
selftune cron list
selftune cron remove [--dry-run]
selftune evolve-body --skill <name> --skill-path <path> --target <routing_table|full_body> [--dry-run]
selftune baseline   --skill <name> --skill-path <path> [--eval-set <path>] [--agent <name>]
selftune badge      --skill <name> [--format svg|markdown|url] [--output <path>]
selftune unit-test  --skill <name> --tests <path> [--run-agent] [--generate]
selftune composability --skill <name> [--window N] [--telemetry-log <path>]
selftune workflows [--skill <name>] [--min-occurrences N] [--window N] [save <workflow-id|index>]
selftune import-skillsbench --dir <path> --skill <name> --output <path> [--match-strategy exact|fuzzy]
selftune export-canonical [--out FILE] [--pretty] [--platform <name>] [--record-kind <kind>]
```

## Workflow Routing

| Trigger keywords | Workflow | File |
|------------------|----------|------|
| grade, score, evaluate, assess session | Grade | Workflows/Grade.md |
| evals, eval set, undertriggering, skill stats | Evals | Workflows/Evals.md |
| evolve, improve, triggers, catch more queries | Evolve | Workflows/Evolve.md |
| orchestrate, autonomous loop, run the loop, auto improve, self-improving | Orchestrate | Workflows/Orchestrate.md |
| rollback, undo, restore, revert evolution | Rollback | Workflows/Rollback.md |
| watch, monitor, regression, post-deploy, performing | Watch | Workflows/Watch.md |
| doctor, health, hooks, broken, diagnose | Doctor | Workflows/Doctor.md |
| ingest, import, codex logs, opencode, openclaw, wrap codex | Ingest | Workflows/Ingest.md |
| replay, backfill, claude transcripts, historical sessions | Replay | Workflows/Replay.md |
| sync, source truth, rebuild repaired overlay, rebuild telemetry, refresh logs | Sync | Workflows/Sync.md |
| contribute, share, community, export data, anonymized | Contribute | Workflows/Contribute.md |
| init, setup, bootstrap, first time | Initialize | Workflows/Initialize.md |
| schedule, launchd, systemd, crontab, install scheduler | Schedule | Workflows/Schedule.md |
| cron, openclaw scheduler, openclaw jobs | Cron | Workflows/Cron.md |
| auto-activate, suggestions, activation rules, nag, why suggest | AutoActivation | Workflows/AutoActivation.md |
| dashboard, visual, open dashboard, skill grid, serve dashboard, live dashboard | Dashboard | Workflows/Dashboard.md |
| evolution memory, context memory, session continuity, what happened last | EvolutionMemory | Workflows/EvolutionMemory.md |
| evolve body, evolve routing, full body evolution, rewrite skill, teacher student | EvolveBody | Workflows/EvolveBody.md |
| baseline, baseline lift, adds value, skill value, no-skill comparison | Baseline | Workflows/Baseline.md |
| badge, badge svg, badge markdown, shields, health badge | Badge | Workflows/Badge.md |
| unit test, skill test, test skill, generate tests, run tests, assertions | UnitTest | Workflows/UnitTest.md |
| composability, co-occurrence, synergy, workflow candidate, skill conflicts, skills together | Composability | Workflows/Composability.md |
| workflow, workflows, multi-skill sequence, chain skills, save workflow, codify workflow | Workflows | Workflows/Workflows.md |
| import skillsbench, skillsbench, external evals, benchmark tasks, import corpus | ImportSkillsBench | Workflows/ImportSkillsBench.md |
| export canonical, export-canonical, export canonical telemetry | ExportCanonical | *(direct command — no workflow file)* |
| status, health summary, skill health, pass rates, how are skills | Status | *(direct command — no workflow file)* |
| last, last session, recent session, what happened | Last | *(direct command — no workflow file)* |

## Interactive Configuration

Before running mutating workflows (evolve, evolve-body, evals, baseline), present
a pre-flight configuration prompt to the user. This gives them control over
execution mode, model selection, and key parameters.

### Pre-Flight Pattern

Each mutating workflow has a **Pre-Flight Configuration** step. Follow this pattern:

1. Present a summary of what the command will do
2. Show numbered options with `(recommended)` markers for suggested defaults
3. Ask the user to pick options or say "use defaults" / "go with defaults"
4. Show a confirmation summary of selected options before executing

### Model Tier Reference

When presenting model choices, use this table:

| Tier | Model | Speed | Cost | Quality | Best for |
|------|-------|-------|------|---------|----------|
| Fast | `haiku` | ~2s/call | $ | Good | Iteration loops, bulk validation |
| Balanced | `sonnet` | ~5s/call | $$ | Great | Single-pass proposals, gate checks |
| Best | `opus` | ~10s/call | $$$ | Excellent | High-stakes final validation |

### Quick Path

If the user says "use defaults", "just do it", or similar — skip the pre-flight
and run with recommended defaults. The pre-flight is for users who want control,
not a mandatory gate.

### Workflows That Skip Pre-Flight

These read-only or simple workflows run immediately without prompting:
`status`, `last`, `doctor`, `dashboard`, `watch`, `rollback`, `grade`,
`ingest-*`, `replay`, `contribute`, `cron`, `badge`, `composability`, `workflows`, `unit-test`,
`import-skillsbench`.

## The Feedback Loop

```
Observe --> Detect --> Diagnose --> Propose --> Validate --> Deploy --> Watch
   |                                                                    |
   +--------------------------------------------------------------------+
```

1. **Observe** -- source-truth transcripts and telemetry are replayed into the shared logs
2. **Detect** -- `sync`, `status`, and `evals` surface missed triggers and weak routing
3. **Diagnose** -- `grade` evaluates session quality with evidence
4. **Propose** -- `evolve` generates low-risk description improvements
5. **Validate** -- proposals are checked before deploy
6. **Deploy** -- validated descriptions can ship autonomously
7. **Watch** -- `watch` monitors recent changes and rolls back regressions

## Resource Index

| Resource | Purpose |
|----------|---------|
| `SKILL.md` | This file -- routing, triggers, quick reference |
| `references/logs.md` | Log file formats (telemetry, usage, queries, audit) |
| `references/grading-methodology.md` | 3-tier grading model, evidence standards, grading.json schema |
| `references/invocation-taxonomy.md` | 4 invocation types, coverage analysis, evolution connection |
| `references/setup-patterns.md` | Portable setup guidance for single-skill, multi-skill, and mixed-agent installs |
| `references/version-history.md` | Maintainer-facing skill version history and document change log |
| `assets/single-skill-settings.json` | Claude settings template for single-skill projects |
| `assets/multi-skill-settings.json` | Claude settings template for multi-skill projects |
| `assets/activation-rules-default.json` | Default activation-rules template copied into `~/.selftune/` |
| `settings_snippet.json` | Claude Code hook configuration template |
| `Workflows/Initialize.md` | First-time setup and config bootstrap |
| `Workflows/Grade.md` | Grade a session with expectations and evidence |
| `Workflows/Evals.md` | Generate eval sets, list skills, show stats |
| `Workflows/Evolve.md` | Evolve a skill description from failure patterns |
| `Workflows/Orchestrate.md` | Run the autonomy-first sync → evolve → watch loop |
| `Workflows/Rollback.md` | Undo an evolution, restore previous description |
| `Workflows/Watch.md` | Post-deploy regression monitoring |
| `Workflows/Doctor.md` | Health checks on logs, hooks, schema |
| `Workflows/Ingest.md` | Import sessions from Codex, OpenCode, and OpenClaw |
| `Workflows/Replay.md` | Backfill logs from Claude Code transcripts |
| `Workflows/Sync.md` | Source-truth sync across supported agents + repaired overlay rebuild |
| `Workflows/Contribute.md` | Export anonymized data for community contribution |
| `Workflows/Schedule.md` | Install platform-native scheduling for the autonomous loop |
| `Workflows/Cron.md` | Manage OpenClaw cron jobs for autonomous evolution |
| `Workflows/AutoActivation.md` | Auto-activation hook behavior and rules |
| `Workflows/Dashboard.md` | Run the SPA dashboard and per-skill report views |
| `Workflows/EvolutionMemory.md` | Evolution memory system for session continuity |
| `Workflows/EvolveBody.md` | Full body and routing table evolution |
| `Workflows/Baseline.md` | No-skill baseline comparison and lift measurement |
| `Workflows/Badge.md` | Generate skill-health badges for README or dashboard use |
| `Workflows/UnitTest.md` | Skill-level unit test runner and generator |
| `Workflows/Composability.md` | Multi-skill synergy and conflict analysis |
| `Workflows/Workflows.md` | Discover and codify repeated multi-skill workflows |
| `Workflows/ImportSkillsBench.md` | SkillsBench task corpus importer |

## Optional Repo Extensions

Some repository setups also bundle Claude-specific specialist agents for
diagnosis, pattern analysis, evolution review, and interactive setup. Treat
these as optional extensions rather than part of the core installed skill.
Do not assume they are present unless the current workspace already includes
them.

## Examples

- "Grade my last pptx session"
- "What skills are undertriggering?"
- "Generate evals for the pptx skill"
- "Evolve the pptx skill to catch more queries"
- "Run the autonomous selftune loop"
- "Rollback the last evolution"
- "Is the skill performing well after the change?"
- "Check selftune health"
- "Ingest my codex logs"
- "Show me skill stats"
- "How are my skills performing?"
- "What happened in my last session?"
- "Open the selftune dashboard"
- "Serve the dashboard at http://localhost:3141"
- "Show skill health status"
- "Generate a badge for my skill health"
- "Give me markdown for a selftune badge"
- "Replay my Claude Code transcripts"
- "Backfill logs from historical sessions"
- "Sync source-truth telemetry before I trust the dashboard"
- "Rebuild the repaired skill overlay"
- "Contribute my selftune data to the community"
- "Share anonymized skill data"
- "Install autonomous scheduling for this machine"
- "Set up OpenClaw cron jobs for selftune"
- "Ingest my OpenClaw sessions"
- "Why is selftune suggesting things?"
- "Customize activation rules"
- "Start the live dashboard"
- "Serve the dashboard on port 8080"
- "What happened in the last evolution?"
- "Read the evolution memory"
- "Why is this skill underperforming?"
- "Are there conflicts between my skills?"
- "Which skills always get used together?"
- "Save this discovered workflow into SKILL.md"
- "Review this evolution before deploying"
- "Set up selftune for my project"
- "Evolve the full body of the Research skill"
- "Rewrite the routing table for pptx"
- "Does this skill add value over no-skill baseline?"
- "Measure baseline lift for the Research skill"
- "Generate unit tests for the pptx skill"
- "Run skill unit tests"
- "Which skills conflict with each other?"
- "Analyze composability for the Research skill"
- "Import SkillsBench tasks for my skill"

## Negative Examples

These should NOT trigger selftune:

- "Fix this React hydration bug"
- "Create a PowerPoint about Q3 results" (this is pptx, not selftune)
- "Run my unit tests"
- "What does this error mean?"

Route to other skills or general workflows unless the user explicitly
asks about grading, evals, evolution, monitoring, or skill observability.
