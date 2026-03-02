# selftune ICP & GTM Strategy — Living Document

**Status:** Active
**Version:** 1.1.0
**Last Updated:** 2026-03-02
**Owner:** Daniel Petro

> This is a living document. Update it as market data changes, features ship, and strategy evolves.
>
> **v1.1 UPDATE:** OpenClaw identified as primary growth vector. See [OpenClaw Integration Strategy](openclaw-integration.md) for the full technical design. The bowling pin sequence has been updated to prioritize OpenClaw users as Pin 0.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [The Two ICPs](#the-two-icps)
3. [Feature-to-ICP Matrix](#feature-to-icp-matrix)
4. [Can We Market to Both?](#can-we-market-to-both)
5. [Frameworks Applied](#frameworks-applied)
6. [Competitive Landscape](#competitive-landscape)
7. [GTM Hacks for Virality](#gtm-hacks-for-virality)
8. [Bowling Pin Sequence](#bowling-pin-sequence)
9. [Metrics That Matter](#metrics-that-matter)
10. [Open Questions & Decisions](#open-questions--decisions)
11. [Changelog](#changelog)

---

## Executive Summary

selftune operates in a **two-sided market**: skill developers who build skills, and users/agents who consume them. The product creates a feedback loop between these two sides — usage data from consumers flows back to producers, improving skill quality, which improves the consumer experience, which generates more data.

**The key insight:** No one else is doing skill-level observability. The entire industry has optimized for writing skills. Nobody has optimized for knowing whether they work. selftune is the only tool that treats skill descriptions as **living artifacts that evolve based on evidence**.

**Market context (March 2026):**
- 270,000+ agent skills across marketplaces (SkillsMP)
- Claude Code behind 4% of all GitHub commits (135K/day), $1B ARR
- Codex: 1M+ developers in first month
- OpenCode: 2.5M monthly active developers, 112K GitHub stars
- **OpenClaw: Fastest-growing agent platform with built-in cron scheduler, ClawHub marketplace, and native plugin SDK — the richest integration surface for selftune**
- Agent Skills standard unifies 17+ platforms
- AI agent market: $7.84B (2025) → $52.62B projected (2030), 46.3% CAGR
- **Zero direct competitors** in skill-specific observability

---

## The Two ICPs

### ICP 1: Skill Developers (Producers)

**Who:** Developers who write, maintain, and publish agent skills — whether for personal use, their team, or the public ecosystem (skills.sh, SkillsMP, SkillHub).

**Demographics:**
- Solo developers or small teams
- Ship skills to skills.sh or maintain internal skill libraries
- Technical (TypeScript/Python), comfortable with CLI tools
- Likely already using Claude Code or Codex daily

**Core Pain:**
- **Skill descriptions don't match how users actually talk.** They wrote "generate PowerPoint presentation." Users say "make me some slides."
- **Missed triggers are invisible.** When a skill *doesn't* fire, there's no error, no log, no signal. They only know if someone complains.
- **Manual fixes are guesswork.** No data, no validation, no regression detection. They're rewriting descriptions based on vibes.
- **No feedback loop exists.** Write once, hope forever.

**Jobs to Be Done:**
1. "Help me understand why my skill isn't triggering"
2. "Show me what queries I'm missing"
3. "Improve my skill description automatically"
4. "Tell me if a change I made broke something"
5. "Make my skill competitive in the marketplace"

**Willingness to Pay:** High for features that directly improve skill quality and marketplace ranking. Time is the real currency — they'll pay for automation that replaces manual guesswork.

**Where They Hang Out:**
- skills.sh leaderboard & community
- Anthropic Discord / Claude Code channels
- r/ClaudeAI, r/MachineLearning
- GitHub Discussions on popular skill repos
- Dev.to, Hacker News

---

### ICP 2: Users & Agents (Consumers)

**Who:** Developers using Claude Code, Codex, or OpenCode daily who have accumulated skill libraries. They don't necessarily write skills professionally but use many skills and notice when they stop working.

**Demographics:**
- Power users of agent platforms (daily usage)
- Have 10-50+ skills installed
- May or may not know how skills work internally
- Range from indie devs to startup CTOs to enterprise engineers

**Core Pain:**
- **Skills don't fire when expected.** They say "make me a slide deck" and nothing happens. They end up typing "use the pptx skill" which defeats the purpose.
- **No visibility into what's broken.** They can't tell if it's the model, the skill, or their phrasing.
- **Frustration accumulates silently.** They conclude "AI doesn't follow directions" when the real cause is a description mismatch.
- **Too many skills, no quality signal.** How do they know which skills are good and which are unreliable?

**Jobs to Be Done:**
1. "Make my skills just work without me thinking about it"
2. "Show me which of my skills are broken"
3. "Fix my skills automatically so I don't have to"
4. "Help me choose better skills from the marketplace"
5. "Reduce friction in my daily agent workflow"

**Willingness to Pay:** Lower for individual use, higher for team/enterprise features. The primary value is time saved and reduced frustration.

**Where They Hang Out:**
- Same channels as skill developers, plus:
- General programming subreddits (r/programming, r/webdev)
- Twitter/X AI tool discussions
- Product Hunt, Tech Twitter
- Company Slack/Teams channels

---

### ICP Comparison Matrix

| Dimension | ICP 1: Skill Developers | ICP 2: Users & Agents |
|-----------|------------------------|----------------------|
| **Relationship to skills** | Build and maintain | Install and use |
| **Pain intensity** | High (their reputation on the line) | Medium (annoying, not existential) |
| **Technical depth** | Deep (understand SKILL.md, eval sets) | Moderate (want dashboard, not CLI) |
| **Primary metric they care about** | Pass rate, false negatives | "Does it just work?" |
| **Feedback loop value** | Direct (improves their product) | Indirect (makes their tools better) |
| **Purchase motivation** | Professional advancement | Productivity / time savings |
| **Market size (est.)** | ~5,000-20,000 active skill authors | ~500K-3M+ agent platform users |
| **CAC** | Near zero (OSS + community) | Near zero (improved skills spread virally) |

---

## Feature-to-ICP Matrix

Every current and planned feature mapped to which ICP it primarily serves.

### Current Features (v0.1.4)

| Feature | ICP 1 (Developers) | ICP 2 (Users) | Notes |
|---------|:------------------:|:--------------:|-------|
| `selftune init` | Primary | Primary | Both need bootstrap |
| `selftune status` | Primary | **Primary** | Users want health at-a-glance |
| `selftune last` | Secondary | **Primary** | Post-session insight for users |
| `selftune dashboard` | Primary | **Primary** | Visual interface users prefer |
| `selftune doctor` | Primary | Secondary | More relevant to skill devs |
| `selftune evals` | **Primary** | Not relevant | Skill dev workflow only |
| `selftune grade` | **Primary** | Secondary | Devs grade; users see results |
| `selftune evolve` | **Primary** | Secondary | Core dev workflow |
| `selftune watch` | **Primary** | Not relevant | Post-deploy monitoring for devs |
| `selftune rollback` | **Primary** | Not relevant | Dev safety net |
| `selftune replay` | Primary | **Primary** | Both benefit from backfill |
| `selftune contribute` | **Primary** | Secondary | Community signal for devs |
| Hooks (telemetry) | Both | Both | Silent, benefits both |
| Codex/OpenCode adapters | Both | Both | Platform coverage |

### Key Insight: Feature Gap Analysis

**Features we have that serve Skill Developers well:**
- Full evolution pipeline (evals → grade → evolve → watch → rollback)
- Three-tier evaluation model
- Invocation taxonomy
- Audit trail and PR generation
- **Verdict: Strong coverage for ICP 1**

**Features we have that serve Users well:**
- `status`, `last`, `dashboard` — observability surfaces
- `replay` — instant time-to-value
- `init` — zero-config bootstrap
- Hooks — silent telemetry capture
- **Verdict: Decent coverage, but passive. Users get observability but not agency.**

**Feature gaps for Users (ICP 2):**

| Gap | Description | Priority |
|-----|-------------|----------|
| **Auto-evolve mode** | Skills improve without user intervention | High — this is the killer UX for users |
| **Skill health scores in marketplace** | Public quality badges on skills.sh | High — marketplace integration |
| **Push notifications** | "3 skills undertriggered today" | Medium — habit-forming |
| **Recommendations** | "Replace X-skill with Y-skill (higher pass rate)" | Medium — marketplace discovery |
| **One-click fix** | "This skill missed 5 queries. Fix it?" → click → done | High — removes CLI barrier |

**Feature gaps for Developers (ICP 1):**

| Gap | Description | Priority |
|-----|-------------|----------|
| **Multi-skill conflict detection** | Two skills competing for same query | High (M9 planned) |
| **Team telemetry aggregation** | Shared signal across developers | High (M9 planned) |
| **A/B testing for descriptions** | Test two descriptions against live traffic | Medium |
| **Marketplace analytics** | How your skill compares to competitors | Medium |
| **Automated PR with CI** | Evolution → PR → CI validates → auto-merge | Medium |

---

## Can We Market to Both?

**Short answer: Yes, but with sequenced messaging and a shared narrative.**

### The Shared Narrative

> "Skills should get better on their own."

This message works for both ICPs:
- **Skill developers** hear: "My skills will improve automatically based on real data."
- **Users** hear: "My tools will work better without me doing anything."

### The Sequencing Strategy

**Phase 1 (Now → Month 3): Lead with Skill Developers**
- Marketing message: "Your skills are failing silently. Here's the data."
- Channel: skills.sh community, Anthropic Discord, HN Show HN
- Why first: They're the supply side. Better skills → better UX for everyone.

**Phase 2 (Month 3 → 6): Expand to Power Users**
- Marketing message: "Skills that just work — no babysitting required."
- Channel: Product Hunt, broader dev communities, Twitter/X
- Why second: The improved skills from Phase 1 are the proof point.

**Phase 3 (Month 6+): Platform & Teams**
- Marketing message: "Skill reliability at scale — for your entire organization."
- Channel: Enterprise outreach, platform partnerships, conferences
- Why third: Aggregate data from Phases 1+2 proves platform value.

### Dual-Messaging Framework

| Context | Skill Developer Message | User Message |
|---------|------------------------|--------------|
| **Homepage hero** | "See what your skills are missing" | "Skills that get better on their own" |
| **One-liner** | "Skill observability & continuous improvement" | "Self-correcting agent skills" |
| **Value prop** | "Close the feedback loop on your skills" | "Less friction, more flow" |
| **CTA** | "Run `selftune status` on your skills" | "Install selftune and see your skill health" |
| **Social proof** | "Pass rate improved 23% in 2 weeks" | "37% fewer explicit invocations" |

### Website Architecture (if/when)

```
Homepage: "Skills that get better on their own"
├── /for-developers → Skill author landing page (evals, grade, evolve)
├── /for-users → Power user landing page (status, dashboard, auto-fix)
├── /docs → Technical docs (shared)
└── /community → Signal pooling, leaderboards, case studies
```

---

## Frameworks Applied

### 1. Bowling Pin Strategy (Geoffrey Moore)

**Framework:** Win one niche decisively, then use that momentum to knock down adjacent niches.

```
                    [Pin 4: Enterprise/Teams]
                   /                         \
          [Pin 3: Platform Teams]      [Pin 3b: Adjacent Platforms]
         /                     \
[Pin 2: Agent Power Users]  [Pin 2b: Marketplace Integration]
        |
[Pin 1: Skill Authors (all platforms)]
        |
[Pin 0: OpenClaw Early Adopters] ← YOU ARE HERE (updated 2026-03-02)
```

**Pin 0 — OpenClaw Early Adopters (NEW — Primary Focus)**
- Who: OpenClaw users who want self-improving skills
- Unique hook: "Skills that improve while you sleep" (cron-powered autonomous evolution)
- Win condition: 50+ OpenClaw users with cron-based evolution running
- Proof point: Skills improving overnight without intervention, delivered to Slack/Discord
- Why first: OpenClaw's cron + hot-reload means full autonomous loop NOW (no custom infra)
- Timeline: Now → Month 2
- See: [OpenClaw Integration Strategy](openclaw-integration.md)

**Pin 1 — Skill Authors (Expanding)**
- Who: Active skill maintainers on skills.sh AND ClawHub
- Win condition: 100+ skill authors using evolve loop regularly
- Proof point: 10+ public case studies showing 15%+ pass rate improvement
- Timeline: Month 1 → Month 3

**Pin 2 — Agent Power Users**
- Who: Daily Claude Code / Codex / OpenCode users
- Win condition: 50K+ installs, 40%+ weekly active dashboard users
- Proof point: Measurable reduction in explicit invocations across user base
- Depends on: Pin 1 success (improved skills = better user experience)
- Timeline: Month 3 → 6

**Pin 3 — Platform & Tooling Teams**
- Who: Anthropic partners, enterprise agent platforms, skill registries
- Win condition: API integrations, white-label observability, platform dashboards
- Depends on: Pins 1+2 (aggregate data proves platform value)
- Timeline: Month 6+

**Pin 4 — Enterprise**
- Who: Organizations with internal skill libraries, compliance needs
- Win condition: Team tier, self-hosted, audit logging, SLAs
- Depends on: Pins 1+2+3 (mature product, proven at scale)
- Timeline: Month 9+

### 2. Two-Sided Marketplace / Network Effects

**Framework:** In two-sided markets, value for each side increases as the other side grows. The platform facilitates cross-side network effects.

**selftune's Network Effects:**

```
Skill Developers                      Users/Agents
       |                                    |
  Write skills ──────────────────> Use skills
       |                                    |
  Get signal   <───── selftune ────> Generate signal
       |              (feedback             |
  Improve skills      loop)          Experience improves
       |                                    |
  Pass rate ↑ ──────────────────> Fewer missed triggers
       |                                    |
  More skills  ──────────────────> More users
  improved                          adopt platform
       |                                    |
       └──── Positive feedback loop ────────┘
```

**Critical mass thresholds:**
- **Supply side (devs):** 50+ skills actively being evolved → ecosystem visibly improving
- **Demand side (users):** 10K+ users generating telemetry → enough signal to improve any skill
- **Flywheel moment:** When community signal pooling (`contribute`) aggregates enough data that even brand-new skills get pre-trained on real query patterns

**Bootstrapping strategy:** Seed the supply side first. Skill developers are smaller in number but disproportionately impactful — one skill author improving one popular skill benefits thousands of users.

### 3. Crossing the Chasm

**Framework:** There's a gap between early adopters (love novelty) and early majority (need proven solutions). Most products die here.

**Where selftune sits on the adoption curve:**

```
Innovators → [Early Adopters] → |||CHASM||| → Early Majority → Late Majority → Laggards
                  ↑
            YOU ARE HERE
```

**Early Adopter profile (current):**
- Loves the concept of self-improving skills
- Comfortable with CLI, JSONL, TypeScript
- Tolerates rough edges for powerful features
- Evangelizes to peers based on novelty

**Early Majority profile (target):**
- Needs proven ROI before adopting
- Wants GUI, not CLI (dashboard is critical)
- Requires social proof (case studies, pass rates)
- Cares about "does it save me time?" not "is it technically cool?"

**Chasm-crossing requirements:**

| What Early Majority Needs | selftune Status | Gap? |
|---------------------------|-----------------|------|
| Proven results (case studies) | Not yet | Needs 10+ public case studies |
| Easy onboarding (<5 min) | `init` + `replay` | Covered |
| Visual interface | `dashboard` command | Covered, but not web-hosted |
| Social proof | Not yet | Needs testimonials, badges |
| Enterprise features | M9 planned | Gap (team, governance, compliance) |
| Stable API / integrations | CLI stable | Need programmatic API |

### 4. Product-Led Growth (PLG)

**Framework:** The product itself drives acquisition, retention, and expansion. No sales team needed at early stages.

**selftune's PLG mechanics:**

| PLG Pillar | How selftune Delivers |
|------------|----------------------|
| **Self-serve onboarding** | `npx skills add WellDunDun/selftune` → `selftune init` → done |
| **Rapid time-to-value** | `replay` backfills months of data instantly; first insight in <10 min |
| **Zero cost of trial** | MIT licensed, zero deps, uses existing agent subscription |
| **In-product expansion** | `status` → see problem → `evolve` → see fix → want more |
| **Natural viral loops** | Improved skills benefit all users of that skill, not just the author |
| **Usage → data → value** | More sessions = more signal = better evolution proposals |

**PLG metrics to track:**

| Metric | Target | Measures |
|--------|--------|----------|
| Install → init success rate | >70% | Onboarding friction |
| Time to first insight | <10 min | Time-to-value |
| Weekly active `status` users | Growing 10%/week | Retention |
| Evolve loop executed within 30 days | >40% of installs | Activation depth |
| Organic referral rate | >1.0 | Viral coefficient |

### 5. Community-Led Growth (CLG)

**Framework:** Growth driven by community participation, contribution, and evangelism rather than traditional marketing.

**selftune CLG flywheel:**

```
Developer discovers selftune
         ↓
Installs, runs evolve, sees skill improve
         ↓
Tells other developers (word-of-mouth)
         ↓
Community begins to form (GitHub, Discord)
         ↓
Members contribute (PRs, issues, signal data)
         ↓
See their contributions ship in releases
         ↓
Feel ownership → become evangelists
         ↓
Community is self-sustaining
```

**Enabling mechanics:**
- `selftune contribute` — opt-in anonymized data sharing (already built)
- Zero-dependency codebase — easy for contributors to understand
- Clear architecture (ARCHITECTURE.md) — low barrier to meaningful PRs
- Golden principles — taste is documented, not gatekept

### 6. Jobs-to-Be-Done (JTBD)

**Framework:** People don't buy products. They "hire" them to do a job. Understanding the job reveals the real competition.

| Job | ICP | Current "Hire" (Competitor) | selftune as New Hire |
|-----|-----|---------------------------|---------------------|
| "Tell me why my skill isn't triggering" | Developer | Manual testing + guesswork | `selftune status` — data-driven diagnosis |
| "Fix my skill description" | Developer | Rewrite based on vibes | `selftune evolve` — evidence-based proposal |
| "Make sure a fix didn't break anything" | Developer | Run manual tests | `selftune watch` — automated regression detection |
| "Make my skills just work" | User | Type "use the X skill" explicitly | Auto-evolve (planned) — skills self-correct |
| "Show me what's broken" | User | Trial and error | `selftune dashboard` — visual health grid |
| "Reduce friction in my workflow" | User | Live with bad skills or uninstall | selftune makes all skills better over time |

---

## Competitive Landscape

### Direct Competitors: None

No tool specifically does **skill-level observability and continuous improvement**. This is a new category.

### Adjacent Tools

| Tool | What It Does | Overlap | selftune Differentiation |
|------|-------------|---------|--------------------------|
| **Langfuse** | LLM observability (traces, metrics) | General LLM monitoring | selftune is skill-specific, not model-specific |
| **OpenLIT** | OpenTelemetry-native AI observability | Infrastructure monitoring | selftune monitors skill quality, not infra |
| **LangSmith** | Agent tracing + evaluation | Agent-level observability | selftune is skill-level, not agent-level |
| **Helicone** | LLM monitoring & debugging | Request-level metrics | selftune monitors semantic match, not requests |
| **SkillForge** | Screen recording → skill creation | Authoring tool | selftune is post-authoring (runtime) |
| **reins** | Repo structure audit | Static analysis | selftune is dynamic/runtime |
| **Manual rewrites** | Dev guesses better phrasing | The status quo | selftune replaces guessing with data |

### Positioning Statement

> **For skill authors and agent power users** who need reliable skill triggering,
> **selftune is a skill observability and continuous improvement CLI**
> **that** detects missed triggers, grades execution quality, and evolves descriptions automatically.
> **Unlike** manual rewrites or general LLM observability tools,
> **selftune** measures real failures with real user signal and fixes them with validated proposals.

### Category Creation Opportunity

selftune is not an observability tool that happens to work with skills. It's the **first skill-specific quality tool** in a market with 270K+ skills and zero quality infrastructure. This is a category-creation opportunity:

**Category name candidates:**
- "Skill Observability" (technical, precise)
- "Skill Health" (approachable, implies ongoing)
- "Skill Intelligence" (aspirational, implies ML)
- "Skill Ops" (parallels DevOps, MLOps)

**Recommendation:** Lead with "Skill Observability" for developers, "Self-Correcting Skills" for users.

---

## GTM Hacks for Virality

### Hack 1: "Skill Health Badge" for README.md

**Concept:** A dynamic badge (like CI status badges) that skill authors embed in their README showing their skill's pass rate.

```markdown
[![Skill Health](https://selftune.dev/badge/pptx-skill)](https://selftune.dev/report/pptx-skill)
```

Renders as: `[Skill Health: 87% pass rate ↑12%]`

**Why it goes viral:**
- Every skill's README becomes an advertisement for selftune
- Social proof: users gravitate toward skills with health badges
- Competitive pressure: skill authors without badges look unoptimized
- Low friction: one line of markdown to add
- **Network effect:** The more skills with badges, the more expected it becomes

**Implementation:** Hosted badge service that reads from contributed data or public API. Could start simple — static SVG generated by `selftune badge --skill <name>`.

### Hack 2: "Skill Health Report" — The Annual State of Skills

**Concept:** Aggregate anonymized data from `selftune contribute` into a public annual (or quarterly) report.

**Content:**
- Average pass rate across all skills
- Most common failure patterns
- Top-improved skills of the quarter
- Invocation taxonomy breakdown (explicit vs implicit vs contextual)
- Platform comparison (Claude Code vs Codex vs OpenCode triggering rates)

**Why it goes viral:**
- Data-driven content is the #1 shareable format in dev communities
- Positions selftune as the authority on skill quality
- Skills.sh and other marketplaces want this data
- Press coverage: "270K skills, and most of them are broken — here's the data"

### Hack 3: "Before/After" Demo Video (60 Seconds)

**Concept:** A 60-second screencast showing:
1. A skill that misses a query (5 sec)
2. `selftune status` revealing the missed query (10 sec)
3. `selftune evolve` proposing a fix (15 sec)
4. The same query now triggering the skill (10 sec)
5. Dashboard showing pass rate improvement (10 sec)

**Why it goes viral:**
- Visual proof > written claims
- 60 seconds respects attention spans
- Shareable on Twitter/X, Reddit, HN
- The "before" state is something every skill user has experienced (instant relatability)

### Hack 4: "Skill Roast" Community Events

**Concept:** Monthly community events where popular skills get "roasted" — selftune runs against them live, revealing missed queries and proposing fixes.

**Why it goes viral:**
- Entertainment + education = high engagement
- Skill authors get free improvement (incentive to participate)
- Creates content (recordings, blog posts, social clips)
- Builds community around shared challenge of skill quality
- Can stream on YouTube/Twitch — reach outside normal channels

### Hack 5: skills.sh Integration — "Powered by selftune"

**Concept:** Partner with skills.sh to show selftune metrics directly in the marketplace.

**What users see:**
- Pass rate alongside install count
- Trend direction (improving / stable / regressing)
- "Actively evolving" badge for skills using selftune

**Why it goes viral:**
- Changes the marketplace competitive dynamic
- Skills without selftune data look less trustworthy
- Creates demand from skill authors who see competitors' metrics
- skills.sh benefits from higher-quality listings

### Hack 6: "Adopt a Skill" Campaign

**Concept:** Create a program where community members can "adopt" popular but undertriggering skills and improve them using selftune.

**Mechanics:**
1. selftune identifies top 50 most-installed but worst-triggering skills
2. Community members claim a skill to improve
3. They run the evolve loop, submit PR to the skill's repo
4. selftune tracks and celebrates improvements

**Why it goes viral:**
- Gamification drives participation
- Skill authors get free improvements (win-win)
- Creates many testimonials and case studies simultaneously
- Community-driven content machine

### Hack 7: "Skills That Improve While You Sleep" (OpenClaw-Exclusive)

**Concept:** Leverage OpenClaw's built-in cron scheduler to run selftune's evolution loop autonomously overnight. Skills improve and hot-reload automatically — users wake up to better tools.

**Setup:**
```bash
openclaw cron add --name "selftune-evolve" --cron "0 3 * * 0" --session isolated \
  --message "Run selftune full evolution pipeline" --announce --channel slack
```

**Why it goes viral:**
- "Set it up once, skills improve forever" — the ultimate PLG story
- No other platform can do this (OpenClaw-exclusive)
- Results delivered to team channels (visible social proof)
- The before/after is undeniable: "pptx skill was 40%, now 78% — happened while I slept"
- Enables the narrative: "My AI tools get better every week without me touching them"

### Hack 8: ClawHub Marketplace Quality Badges

**Concept:** Same as Hack 1 (Health Badge) but for OpenClaw's ClawHub marketplace. Partner with ClawHub to display selftune metrics alongside install counts.

**Why it goes viral:**
- ClawHub has vector search and active community
- Quality metrics change the marketplace competitive dynamic
- Skills without selftune data look unoptimized

### Hack 9: Channel-Based Evolution Reports

**Concept:** OpenClaw's cron can deliver results to Slack, Discord, WhatsApp, Telegram. Teams see skill improvements delivered to their shared channels.

**Message example:**
> "selftune overnight report: 3 skills improved. pptx: 40% → 62%. grep-files: 71% → 89%. deploy: 55% → 73%. 2 skills stable. 0 regressions."

**Why it goes viral:**
- Creates visible, shareable artifacts in team channels
- Other team members ask "what is this?" → organic discovery
- Recurring visibility (not a one-time demo)

### Hack 10: Automatic Skill Improvement PRs

**Concept:** When `selftune evolve` produces a validated improvement, it auto-opens a PR on the skill's GitHub repo with the improved SKILL.md, eval results, and improvement summary.

**Why it goes viral:**
- Skill authors receive unsolicited proof that selftune works
- The PR itself is a demo (before/after metrics right there)
- Other contributors on the repo see the PR → discover selftune
- Creates a trail of public evidence across GitHub

---

## Bowling Pin Sequence

### Detailed Implementation Timeline

#### Pin 1: Skill Authors (NOW → Month 3)

**Goal:** Become the standard tool for skill quality.

| Week | Action | Metric |
|------|--------|--------|
| 1-2 | Identify top 20 undertriggering skills on skills.sh | List created |
| 1-2 | Create 3 "before/after" case studies using selftune on own skills | Published |
| 3-4 | Post Show HN with case study data | >100 upvotes |
| 3-4 | Engage in Anthropic Discord / Claude Code channels | 10+ conversations |
| 5-6 | Reach out to 10 prolific skill authors for beta testing | 5+ adopters |
| 7-8 | Publish first "Skill Health Report" (even small scale) | Shared in 3+ communities |
| 9-12 | Iterate on evolve UX based on author feedback | 50+ active skill authors |

**Exit criteria for Pin 1:**
- [ ] 100+ skill authors with selftune installed
- [ ] 10+ public case studies with quantified improvement
- [ ] Mentioned in 3+ newsletter/community posts
- [ ] Average skill improvement: >15% pass rate

#### Pin 2: Power Users (Month 3 → 6)

**Goal:** Make "install selftune" standard advice for agent setup.

| Action | Metric |
|--------|--------|
| Launch Skill Health Badge service | 50+ skills displaying badge |
| Product Hunt launch | Top 5 of the day |
| Dashboard UX overhaul (more visual, less CLI) | 40%+ weekly dashboard opens |
| Auto-evolve mode (skills improve without intervention) | 60%+ of users enable it |
| Partnership with skills.sh for quality metrics display | Integration live |
| "Adopt a Skill" campaign launch | 50+ skills adopted |

**Exit criteria for Pin 2:**
- [ ] 50K+ total installs
- [ ] 40%+ weekly active dashboard users
- [ ] skills.sh integration showing selftune metrics
- [ ] Measurable reduction in explicit invocations across user base

#### Pin 3: Platform & Enterprise (Month 6+)

**Goal:** Integrate into the agent platform infrastructure layer.

| Action | Metric |
|--------|--------|
| Team telemetry aggregation (M9) | 5+ teams using shared signal |
| API for programmatic access | 3+ integrations |
| Platform partnerships (Anthropic, OpenAI) | 1+ signed partnership |
| Enterprise tier with governance/compliance | 3+ paying customers |
| Annual "State of Skills" report | Press coverage |

---

## Metrics That Matter

### North Star Metric

**"Skills improved per week"** — The count of unique skills that had their pass rate improved through selftune's evolution loop in a given week. This single metric captures adoption (people using it), effectiveness (it actually works), and ecosystem impact (skills getting better).

### Funnel Metrics

```
npm install / npx skills add    ← Awareness
         ↓
selftune init (success)         ← Activation
         ↓
selftune status / dashboard     ← Engagement
         ↓
selftune evolve (at least once) ← Core Value
         ↓
Weekly evolve loop              ← Retention
         ↓
selftune contribute             ← Community
```

| Stage | Metric | Target (Month 3) | Target (Month 6) |
|-------|--------|:-:|:-:|
| Awareness | npm downloads/week | 500 | 5,000 |
| Activation | init success rate | >70% | >80% |
| Engagement | Dashboard opens/week | 200 | 2,000 |
| Core Value | Evolve loops/week | 50 | 500 |
| Retention | 30-day evolve return rate | >40% | >50% |
| Community | Contributions submitted | 20 | 200 |

### Ecosystem Health Metrics

| Metric | What It Measures | Target |
|--------|-----------------|--------|
| Avg pass rate (all tracked skills) | Overall ecosystem quality | >75% |
| % of skills with >80% pass rate | "Healthy" skill percentage | >60% |
| Explicit invocation rate | How often users have to name skills | Declining month-over-month |
| False negatives detected/week | selftune's detection sensitivity | Growing (more signal) |
| Regressions caught | Watch effectiveness | >90% of regressions flagged |

---

## Open Questions & Decisions

### Strategy Decisions Needed

| # | Question | Options | Decision | Date |
|---|----------|---------|----------|------|
| 1 | Should we build a hosted web dashboard? | CLI-only / Self-hosted HTML / Cloud dashboard | TBD | — |
| 2 | Should badge service be self-hosted or SaaS? | Self-hosted / selftune.dev hosted | TBD | — |
| 3 | When do we introduce a paid tier? | Month 3 (early) / Month 6 (after PMF) / Never (OSS only) | TBD | — |
| 4 | Should auto-evolve be opt-in or opt-out? | Opt-in (safer) / Opt-out (more aggressive) | TBD | — |
| 5 | How do we handle multi-skill conflicts? | Automatic resolution / Flagging only / Developer decides | TBD (M9) | — |
| 6 | Should we target additional platforms? (Cursor, Gemini CLI) | Yes (expand TAM) / No (focus on 3) | TBD | — |
| 7 | Community signal pooling: centralized or P2P? | GitHub-based (current) / Central server / P2P | TBD | — |

### Research Needed

| Topic | Why It Matters | Status |
|-------|---------------|--------|
| skills.sh partnership feasibility | Hack #5 depends on this | Not started |
| Badge service technical design | Hack #1 implementation | Not started |
| Auto-evolve UX research | Critical for ICP 2 | Not started |
| Enterprise pricing benchmarks | Pin 3/4 monetization | Not started |
| Adjacent platform adapters (Cursor, Gemini) | TAM expansion | Not started |

---

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-03-02 | 1.1.0 | OpenClaw added as primary growth vector (Pin 0). 3 new GTM hacks (7-9). Bowling pin updated. |
| 2026-03-01 | 1.0.0 | Initial strategy document created |
