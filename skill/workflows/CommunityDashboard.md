# selftune Community Dashboard Workflow

View community-contributed data, contributor statistics, and skill signal
strength from the hosted selftune cloud dashboard.

This is **not** the same as:
- `selftune dashboard` — the **local** SPA that reads your own SQLite telemetry
- `selftune contribute` — exporting an anonymized **export bundle** for the community
- `selftune contributions` — managing your **sharing preferences** for creator-directed signals
- `selftune creator-contributions` — managing the **creator sharing setup** file (`selftune.contribute.json`)

## When to Use

- The user asks about community data, contributor stats, or aggregated skill health
- The user wants to see how many people are contributing signals for a skill
- The user asks about community skill performance, signal strength, or cohort counts
- The user says "show me community data" or "how is the community doing?"

## Where to Find It

The community dashboard is the hosted web application at the selftune cloud
URL (e.g. `https://selftune.dev/community` or the locally-running Next.js
dev server at `http://localhost:3000/community`).

## What It Shows

| Section | Description |
| --- | --- |
| Overview cards | Total contributors, total signals, active skills |
| Skill list | Per-skill signal counts, distinct cohorts, trigger rates |
| Signal strength | Whether a skill meets the actionable threshold (>=10 signals, >=3 cohorts) |
| Time buckets | Signal volume over time |
| Pending proposals | Skills eligible for community-driven evolution proposals |
| Below-threshold skills | Skills that need more data before proposals can be generated |

## Signal Strength Thresholds

A skill is considered **actionable** when it meets both of these thresholds:
- At least **10 total signals** from community contributors
- At least **3 distinct contributor cohorts**

Skills below these thresholds appear in the "needs more data" section.
These same thresholds gate proposal generation on the API side.

## Steps

1. Direct the user to the community dashboard URL
2. If asked about a specific skill, describe its signal strength and contributor count
3. If a skill is below threshold, explain how many more signals or cohorts are needed
4. If the user wants to help a skill reach threshold, route to the **Contribute** workflow

## Common Patterns

**User asks "how is the community doing?"**

> Direct them to the community dashboard. Summarize the overview stats
> (total contributors, total signals, number of actionable skills).

**User asks about a specific skill's community data**

> Look up the skill on the community dashboard. Report its total signals,
> distinct cohorts, and whether it meets the actionable threshold.

**User wants to help a skill that's below threshold**

> Route to the Contribute workflow (`selftune contribute --skill <name>`)
> to export an anonymized bundle and submit it.

**User confuses community dashboard with local dashboard**

> Clarify: `selftune dashboard` shows **local** telemetry from your own
> SQLite database. The community dashboard shows **aggregated** data from
> all contributors across the selftune cloud.
