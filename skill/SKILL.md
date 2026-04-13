---
name: selftune
description: >
  Self-improving skills toolkit that watches real agent sessions, detects missed
  triggers, grades execution quality, and evolves skill descriptions to match how
  users actually talk. Use when grading sessions, generating evals, evolving skill
  descriptions or routing tables, discovering reusable workflows, scaffolding new
  workflow skills, checking skill health, viewing the dashboard, ingesting sessions
  from other platforms, or running autonomous improvement loops.
  Make sure to use this skill whenever the user mentions skill improvement, skill
  performance, skill triggers, skill evolution, skill health, undertriggering,
  overtriggering, session grading, or wants to know how their skills are doing —
  even if they don't say "selftune" explicitly.
metadata:
  author: selftune-dev
  version: 0.2.26
  category: developer-tools
---

# selftune

Observe real agent sessions, detect missed triggers, grade execution quality,
evolve skill descriptions toward the language real users actually use, and
scaffold workflow skills from repeated telemetry patterns.

**You are the operator.** The user installed this skill so YOU can manage their
skill health autonomously. They will say things like "set up selftune",
"improve my skills", or "how are my skills doing?" — and you route to the
correct workflow below. The user does not run CLI commands directly; you do.

## Bootstrap

If `~/.selftune/config.json` does not exist, read `workflows/Initialize.md`
first. The CLI must be installed (`selftune` on PATH) before other commands
will work. Do not proceed with other commands until initialization is complete.

## Command Execution Policy

```bash
selftune <command> [options]
```

Commands vary in output format:

- **JSON by default:** `selftune doctor` and `selftune watch` emit structured JSON on stdout.
- **Text by default:** `selftune status`, `selftune last`, `selftune orchestrate`, and `selftune evolve` print human-readable text.
- **JSON opt-in:** `selftune sync --json` enables structured JSON output.
- **Server:** `selftune dashboard` starts a local SPA server — it does not emit data.

For health remediation, prefer machine-readable `guidance.next_command` or
top-level `next_command` from `selftune doctor` output instead of inferring the
next step from prose.

Run `selftune <command> --help` for exact flags. Read
`references/cli-quick-reference.md` when you need the full flag reference.

## Creator Trust Loop

When the user wants to improve a skill, default to this creator loop before
jumping straight to mutation:

1. `selftune eval generate --skill <name> --skill-path <path>`
2. `selftune eval unit-test --skill <name> --generate --skill-path <path>`
3. `selftune evolve --skill <name> --skill-path <path> --dry-run --validation-mode replay`
4. `selftune grade baseline --skill <name> --skill-path <path>`
5. `selftune evolve --skill <name> --skill-path <path> --with-baseline`
6. then `selftune watch --skill <name>`

If the user asks "how do I know this skill works?" or "can I trust this skill
yet?", start with this loop, then use `selftune status`, the dashboard, or the
skill report to explain what is still missing, whether the skill is ready to
deploy, or whether it is already being watched live.

## Workflow Routing

| Trigger keywords | Workflow | File |
| --- | --- | --- |
| create test deploy, creator loop, ship skill, ready to deploy, can I trust this skill, how do I know this skill works | CreateTestDeploy | workflows/CreateTestDeploy.md |
| grade, score, evaluate, assess session, auto-grade | Grade | workflows/Grade.md |
| evals, eval set, undertriggering, skill stats, eval generate | Evals | workflows/Evals.md |
| evolve, improve, optimize skills, make skills better, triggers, catch more queries, apply proposal, apply contributor proposal | Evolve | workflows/Evolve.md |
| evolve body, evolve routing, full body evolution, rewrite skill, teacher student | EvolveBody | workflows/EvolveBody.md |
| evolve rollback, undo, restore, revert evolution, go back, undo last change | Rollback | workflows/Rollback.md |
| watch, monitor, regression, post-deploy, keep an eye on | Watch | workflows/Watch.md |
| doctor, health, hooks, broken, diagnose, not working, something wrong | Doctor | workflows/Doctor.md |
| ingest, import, codex logs, opencode, openclaw, pi, wrap codex | Ingest | workflows/Ingest.md |
| replay, backfill, claude transcripts, historical sessions | Replay | workflows/Replay.md |
| contributions, sharing preferences, opt in/out creator sharing, approve/revoke contributions | Contributions | workflows/Contributions.md |
| creator contributions, selftune.contribute.json, enable/disable creator contribution | CreatorContributions | workflows/CreatorContributions.md |
| signals dashboard, contributor signals, signals page, community dashboard, community data, contributor stats, signal health, how are signals, how is community | SignalsDashboard | workflows/SignalsDashboard.md |
| contribute, share, export bundle, export data, anonymized, give back | Contribute | workflows/Contribute.md |
| init, setup, set up, bootstrap, first time, install, configure selftune, alpha, enroll | Initialize | workflows/Initialize.md |
| cron, schedule, automate evolution, run automatically | Cron | workflows/Cron.md |
| schedule, selftune schedule, launchd, systemd, crontab, automation setup | Schedule | workflows/Schedule.md |
| auto-activate, suggestions, activation rules, nag, why suggest | AutoActivation | workflows/AutoActivation.md |
| dashboard, visual, open dashboard, show dashboard, serve dashboard | Dashboard | workflows/Dashboard.md |
| evolution memory, session continuity, what happened last | EvolutionMemory | workflows/EvolutionMemory.md |
| grade baseline, baseline lift, adds value, skill value, no-skill comparison | Baseline | workflows/Baseline.md |
| eval unit-test, skill test, test skill, generate tests, run tests | UnitTest | workflows/UnitTest.md |
| eval composability, co-occurrence, skill conflicts, family overlap, sibling confusion | Composability | workflows/Composability.md |
| eval import, skillsbench, external evals, benchmark tasks | ImportSkillsBench | workflows/ImportSkillsBench.md |
| telemetry, analytics, disable analytics, opt out, tracking, privacy | Telemetry | workflows/Telemetry.md |
| orchestrate, autonomous, full loop, improve all skills, run selftune loop | Orchestrate | workflows/Orchestrate.md |
| sync, refresh, source truth, rescan sessions | Sync | workflows/Sync.md |
| badge, readme badge, skill badge, health badge | Badge | workflows/Badge.md |
| workflows, discover workflows, scaffold workflow skill, build skill from logs | Workflows | workflows/Workflows.md |
| alpha upload, upload data, send alpha data, manual upload | AlphaUpload | workflows/AlphaUpload.md |
| recover, rebuild sqlite, recover db, legacy backfill | Recover | workflows/Recover.md |
| quickstart, getting started, onboard, first time setup, new user | Quickstart | workflows/Quickstart.md |
| uninstall, remove selftune, clean up, teardown | Uninstall | workflows/Uninstall.md |
| repair, rebuild usage, fix skill usage, trustworthy usage | RepairSkillUsage | workflows/RepairSkillUsage.md |
| export canonical, canonical export, canonical telemetry, push payload | ExportCanonical | workflows/ExportCanonical.md |
| hook, run hook, invoke hook, manual hook, debug hook | Hook | workflows/Hook.md |
| codex/opencode/cline/pi hooks, platform hooks, non-claude hooks, multi-agent | PlatformHooks | workflows/PlatformHooks.md |
| registry, distribute, push/install/sync/rollback skill, team skills | Registry | workflows/Registry.md |
| export, dump, jsonl, export sqlite, debug export | Export | _(direct: `selftune export`)_ |
| status, health summary, skill health, how are skills, run selftune | Status | _(direct: `selftune status`)_ |
| last, last session, recent session, what happened | Last | _(direct: `selftune last`)_ |

Workflows Grade, Evolve, Watch, and Ingest also run autonomously via `selftune orchestrate`.

## Interactive Configuration

Before running mutating workflows (evolve, evolve-body, evals, baseline), consult
`references/interactive-config.md` for the pre-flight configuration pattern, model
tier reference, and quick-path rules.

## Specialized Agents

selftune bundles focused agents in `agents/`. Read the relevant agent file and
follow its instructions — either inline or by spawning a subagent.

| Trigger keywords | Agent file | When to use |
| --- | --- | --- |
| diagnose, root cause, why failing, debug performance | `agents/diagnosis-analyst.md` | Recurring low grades or unclear failures after doctor/status |
| patterns, conflicts, cross-skill, overlap | `agents/pattern-analyst.md` | Skills overlap, misroute, or interfere |
| review evolution, check proposal, safe to deploy | `agents/evolution-reviewer.md` | Before deploying high-stakes or marginal evolutions |
| set up selftune, integrate, configure project | `agents/integration-guide.md` | Complex setup: monorepos, multi-skill, mixed-platform |

## Negative Examples

These should NOT trigger selftune — near-misses that share keywords:

- "Fix this React hydration bug" — general debugging, not skill improvement
- "Create a PowerPoint about Q3 results" — pptx skill, not selftune
- "Run my unit tests" — project tests, not skill eval tests
- "How do I use the Research skill?" — skill _usage_, not _improvement_
- "Generate a report from this data" — content generation, not skill evolution
- "My build is failing" — project issue, not selftune health
- "Evaluate this code for security issues" — code review, not session grading
- "Improve this function's performance" — code optimization, not skill optimization

The key distinction: selftune improves _skills themselves_ (descriptions, triggers,
execution quality). If the user wants to _use_ a skill, route to that skill instead.

## Creator-Directed Contribution

This skill ships a `selftune.contribute.json` config that enables creator-directed
signal relay. When users install selftune and approve contribution, anonymous
usage signals (trigger, grade, miss_category) are relayed to the selftune
creator to improve the skill for everyone.

- The `creator_id` in the bundled config is the selftune creator's cloud user UUID.
- Users opt in via `selftune contributions approve selftune`.
- No raw session content is ever shared -- only privacy-safe aggregate signals.
- See `workflows/CreatorContributions.md` for creator-side setup.
- See `workflows/Contributions.md` for end-user opt-in/opt-out.

Routing keywords: creator contribution, selftune signals, dogfood relay,
community contribution, signal sharing, opt in creator, creator UUID.

## Additional References

Load these on demand — do not read unless needed for the current task:

| Reference | When to read |
| --- | --- |
| `references/cli-quick-reference.md` | Need exact CLI flags beyond `--help` |
| `references/troubleshooting.md` | Diagnosing common errors |
| `references/examples.md` | Need step-by-step scenario walkthroughs |
| `references/creator-playbook.md` | Publishing skills others install; before-ship vs after-ship creator loop |
| `references/interactive-config.md` | Before mutating workflows |
| `references/grading-methodology.md` | Grading sessions or interpreting grades |
| `references/invocation-taxonomy.md` | Analyzing trigger coverage |
| `references/logs.md` | Parsing or debugging log files |
| `references/setup-patterns.md` | Complex platform-specific setup |
| `references/version-history.md` | Checking what changed between versions |
| `settings_snippet.json` | During initialization |
