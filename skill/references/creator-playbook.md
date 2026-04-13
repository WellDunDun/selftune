# Creator Playbook

Use this when you are publishing a skill other people will install.

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

The default creator loop is now:

```bash
selftune eval generate --skill my-skill
selftune eval unit-test --skill my-skill --generate --skill-path path/to/SKILL.md
selftune evolve --skill my-skill --skill-path path/to/SKILL.md --dry-run --validation-mode replay
selftune grade baseline --skill my-skill --skill-path path/to/SKILL.md
selftune evolve --skill my-skill --skill-path path/to/SKILL.md --with-baseline
selftune watch --skill my-skill
```

The dashboard overview, per-skill report, and `selftune status` all read from that loop and show
the next missing step directly, then flip to deploy-ready and watching states once the skill is shipped.

Ship only after you can explain:

- what should trigger the skill
- what should not
- where the body depends on references versus tools

### Bundle creator-directed contribution config

If you want post-ship creator signal:

```bash
selftune creator-contributions enable --skill my-skill --creator-id <cloud-user-uuid>
```

This writes `selftune.contribute.json` into the skill package so end users can opt in to privacy-safe creator-directed sharing.

The `creator_id` must be your cloud user UUID. Supported signals today are:

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

### Interpret signal correctly

- High missed counts with concentrated categories usually mean the **description/router** is wrong.
- Low grades with decent trigger rate usually mean the **body/workflow/reference/tool split** is wrong.
- Low-signal skills need more contributors before you trust a proposal.

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
