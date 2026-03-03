---
name: selftune
description: >
  Skill observability and continuous improvement. Use when the user wants to:
  grade a session, generate evals, check undertriggering, evolve a skill
  description, rollback an evolution, monitor post-deploy performance, check
  skill health status, view last session insight, open the dashboard, serve
  the live dashboard, run health checks, manage activation rules, ingest
  sessions from Codex/OpenCode/OpenClaw, replay Claude Code transcripts,
  contribute anonymized data to the community, set up autonomous cron jobs,
  manage evolution memory, configure auto-activation suggestions, diagnose
  underperforming skills, analyze cross-skill patterns, or review evolution
  proposals.
---

# selftune

Observe real agent sessions, detect missed triggers, grade execution quality,
and evolve skill descriptions toward the language real users actually use.

## Bootstrap

If `~/.selftune/config.json` does not exist, read `Workflows/Initialize.md`
first. The CLI must be installed (`selftune` on PATH) before other commands
will work. Do not proceed with other commands until initialization is complete.

## Command Execution Policy

```bash
selftune <command> [options]
```

Most commands output deterministic JSON. Parse JSON output for machine-readable commands.
`selftune dashboard` is an exception: it generates an HTML artifact and may print
informational progress lines.

## Quick Reference

```bash
selftune grade    --skill <name> [--expectations "..."] [--agent <name>]
selftune evals    --skill <name> [--list-skills] [--stats] [--max N]
selftune evolve   --skill <name> --skill-path <path> [--dry-run]
selftune rollback --skill <name> --skill-path <path> [--proposal-id <id>]
selftune watch    --skill <name> --skill-path <path> [--auto-rollback]
selftune status
selftune last
selftune doctor
selftune dashboard [--export] [--out FILE] [--serve]
selftune ingest-codex
selftune ingest-opencode
selftune ingest-openclaw [--agents-dir PATH] [--since DATE] [--dry-run] [--force] [--verbose]
selftune wrap-codex -- <codex args>
selftune replay     [--since DATE] [--dry-run] [--force] [--verbose]
selftune contribute [--skill NAME] [--preview] [--sanitize LEVEL] [--submit]
selftune cron setup [--dry-run] [--tz <timezone>]
selftune cron list
selftune cron remove [--dry-run]
selftune dashboard --serve [--port <port>]
```

## Workflow Routing

| Trigger keywords | Workflow | File |
|------------------|----------|------|
| grade, score, evaluate, assess session | Grade | Workflows/Grade.md |
| evals, eval set, undertriggering, skill stats | Evals | Workflows/Evals.md |
| evolve, improve, triggers, catch more queries | Evolve | Workflows/Evolve.md |
| rollback, undo, restore, revert evolution | Rollback | Workflows/Rollback.md |
| watch, monitor, regression, post-deploy, performing | Watch | Workflows/Watch.md |
| doctor, health, hooks, broken, diagnose | Doctor | Workflows/Doctor.md |
| ingest, import, codex logs, opencode, openclaw, wrap codex | Ingest | Workflows/Ingest.md |
| replay, backfill, claude transcripts, historical sessions | Replay | Workflows/Replay.md |
| contribute, share, community, export data, anonymized | Contribute | Workflows/Contribute.md |
| init, setup, bootstrap, first time | Initialize | Workflows/Initialize.md |
| cron, schedule, autonomous, automate evolution | Cron | Workflows/Cron.md |
| auto-activate, suggestions, activation rules, nag, why suggest | AutoActivation | Workflows/AutoActivation.md |
| dashboard, visual, open dashboard, skill grid, serve dashboard, live dashboard | Dashboard | Workflows/Dashboard.md |
| evolution memory, context memory, session continuity, what happened last | EvolutionMemory | Workflows/EvolutionMemory.md |
| status, health summary, skill health, pass rates, how are skills | Status | *(direct command — no workflow file)* |
| last, last session, recent session, what happened | Last | *(direct command — no workflow file)* |

## The Feedback Loop

```
Observe --> Detect --> Diagnose --> Propose --> Validate --> Deploy --> Watch
   |                                                                    |
   +--------------------------------------------------------------------+
```

1. **Observe** -- Hooks capture every session (queries, triggers, metrics)
2. **Detect** -- `evals` finds missed triggers across invocation types
3. **Diagnose** -- `grade` evaluates session quality with evidence
4. **Propose** -- `evolve` generates description improvements
5. **Validate** -- Evolution is tested against the eval set
6. **Deploy** -- Updated description replaces the original (with backup)
7. **Watch** -- `watch` monitors for regressions post-deploy

## Resource Index

| Resource | Purpose |
|----------|---------|
| `SKILL.md` | This file -- routing, triggers, quick reference |
| `references/logs.md` | Log file formats (telemetry, usage, queries, audit) |
| `references/grading-methodology.md` | 3-tier grading model, evidence standards, grading.json schema |
| `references/invocation-taxonomy.md` | 4 invocation types, coverage analysis, evolution connection |
| `settings_snippet.json` | Claude Code hook configuration template |
| `Workflows/Initialize.md` | First-time setup and config bootstrap |
| `Workflows/Grade.md` | Grade a session with expectations and evidence |
| `Workflows/Evals.md` | Generate eval sets, list skills, show stats |
| `Workflows/Evolve.md` | Evolve a skill description from failure patterns |
| `Workflows/Rollback.md` | Undo an evolution, restore previous description |
| `Workflows/Watch.md` | Post-deploy regression monitoring |
| `Workflows/Doctor.md` | Health checks on logs, hooks, schema |
| `Workflows/Ingest.md` | Import sessions from Codex, OpenCode, and OpenClaw |
| `Workflows/Replay.md` | Backfill logs from Claude Code transcripts |
| `Workflows/Contribute.md` | Export anonymized data for community contribution |
| `Workflows/Cron.md` | Manage OpenClaw cron jobs for autonomous evolution |
| `Workflows/AutoActivation.md` | Auto-activation hook behavior and rules |
| `Workflows/Dashboard.md` | Dashboard modes: static, export, live server |
| `Workflows/EvolutionMemory.md` | Evolution memory system for session continuity |

## Specialized Agents

selftune provides focused agents for deeper analysis. These live in
`.claude/agents/` and can be spawned as subagents for specialized tasks.

| Trigger keywords | Agent | Purpose |
|------------------|-------|---------|
| diagnose, root cause, why failing, skill failure, debug performance | diagnosis-analyst | Deep-dive analysis of underperforming skills |
| patterns, conflicts, cross-skill, overlap, trigger conflicts, optimize skills | pattern-analyst | Cross-skill pattern analysis and conflict detection |
| review evolution, check proposal, safe to deploy, approve evolution | evolution-reviewer | Safety gate review of pending evolution proposals |
| set up selftune, integrate, configure project, install selftune | integration-guide | Guided interactive setup for specific project types |

## Examples

- "Grade my last pptx session"
- "What skills are undertriggering?"
- "Generate evals for the pptx skill"
- "Evolve the pptx skill to catch more queries"
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
- "Replay my Claude Code transcripts"
- "Backfill logs from historical sessions"
- "Contribute my selftune data to the community"
- "Share anonymized skill data"
- "Set up cron jobs for autonomous evolution"
- "Schedule selftune to run automatically"
- "Ingest my OpenClaw sessions"
- "Why is selftune suggesting things?"
- "Customize activation rules"
- "Start the live dashboard"
- "Serve the dashboard on port 8080"
- "What happened in the last evolution?"
- "Read the evolution memory"
- "Why is this skill underperforming?"
- "Are there conflicts between my skills?"
- "Review this evolution before deploying"
- "Set up selftune for my project"

## Negative Examples

These should NOT trigger selftune:

- "Fix this React hydration bug"
- "Create a PowerPoint about Q3 results" (this is pptx, not selftune)
- "Run my unit tests"
- "What does this error mean?"

Route to other skills or general workflows unless the user explicitly
asks about grading, evals, evolution, monitoring, or skill observability.
