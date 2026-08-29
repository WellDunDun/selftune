# Creator Playbook

Use this when you are publishing a skill other people will install.

If the user wants the operational step-by-step loop from cold start to deploy,
route first to `workflows/Verify.md` and `workflows/Publish.md`. Use this
reference for the packaging and after-ship interpretation layer around that
loop.

The goal is simple:

1. ship a skill that routes cleanly on day one
2. collect privacy-safe signal after launch
3. turn that signal into a safe improvement loop

## Before Ship

### Decide what belongs where

| Put it in... | When it belongs there |
| --- | --- |
| `description` / routing section | The user intent that should trigger the skill |
| `workflows/` | Ordered procedures the agent should follow once routed |
| `references/` | Background knowledge, checklists, examples, or taxonomy the agent may need during execution |
| `scripts/` or tools | Deterministic mechanics the agent should not reinvent every run |

Rule of thumb:

- If the agent needs to **recognize** a request, fix the router.
- If the agent needs to **follow steps**, add or split a workflow.
- If the agent needs **context**, add a reference.
- If the agent keeps redoing the same exact logic, make it code.

### Keep the routing surface small

- Start router-first. Add only the trigger phrases and negative examples needed to call the right skill.
- Keep workflow detail out of the top-level description.
- Split into separate workflows when the execution path meaningfully changes.
- Add negative examples whenever a nearby intent should not trigger the skill.

### Cold-start test and deploy the skill before publishing

The default package evaluation pipeline is:

```bash
selftune verify --skill-path path/to/my-skill
selftune eval generate --skill my-skill
selftune verify --skill-path path/to/my-skill
selftune eval unit-test --skill my-skill --generate --skill-path path/to/SKILL.md
selftune verify --skill-path path/to/my-skill
selftune create replay --skill-path path/to/my-skill --mode package
selftune create baseline --skill-path path/to/my-skill --mode package
selftune verify --skill-path path/to/my-skill
selftune publish --skill-path path/to/my-skill
```

`verify` is the front door in that sequence. Evals, unit tests, replay, and
baseline remain the atomic supporting steps when the draft is still missing
evidence.

The dashboard overview, per-skill report, and `selftune status` all read from that loop and show
the next missing step directly, then flip to deploy-ready and watching states once the skill is shipped.

Ship only after you can explain:

- what should trigger the skill
- what should not
- where the body depends on references versus tools

### Bundle creator-directed contribution config

If you want post-ship creator signal:

```bash
selftune creator-contributions enable --skill my-skill --creator-id <public-creator-id>
```

This writes `selftune.contribute.json` into the skill package so end users can opt in to privacy-safe creator-directed sharing.

The `creator_id` must be the public Creator ID shown by your managed or
self-hosted creator dashboard. It is a routing identifier, not a login or
database user ID. Supported signals today are:

- `trigger`
- `grade`
- `miss_category`

## After Ship

### Tell users what to opt into

There are two different community paths:

- `selftune contributions approve <skill>`: creator-directed relay signals for your dashboard
- `selftune contribute --skill <skill> --submit`: sanitized community bundle submission

Relay is the lightweight always-on loop. Bundles are the deeper periodic export.

### Watch the right surfaces

After launch, the loop is:

1. open the cloud Community page or the skill detail Community tab
2. check whether the skill is still low-signal or has crossed the actionable threshold
3. inspect missed categories and grade distribution
4. create a contributor proposal only when the signal is coherent
5. approve/apply the proposal through the normal proposals flow
6. watch the skill after apply

Actionable threshold today:

- at least `10` total signals
- at least `3` distinct contributor cohorts

### Package-level improvement

When a skill has enough package evaluation evidence (accepted frontier
candidates, canonical package evaluations), `selftune orchestrate` can
automatically select package-level bounded search instead of description-only
evolve. You can also trigger this manually:

```bash
selftune improve --skill my-skill --skill-path path/to/SKILL.md --scope package
```

Package search generates bounded mutations on routing and body surfaces,
evaluates them against the accepted frontier parent through the package
evaluator, and applies the winning candidate. Watch evidence feeds back into
frontier selection, so post-deploy regressions inform future search runs.

### Interpret signal correctly

- High missed counts with concentrated categories usually mean the **description/router** is wrong.
- Low grades with decent trigger rate usually mean the **body/workflow/reference/tool split** is wrong.
- Low-signal skills need more contributors before you trust a proposal.
- When both routing and body surfaces show weakness, `selftune improve --scope package` or automatic orchestrate scope selection can address them together.

## Fast Checklist

Before ship:

- router describes when to use the skill
- workflows describe how to do the job
- references carry durable context
- tools/scripts carry deterministic mechanics
- evals cover both your language and other likely phrasings
- `selftune.contribute.json` is bundled if you want creator-directed signal

After ship:

- community overview shows your skill by name
- per-skill community page shows missed categories and grades
- contributor proposals are reviewed before apply
- watch is run after meaningful changes
