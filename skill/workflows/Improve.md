# selftune Improve Workflow

Use this when the user wants to make a skill better based on measured evidence.

## What Improve Means

`Improve` is the primary lifecycle workflow for bounded skill evolution.

The lifecycle entrypoint is:

```bash
selftune improve --skill <name> --skill-path <path> [--scope auto|description|routing|body|package] [--agent AGENT] [--eval-set PATH] [--dry-run] [--validation-mode auto|replay|judge]
```

## Options

| Flag                | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `--scope`           | Improvement scope: `auto`, `description`, `routing`, `body`, or `package`    |
| `--skill`           | Skill name                                                                   |
| `--skill-path`      | Path to `SKILL.md`                                                           |
| `--agent`           | Agent CLI to use; for body/routing this sets both teacher and student agents |
| `--eval-set`        | Override the eval set JSON path                                              |
| `--dry-run`         | Validate candidate changes without deploying                                 |
| `--validation-mode` | Validation strategy: `auto`, `replay`, or `judge`                            |
| `--help`            | Show command help                                                            |

`improve` chooses an underlying command surface:

- local DuckDB historical replay for eligible `--scope auto --dry-run` requests
- `selftune evolve ...` for description and trigger-surface changes
- `selftune evolve body ... --target routing` for workflow-routing changes
- `selftune evolve body ... --target body` for larger body changes
- `selftune search-run ...` for bounded package search across routing/body variants

Always prefer the smallest mutation surface that matches the measured problem.

## Preconditions

Before improving a skill, make sure the skill is already verified enough to
trust the result:

- evals exist
- unit tests exist when needed
- replay evidence exists
- baseline or equivalent value evidence exists when the change is high stakes

If those are missing, route to `Verify` first.

## Scope Selection

### Auto scope with historical evidence

Use:

```bash
selftune improve --skill <name> --skill-path <path> --scope auto --dry-run --agent codex
```

SelfTune first looks for invocation-local failed traces plus a successful
counterexample for the same installed skill revision. Session-level error totals
are never assigned to a skill. When causal outcomes are unavailable but exact
explicit skill invocations exist, SelfTune instead selects four neutral historical
tasks: two calibration tasks, one blind selection task, and one audit holdout.
The teacher sees calibration only. Codex student replay is pinned to
`gpt-5.6-luna` with max reasoning and runs isolated `no_skill`, `current_skill`,
and `candidate_skill` arms. The result includes a bounded redacted current versus
candidate example and remains review-only; it never edits the installed skill.
If no eligible cohort exists, auto continues to normal scope selection.

### Description scope

Use:

```bash
selftune improve --skill <name> --skill-path <path> --scope description --dry-run --validation-mode replay
```

Choose this when:

- undertriggering is mostly a wording problem
- missed queries cluster around synonyms or phrasing
- the workflow itself is fine once the skill triggers

### Routing scope

Use:

```bash
selftune improve --skill <name> --skill-path <path> --scope routing --dry-run --validation-mode replay
```

Choose this when:

- the skill triggers but chooses the wrong workflow
- workflow routing is incomplete or ambiguous
- the problem is structural routing, not top-level matching

### Body scope

Use:

```bash
selftune improve --skill <name> --skill-path <path> --scope body --dry-run --validation-mode replay
```

Choose this when:

- the skill triggers and routes correctly but executes poorly
- instructions inside the body are incomplete, misleading, or stale

### Package scope

Use:

```bash
selftune improve --skill <name> --skill-path <path> --scope package --eval-set <path>
```

Choose this when:

- the measured gap spans routing and body together
- you want frontier-backed candidate comparison instead of a single mutation
- you need a bounded review loop before deciding what to publish

Package scope always runs bounded search through the shared package evaluator.
Without `--dry-run`, the winning candidate is promoted back into the draft
package automatically. `--validation-mode judge` is not supported here.

## Default Approach

1. start with the smallest scope that matches the evidence
2. let `--scope auto --dry-run` use eligible local historical evidence first;
   draft packages still choose package search, and ineligible historical
   cohorts fall back to description-surface evolution
3. use `--scope package` when the evidence points to a multi-surface package
   problem and you want to force package search explicitly
4. prefer `--dry-run` first
5. use replay-backed validation when available
6. only deploy once the proposal clears the trust bar
7. after deployment, hand off to `Watch`

## After Improve

If a change is deployed, continue with:

```bash
selftune watch --skill <name> --skill-path <path>
```

For draft packages, use `Publish` instead of treating improve as the first ship
path.

## Which workflows to load next

- missing trust evidence -> `workflows/Verify.md`
- explicit description-only evolution details -> `workflows/Evolve.md`
- explicit routing/body mutation details -> `workflows/EvolveBody.md`
- monitoring and rollback -> `workflows/Watch.md`

## Common Patterns

**"Make this skill better."**

> Use `Improve`. Pick the smallest scope that fits the measured gap, or start
> with `--scope auto`. For draft packages or skills with package-frontier
> evidence, `--scope auto` now routes into bounded package search by default.

**"It undertriggers."**

> Start with description scope unless evidence points to routing issues.

**"The wrong workflow fires."**

> Use routing scope, not description scope.

**"The skill fires but performs badly."**

> Use body scope after verify is in place.

**"I want to compare a few full package candidates first."**

> Use package scope so selftune runs bounded search instead of a single edit.

Bounded package search now prefers reflective proposals first, then
eval-informed targeted variants, then deterministic fallback. When routing and
body both produce accepted improvements, it also evaluates a merged candidate
before final winner selection.
