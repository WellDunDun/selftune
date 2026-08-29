# selftune Signals Dashboard Workflow

View consented contributor signals, contributor statistics, and skill signal
strength from the connected managed or self-hosted workspace. The host contains
bounded aggregates only; raw prompts, sessions, evaluations, and improvement
execution remain local.

This is **not** the same as:

- `selftune dashboard` — the **local** SPA that reads your own SQLite telemetry
- `selftune contribute` — exporting an anonymized **export bundle** for the community
- `selftune contributions` — managing your **sharing preferences** for creator-directed signals
- `selftune creator-contributions` — managing the **creator sharing setup** file (`selftune.contribute.json`)

## When to Use

- The user asks about contributor signals, contributor stats, or aggregated skill health
- The user wants to see how many people are contributing signals for a skill
- The user asks about signal performance, signal strength, or cohort counts
- The user says "show me signals", "show me contributor signals", or "how are signals doing?"

## Where to Find It

The signals dashboard is the hosted web application at the selftune cloud
URL. Managed Cloud currently shows the contributor section on its workspace
dashboard. A self-host operator reads the authenticated aggregate endpoint.

## What It Shows

| Section                | Description                                                                |
| ---------------------- | -------------------------------------------------------------------------- |
| Skill list      | Opaque skill hash, signal count, distinct cohorts, and misses |
| Skill aggregate | Trigger, miss, and grade counts for one skill hash           |
| Creator ID      | Stable public routing ID to bundle in a published skill      |

## Signal Strength Thresholds

A skill is considered **actionable** when it meets both of these thresholds:

- At least **10 total signals** from contributors
- At least **3 distinct contributor cohorts**

Treat these as a review heuristic, not as verified evidence. A linked client
can submit a bounded signal to a public Creator ID; the relay rate-limits and
deduplicates submissions but does not prove the underlying outcome. Never
auto-apply a change from contributor aggregates.

## Steps

1. Direct the user to the signals dashboard URL
2. If asked about a specific skill, describe its signal strength and contributor count
3. If a skill is below threshold, explain how many more signals or cohorts are needed
4. If the user wants to help a skill reach threshold, route to the **Contribute** workflow
5. If the user wants to act, use the aggregate only as a hypothesis for a local eval and proposal

## After-Ship Pipeline

For a creator, the after-ship pipeline is:

1. check whether the skill is low-signal or actionable
2. inspect missed categories and grade distribution
3. reproduce the pattern locally and create a proposal only when local evidence supports it
4. review/apply the proposal through the normal proposal flow
5. watch outcomes after apply

Read `references/creator-playbook.md` for the full before-ship and after-ship playbook.

## Common Patterns

**User asks "how are contributor signals doing?"**

> Direct them to the workspace dashboard. Summarize observations, distinct
> cohorts, and misses while stating that these are unverified directional signals.

**User asks about a specific skill's contributor signals**

> Look up the skill on the signals dashboard. Report its total signals,
> distinct cohorts, and whether it meets the actionable threshold.

**User wants to help a skill that's below threshold**

> Route to the Contribute workflow (`selftune contribute --skill <name>`)
> to export an anonymized bundle and submit it.

**User confuses signals dashboard with local dashboard**

> Clarify: `selftune dashboard` shows **local** evidence from your own SQLite
> database. The hosted section shows bounded, unverified aggregates relayed by
> opted-in contributors.
