---
name: selftune
description: >
  Self-improving skills toolkit. Use when the user wants to:
  grade a session, generate evals, check undertriggering, evolve a skill
  description or full body, evolve routing tables, rollback an evolution,
  monitor post-deploy performance, check skill health status, view last
  session insight, open the dashboard, serve the live dashboard, run health
  checks, manage activation rules, ingest sessions from Codex/OpenCode/OpenClaw,
  replay Claude Code transcripts, contribute anonymized data to the community,
  set up autonomous cron jobs, manage evolution memory, configure auto-activation
  suggestions, diagnose underperforming skills, analyze cross-skill patterns,
  review evolution proposals, measure baseline lift, run skill unit tests,
  analyze skill composability, or import SkillsBench evaluation corpora.
---

# selftune

Observe real agent sessions, detect missed triggers, grade execution quality,
and evolve skill descriptions toward the language real users actually use.

**You are the operator.** The user installed this skill so YOU can manage their
skill health autonomously. They will say things like "set up selftune",
"improve my skills", or "how are my skills doing?" — and you route to the
correct workflow below. The user does not run CLI commands directly; you do.

## Bootstrap

If `~/.selftune/config.json` does not exist, read `Workflows/Initialize.md`
first. The CLI must be installed (`selftune` on PATH) before other commands
will work. Do not proceed with other commands until initialization is complete.

## Command Execution Policy

```bash
selftune <command> [options]
```

Most commands output deterministic JSON. Parse JSON output for machine-readable commands.
`selftune dashboard` is an exception: `--export` generates an HTML artifact, while
`--serve` starts a local server; both may print informational progress lines.

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
selftune evolve body     --skill <name> --skill-path <path> --target <routing_table|full_body> [--dry-run]
selftune evolve rollback --skill <name> --skill-path <path> [--proposal-id <id>]

# Eval group
selftune eval generate      --skill <name> [--list-skills] [--stats] [--max N]
selftune eval unit-test      --skill <name> --tests <path> [--run-agent] [--generate]
selftune eval import         --dir <path> --skill <name> --output <path> [--match-strategy exact|fuzzy]
selftune eval composability  --skill <name> [--window N] [--telemetry-log <path>]

# Other commands
selftune watch    --skill <name> --skill-path <path> [--auto-rollback]
selftune status
selftune last
selftune doctor
selftune dashboard [--export] [--out FILE] [--serve]
selftune dashboard --serve [--port <port>]
selftune contribute [--skill NAME] [--preview] [--sanitize LEVEL] [--submit]
selftune cron setup [--dry-run]                         # auto-detect platform (cron/launchd/systemd)
selftune cron setup --platform openclaw [--dry-run] [--tz <timezone>]  # OpenClaw-specific
selftune cron list
selftune cron remove [--dry-run]
selftune telemetry [status|enable|disable]
```

## Workflow Routing

| Trigger keywords | Workflow | File |
|------------------|----------|------|
| grade, score, evaluate, assess session, auto-grade | Grade † | Workflows/Grade.md |
| evals, eval set, undertriggering, skill stats, eval generate | Evals | Workflows/Evals.md |
| evolve, improve, optimize skills, make skills better, triggers, catch more queries | Evolve † | Workflows/Evolve.md |
| evolve rollback, undo, restore, revert evolution, go back, undo last change | Rollback | Workflows/Rollback.md |
| watch, monitor, regression, post-deploy, performing, keep an eye on | Watch † | Workflows/Watch.md |
| doctor, health, hooks, broken, diagnose, not working, something wrong | Doctor | Workflows/Doctor.md |
| ingest, import, codex logs, opencode, openclaw, wrap codex, ingest claude | Ingest † | Workflows/Ingest.md |
| ingest claude, backfill, claude transcripts, historical sessions | Replay | Workflows/Replay.md |
| contribute, share, community, export data, anonymized, give back, help others | Contribute | Workflows/Contribute.md |
| init, setup, set up, bootstrap, first time, install, configure selftune | Initialize | Workflows/Initialize.md |
| cron, schedule, autonomous, automate evolution, run automatically, run on its own | Cron | Workflows/Cron.md |
| auto-activate, suggestions, activation rules, nag, why suggest | AutoActivation | Workflows/AutoActivation.md |
| dashboard, visual, open dashboard, show dashboard, skill grid, serve dashboard, live dashboard | Dashboard | Workflows/Dashboard.md |
| evolution memory, context memory, session continuity, what happened last | EvolutionMemory | Workflows/EvolutionMemory.md |
| evolve body, evolve routing, full body evolution, rewrite skill, teacher student | EvolveBody | Workflows/EvolveBody.md |
| grade baseline, baseline lift, adds value, skill value, no-skill comparison | Baseline | Workflows/Baseline.md |
| eval unit-test, skill test, test skill, generate tests, run tests, assertions | UnitTest | Workflows/UnitTest.md |
| eval composability, co-occurrence, skill conflicts, skills together, conflict score | Composability | Workflows/Composability.md |
| eval import, skillsbench, external evals, benchmark tasks, import corpus | ImportSkillsBench | Workflows/ImportSkillsBench.md |
| telemetry, analytics, disable analytics, opt out, usage data, tracking, privacy | Telemetry | Workflows/Telemetry.md |
| status, health summary, skill health, pass rates, how are skills, skills working, skills doing, run selftune, start selftune | Status | *(direct command — no workflow file)* |
| last, last session, recent session, what happened, what changed, what did selftune do | Last | *(direct command — no workflow file)* |

Workflows marked with † also run autonomously via `selftune orchestrate` without user interaction.

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
`status`, `last`, `doctor`, `dashboard`, `watch`, `evolve rollback`,
`grade auto`, `ingest *`, `contribute`, `cron`, `eval composability`,
`eval unit-test`, `eval import`.

## The Feedback Loop

```text
Observe --> Detect --> Diagnose --> Propose --> Validate --> Audit --> Deploy --> Watch --> Rollback
   |                                                                    |
   +--------------------------------------------------------------------+
```

1. **Observe** -- Hooks capture every session (queries, triggers, metrics)
2. **Detect** -- `selftune eval generate` extracts missed-trigger patterns across invocation types
3. **Diagnose** -- `selftune grade` evaluates session quality with evidence
4. **Propose** -- `selftune evolve` generates description improvements
5. **Validate** -- Evolution is tested against the eval set
6. **Audit** -- Persist proposal, evidence, and decision metadata for traceability
7. **Deploy** -- Updated description replaces the original (with backup)
8. **Watch** -- `selftune watch` monitors for regressions post-deploy
9. **Rollback** -- `selftune evolve rollback` restores the previous version when regressions are detected

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
| `Workflows/Cron.md` | Scheduling & automation (cron/launchd/systemd/OpenClaw) |
| `Workflows/AutoActivation.md` | Auto-activation hook behavior and rules |
| `Workflows/Dashboard.md` | Dashboard modes: static, export, live server |
| `Workflows/EvolutionMemory.md` | Evolution memory system for session continuity |
| `Workflows/EvolveBody.md` | Full body and routing table evolution |
| `Workflows/Baseline.md` | No-skill baseline comparison and lift measurement |
| `Workflows/UnitTest.md` | Skill-level unit test runner and generator |
| `Workflows/Composability.md` | Multi-skill co-occurrence conflict analysis |
| `Workflows/ImportSkillsBench.md` | SkillsBench task corpus importer |

## Specialized Agents

selftune provides focused agents for deeper analysis. These live in
`.claude/agents/` and can be spawned as subagents for specialized tasks.

| Trigger keywords | Agent | Purpose | When to spawn |
|------------------|-------|---------|---------------|
| diagnose, root cause, why failing, skill failure, debug performance | diagnosis-analyst | Deep-dive analysis of underperforming skills | After doctor finds persistent issues, grades are consistently low, or status shows CRITICAL/WARNING |
| patterns, conflicts, cross-skill, overlap, trigger conflicts, optimize skills | pattern-analyst | Cross-skill pattern analysis and conflict detection | When user asks about cross-skill conflicts or composability scores indicate moderate-to-severe conflicts |
| review evolution, check proposal, safe to deploy, approve evolution | evolution-reviewer | Safety gate review of pending evolution proposals | Before deploying an evolution in interactive mode, especially for high-stakes or low-confidence proposals |
| set up selftune, integrate, configure project, install selftune | integration-guide | Guided interactive setup for specific project types | For complex project structures (monorepo, multi-skill, mixed agent platforms) |

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
- "Evolve the full body of the Research skill"
- "Rewrite the routing table for pptx"
- "Does this skill add value over no-skill baseline?"
- "Measure baseline lift for the Research skill"
- "Generate unit tests for the pptx skill"
- "Run skill unit tests"
- "Which skills conflict with each other?"
- "Analyze composability for the Research skill"
- "Import SkillsBench tasks for my skill"
- "Install selftune"
- "Configure selftune for this project"
- "Make my skills better"
- "Optimize my skills"
- "Are my skills working?"
- "Show me the dashboard"
- "What changed since last time?"
- "What did selftune do?"
- "Run selftune"
- "Start selftune"
- "Go back to the previous version"
- "Undo the last change"

## Negative Examples

These should NOT trigger selftune:

- "Fix this React hydration bug"
- "Create a PowerPoint about Q3 results" (this is pptx, not selftune)
- "Run my unit tests"
- "What does this error mean?"

Route to other skills or general workflows unless the user explicitly
asks about grading, evals, evolution, monitoring, or skill observability.
