---
name: selftune
description: >
  Self-improving skills toolkit that watches real agent sessions, detects missed
  triggers, grades execution quality, and improves skill packages through evals,
  replay, baselines, review, and post-deploy watch. Use when verifying or
  publishing a skill, improving instructions or routing, checking skill health,
  grading sessions, viewing the dashboard, ingesting agent histories, auditing
  installed skills, managing the local Skill Library, scaffolding reusable
  workflow skills, or running autonomous improvement loops. Trigger whenever a
  user asks about skill performance, health, triggers, undertriggering,
  overtriggering, evolution, evaluation, or how their skills are doing, even if
  they do not name SelfTune explicitly.
metadata:
  author: selftune-dev
  version: 0.4.3
  category: developer-tools
---

# selftune

Observe real agent sessions, detect missed triggers, grade execution quality,
evolve skills through package evaluation (replay, baseline, grading, body,
unit tests, and post-deploy watch), and scaffold workflow skills from
repeated telemetry patterns.

**You are the operator.** The user installed this skill so YOU can manage their
skill health autonomously. They will say things like "set up selftune",
"improve my skills", or "how are my skills doing?" — and you route to the
correct workflow below. The user does not run CLI commands directly; you do.

## Bootstrap

If `~/.selftune/config.json` does not exist, read `workflows/Initialize.md`
first. The CLI must be installed (`selftune` on PATH) before other commands
will work. Do not proceed with other commands until initialization is complete.

## Primary Lifecycle

Default to this lifecycle unless the user explicitly asks for a low-level
workflow:

1. `status`
   - use `selftune status`
   - for draft packages, use `selftune create status --skill-path <path>`

2. `verify`
   - use `selftune verify --skill-path <path>`
   - if verify reports missing readiness or evidence, follow the returned next
     low-level command instead of rerunning the full chain

3. `publish`
   - for draft packages, use `selftune publish --skill-path <path>`
   - for already-live skills, `publish` usually means a validated `Improve`
     action plus `Watch`

4. `improve`
   - use `selftune improve --skill <name> --skill-path <path>`
   - let `--scope auto` choose bounded package search automatically when the
     skill already has package evidence or a draft package manifest
   - set `--scope description|routing|body|package` when the measured gap is
     already clear and you want to force the mutation surface
   - use `--scope package` when the problem spans routing and body together or
     you want measured frontier comparison before deciding what to publish
   - omit `--dry-run` when you want the winning package candidate promoted back
     into the draft automatically

5. `run`
   - use `selftune run`

Treat `eval generate`, `unit-test`, `replay`, `baseline`, `watch`, and
body-specific evolution as advanced supporting workflows unless the user asks
for them directly or the default lifecycle fails.

## Command Execution Policy

```bash
selftune <command> [options]
```

Commands vary in output format:

- **JSON by default:** `selftune doctor` and `selftune watch` emit structured JSON on stdout.
- **Text by default:** `selftune status`, `selftune last`, `selftune verify`, `selftune publish`, and `selftune improve` print human-readable text when stdout is a TTY.
- **Mixed runtime output:** `selftune run` / `selftune orchestrate` emit JSON on stdout and a human report on stderr.
- **JSON opt-in:** `selftune sync --json` enables structured JSON output.
- **Server:** `selftune dashboard` starts a local SPA server — it does not emit data.
- **JSON:** `selftune library` reconciles installed, cached, draft, and archived packages.

For health remediation, prefer machine-readable `guidance.next_command` or
top-level `next_command` from `selftune doctor` output instead of inferring the
next step from prose.

Run `selftune <command> --help` for exact flags. Read
`references/cli-quick-reference.md` when you need the full flag reference.

## Package Evaluation Pipeline (Creator Trust Loop)

When the user wants to improve a skill, default to this package evaluation
pipeline before jumping straight to mutation. Each step builds measured
evidence that the package is ready to publish:

- `draft` — the package exists but is still incomplete
- `verify_blocked` — the draft is still in one of the concrete readiness states: `needs_spec_validation`, `needs_package_resources`, `needs_evals`, `needs_unit_tests`, `needs_routing_replay`, or `needs_baseline`
- `verified` — the trust gates pass and the skill is ready to ship
- `published` — the skill was shipped successfully
- `watching` — post-deploy monitoring is active
- `needs_improvement` — measured evidence shows trigger, routing, body, or value gaps
- `unhealthy` — hooks, telemetry, config, or selftune itself is broken

If the user asks "how do I know this skill works?" or "can I trust this skill
yet?", start with this pipeline, then use `selftune status`, the dashboard, or
the skill report to explain what is still missing, whether the package is ready
to publish, or whether it is already being watched live.

## Device-Backed Proof Standard

When the user asks for proof using actual data, a before-and-after, or evidence
from their device, do not substitute synthetic fixtures, aggregate scores, or a
Git-only correction for the requested evidence.

1. Resolve one genuine local session or trace to the original user input and
   observed assistant output before evaluating a candidate.
2. Freeze the source path, session ID, event timestamps, harness, model/config,
   exact input, and relevant skill revisions or policy digests.
3. Display a faithful baseline excerpt and the concrete candidate output side
   by side. A pass-rate summary is not a substitute for the visible outputs.
4. Grade both outputs against the same explicit behavioral checks and cite the
   source events that satisfy or violate each check.
5. Treat synthetic and Git-backed cases as plumbing or regression evidence,
   not as proof that a real user trajectory improved.
6. Do not declare the real-data requirement complete until at least one
   on-device case has been shown. If an isolated hosted replay would expose
   local data without approval, use an already-observed correction trajectory
   or a local harness and state the harness limitation instead of fabricating
   equivalence.

## Workflow Routing

| Trigger keywords                                                                                                                                                                                                                               | Workflow             | File                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------- |
| create skill, new skill package, author skill, bootstrap skill, scaffold package, benchmark report, package report, publish report                                                                                                             | Create               | workflows/Create.md               |
| verify skill, creator loop, can I trust this skill, how do I know this skill works, test this skill, ready to ship, ready to deploy                                                                                                            | Verify               | workflows/Verify.md               |
| publish skill, ship skill, deploy skill, go live, release skill                                                                                                                                                                                | Publish              | workflows/Publish.md              |
| search run, package frontier, candidate search, bounded package evolution, compare package candidates, optimize package, improve routing and body together, bounded evolution                                                                  | SearchRun            | workflows/SearchRun.md            |
| grade, score, evaluate, assess session, auto-grade                                                                                                                                                                                             | Grade                | workflows/Grade.md                |
| evals, eval set, undertriggering, skill stats, eval generate                                                                                                                                                                                   | Evals                | workflows/Evals.md                |
| improve, optimize skills, make skills better, triggers, catch more queries, apply proposal, apply contributor proposal                                                                                                                         | Improve              | workflows/Improve.md              |
| evolve description, description-only evolution, improve trigger wording                                                                                                                                                                        | Evolve               | workflows/Evolve.md               |
| evolve body, evolve routing, full body evolution, rewrite skill, teacher student, review local trace candidate, prepare candidate                                                                                                              | EvolveBody           | workflows/EvolveBody.md           |
| evolve rollback, undo, restore, revert evolution, go back, undo last change                                                                                                                                                                    | Rollback             | workflows/Rollback.md             |
| watch, monitor, regression, post-deploy, keep an eye on                                                                                                                                                                                        | Watch                | workflows/Watch.md                |
| doctor, health, hooks, broken, diagnose, not working, something wrong                                                                                                                                                                          | Doctor               | workflows/Doctor.md               |
| ingest, import, codex logs, opencode, openclaw, pi, wrap codex                                                                                                                                                                                 | Ingest               | workflows/Ingest.md               |
| replay, backfill, claude transcripts, historical sessions                                                                                                                                                                                      | Replay               | workflows/Replay.md               |
| contributions, sharing preferences, opt in/out creator sharing, approve/revoke contributions                                                                                                                                                   | Contributions        | workflows/Contributions.md        |
| creator contributions, selftune.contribute.json, enable/disable creator contribution                                                                                                                                                           | CreatorContributions | workflows/CreatorContributions.md |
| signals dashboard, contributor signals, signals page, community dashboard, community data, contributor stats, signal health, how are signals, how is community                                                                                 | SignalsDashboard     | workflows/SignalsDashboard.md     |
| contribute, share, export bundle, export data, anonymized, give back                                                                                                                                                                           | Contribute           | workflows/Contribute.md           |
| init, setup, set up, bootstrap, first time, install, configure selftune                                                                                                                                                                        | Initialize           | workflows/Initialize.md           |
| cron, schedule, automate evolution, run automatically                                                                                                                                                                                          | Cron                 | workflows/Cron.md                 |
| schedule, selftune schedule, launchd, systemd, crontab, automation setup                                                                                                                                                                       | Schedule             | workflows/Schedule.md             |
| background service, daemon, launch at login, persistent dashboard, menu bar service, service unavailable, stale service lock, repair lock, rotate local token                                                                                  | Service              | workflows/Service.md              |
| auto-activate, suggestions, activation rules, nag, why suggest                                                                                                                                                                                 | AutoActivation       | workflows/AutoActivation.md       |
| dashboard, visual, open dashboard, show dashboard, serve dashboard                                                                                                                                                                             | Dashboard            | workflows/Dashboard.md            |
| evolution memory, session continuity, what happened last                                                                                                                                                                                       | EvolutionMemory      | workflows/EvolutionMemory.md      |
| grade baseline, baseline lift, adds value, skill value, no-skill comparison                                                                                                                                                                    | Baseline             | workflows/Baseline.md             |
| eval unit-test, skill test, test skill, generate tests, run tests                                                                                                                                                                              | UnitTest             | workflows/UnitTest.md             |
| run output evals, compare with no skill, benchmark skill output, eval iteration, blind comparison                                                                                                                                              | EvalRun              | workflows/EvalRun.md              |
| eval composability, co-occurrence, skill conflicts, family overlap, sibling confusion                                                                                                                                                          | Composability        | workflows/Composability.md        |
| eval import, skillsbench, external evals, benchmark tasks                                                                                                                                                                                      | ImportSkillsBench    | workflows/ImportSkillsBench.md    |
| telemetry, analytics, disable analytics, opt out, tracking, privacy                                                                                                                                                                            | Telemetry            | workflows/Telemetry.md            |
| orchestrate, autonomous, full loop, improve all skills, run selftune, run selftune loop, run with package search, automatic package improvement                                                                                                | Run                  | workflows/Run.md                  |
| sync, refresh, source truth, rescan sessions                                                                                                                                                                                                   | Sync                 | workflows/Sync.md                 |
| badge, readme badge, skill badge, health badge                                                                                                                                                                                                 | Badge                | workflows/Badge.md                |
| workflows, discover workflows, scaffold workflow skill, build skill from logs                                                                                                                                                                  | Workflows            | workflows/Workflows.md            |
| recover, rebuild sqlite, recover db, legacy backfill                                                                                                                                                                                           | Recover              | workflows/Recover.md              |
| quickstart, getting started, onboard, first time setup, new user                                                                                                                                                                               | Quickstart           | workflows/Quickstart.md           |
| uninstall, remove selftune, clean up, teardown                                                                                                                                                                                                 | Uninstall            | workflows/Uninstall.md            |
| repair, rebuild usage, fix skill usage, trustworthy usage                                                                                                                                                                                      | RepairSkillUsage     | workflows/RepairSkillUsage.md     |
| unused skills, inactive skills, duplicate installations, outdated skill versions, consolidate skills, remove skill, prune skills, clean up skills, skill portfolio, quarantine skill, restore skill                                            | SkillPortfolio       | workflows/SkillPortfolio.md       |
| skill library, all skills, installed locations, cached skills, archived skills, reconcile skills                                                                                                                                               | Library              | workflows/Library.md              |
| skill set, suggest skill sets, classify skills, skill categories, co-used skills, project skills, reusable skill setup, link skills, symlink skills, apply skills to project, project profile, add skill set to project, set up project skills | SkillSets            | workflows/SkillSets.md            |
| export canonical, canonical export, canonical telemetry, push payload                                                                                                                                                                          | ExportCanonical      | workflows/ExportCanonical.md      |
| hook, run hook, invoke hook, manual hook, debug hook                                                                                                                                                                                           | Hook                 | workflows/Hook.md                 |
| codex/opencode/cline/pi hooks, platform hooks, non-claude hooks, multi-agent                                                                                                                                                                   | PlatformHooks        | workflows/PlatformHooks.md        |
| registry, distribute, push/suggest/install/sync/rollback skill, submit local skill changes, team skills                                                                                                                                        | Registry             | workflows/Registry.md             |
| export, dump, jsonl, export sqlite, debug export                                                                                                                                                                                               | Export               | _(direct: `selftune export`)_     |
| status, health summary, skill health, how are skills, run selftune                                                                                                                                                                             | Status               | _(direct: `selftune status`)_     |
| last, last session, recent session, what happened                                                                                                                                                                                              | Last                 | _(direct: `selftune last`)_       |

Workflows Grade, Improve, Watch, and Ingest also run autonomously via `selftune orchestrate`.
When package evaluation evidence exists, `selftune orchestrate` (aliased as `selftune run`)
can automatically select package-level bounded search instead of description-level evolve.

## Interactive Configuration

Before running mutating workflows (evolve, evolve-body, evals, baseline), consult
`references/interactive-config.md` for the pre-flight configuration pattern, model
tier reference, and quick-path rules.

## Specialized Agents

selftune bundles focused agents in `agents/`. Read the relevant agent file and
follow its instructions — either inline or by spawning a subagent.

| Trigger keywords                                     | Agent file                          | When to use                                                      |
| ---------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| diagnose, root cause, why failing, debug performance | `agents/diagnosis-analyst.md`       | Recurring low grades or unclear failures after doctor/status     |
| patterns, conflicts, cross-skill, overlap            | `agents/pattern-analyst.md`         | Skills overlap, misroute, or interfere                           |
| review evolution, check proposal, safe to deploy     | `agents/evolution-reviewer.md`      | Before deploying high-stakes or marginal evolutions              |
| set up selftune, integrate, configure project        | `agents/integration-guide.md`       | Complex setup: monorepos, multi-skill, mixed-platform            |
| local trace candidate, evidence cohort proposal      | `agents/evidence-cohort-teacher.md` | Prepare a bounded review-only body candidate from trace patterns |

## Advanced Workflows

Load these when the user explicitly asks for a low-level step, when the primary
lifecycle fails, or when debugging needs deeper evidence:

- `workflows/Evals.md`
- `workflows/UnitTest.md`
- `workflows/EvalRun.md`
- `workflows/Baseline.md`
- `workflows/Replay.md`
- `workflows/Watch.md`
- `workflows/Evolve.md`
- `workflows/EvolveBody.md`
- `workflows/Composability.md`
- `workflows/ImportSkillsBench.md`
- `workflows/SkillPortfolio.md`
- `workflows/SkillSets.md`
- `workflows/Service.md`

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

- The `creator_id` in the bundled config is the creator's public Creator ID.
- Users opt in via `selftune contributions approve selftune`.
- No raw session content is ever shared -- only privacy-safe aggregate signals.
- See `workflows/CreatorContributions.md` for creator-side setup.
- See `workflows/Contributions.md` for end-user opt-in/opt-out.

Routing keywords: creator contribution, selftune signals, dogfood relay,
community contribution, signal sharing, opt in creator, creator UUID.

## Additional References

Load these on demand — do not read unless needed for the current task:

| Reference                           | When to read                                                         |
| ----------------------------------- | -------------------------------------------------------------------- |
| `references/cli-quick-reference.md` | Need exact CLI flags beyond `--help`                                 |
| `references/troubleshooting.md`     | Diagnosing common errors                                             |
| `references/examples.md`            | Need step-by-step scenario walkthroughs                              |
| `references/creator-playbook.md`    | Publishing skills others install; before-ship vs after-ship pipeline |
| `references/interactive-config.md`  | Before mutating workflows                                            |
| `references/grading-methodology.md` | Grading sessions or interpreting grades                              |
| `references/invocation-taxonomy.md` | Analyzing trigger coverage                                           |
| `references/logs.md`                | Parsing or debugging log files                                       |
| `references/setup-patterns.md`      | Complex platform-specific setup                                      |
| `references/version-history.md`     | Checking what changed between versions                               |
| `settings_snippet.json`             | During initialization                                                |
