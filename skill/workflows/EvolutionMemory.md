# selftune Evolution Memory

This reference documents the evolution memory system. The agent reads these files automatically during evolve, watch, and rollback workflows for session continuity.

Human-readable session context that survives context window resets. Provides
continuity across evolve, watch, and rollback workflows by recording outcomes,
decisions, and known issues in plain markdown files.

## When to Use

- **Reading evolution context for continuity** -- Step 0 in Evolve, Watch, and
  Rollback workflows reads memory before starting.
- **Diagnosing what happened in previous sessions** -- the decision log provides
  a chronological record of every evolution action and its outcome.

## Location

```text
~/.selftune/memory/
```

All memory files live in this directory. The directory is created automatically
on the first write.

## The Three Files

### 1. context.md -- Active Evolutions

Tracks the current state of every skill that has been evolved, watched, or
rolled back.

**Format:** Markdown with `##` sections.

```markdown
# Selftune Context

## Active Evolutions

- pptx: deployed -- Added implicit triggers for slide deck queries
- csv-parser: regression -- pass_rate=0.65, baseline=0.88

## Known Issues

- Regression detected for csv-parser: pass_rate=0.65 below baseline=0.88

## Last Updated

2026-03-01T14:00:00.000Z
```

**Status values:**

| Status            | Meaning                                       |
| ----------------- | --------------------------------------------- |
| `deployed`        | Evolution was deployed successfully           |
| `failed`          | Evolution attempted but did not deploy        |
| `regression`      | Watch detected a regression in pass rate      |
| `healthy`         | Watch confirmed pass rate is within threshold |
| `rolled-back`     | Rollback completed successfully               |
| `rollback-failed` | Rollback was attempted but failed             |

### 2. plan.md -- Current Priorities

Records evolution priorities and strategy.

**Format:** Markdown with `##` sections.

```markdown
# Evolution Plan

## Current Priorities

1. Improve csv-parser implicit trigger coverage
2. Re-evolve pptx after eval set expansion

## Strategy

Focus on skills with highest session volume first.

## Last Updated

2026-03-01T14:00:00.000Z
```

### 3. decisions.md -- Append-Only Decision Log

Chronological record of every evolution action. Entries are never removed,
only appended.

**Entry format:**

```markdown
## 2026-03-01T14:00:00.000Z -- evolve

- **Skill:** pptx
- **Action:** evolved
- **Rationale:** Missed implicit triggers for slide deck queries
- **Result:** Deployed with pass_rate improvement 0.70 -> 0.92

---
```

Each entry contains:

| Field       | Description                                               |
| ----------- | --------------------------------------------------------- |
| Timestamp   | ISO 8601 timestamp in the `##` heading                    |
| Action type | `evolve`, `rollback`, or `watch` in the heading           |
| Skill       | The skill name                                            |
| Action      | Past-tense result: `evolved`, `rolled-back`, or `watched` |
| Rationale   | Why the action was taken                                  |
| Result      | What happened                                             |

Entries are separated by `---` markers.

## Auto-Update Triggers

Memory is updated automatically by the memory writer (`cli/selftune/memory/writer.ts`).
No manual editing is required during normal operation.

| Trigger                  | Function                     | Updates                                                    |
| ------------------------ | ---------------------------- | ---------------------------------------------------------- |
| After evolve completes   | `updateContextAfterEvolve`   | context.md + decisions.md                                  |
| After rollback completes | `updateContextAfterRollback` | context.md + decisions.md                                  |
| After watch completes    | `updateContextAfterWatch`    | context.md + decisions.md, adds known issues on regression |

## Reading Memory

Step 0 in the Evolve, Watch, and Rollback workflows reads `~/.selftune/memory/context.md`
before starting any operation. This provides:

- Active evolutions and their current status
- Known issues from previous runs
- Last update timestamp

If the file does not exist, the workflow proceeds normally. Memory files are
created automatically after the first evolve, watch, or rollback operation.

## Resetting Memory

Delete the files in `~/.selftune/memory/` to start fresh:

```bash
rm -rf ~/.selftune/memory/
```

They will be recreated automatically on the next evolve, watch, or rollback run.

## Common Patterns

**"What happened in the last evolution?"**

> Read `~/.selftune/memory/decisions.md`. The most recent entry at the bottom
> of the file contains the last action, skill, rationale, and result.

**"What's the current state?"**

> Read `~/.selftune/memory/context.md`. The Active Evolutions section lists
> every tracked skill and its current status.

**"Memory seems stale"**

> Delete the files in `~/.selftune/memory/` and run `selftune evolve` or
> `selftune watch` to recreate them with fresh data.
