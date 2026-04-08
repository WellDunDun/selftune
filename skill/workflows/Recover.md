# selftune Recover Workflow

Recover or backfill the local SQLite database from legacy JSONL files or an
explicit `selftune export` snapshot.

This is a recovery-only workflow. Normal operation should use `selftune sync`,
which replays native source data into SQLite and also triggers alpha upload
when enrolled.

## When to Use

- The user is migrating from a pre-SQLite selftune install and still has
  legacy JSONL history that is not in SQLite yet
- The user exported SQLite to JSONL and now needs to rebuild a fresh DB from
  that snapshot
- The user explicitly asks to recover, rebuild, or backfill SQLite from JSONL

## Default Command

```bash
selftune recover
```

## Options

| Flag                           | Description                                                   |
| ------------------------------ | ------------------------------------------------------------- |
| `--full`                       | Rebuild SQLite tables from scratch                            |
| `--force`                      | Skip the preflight guard for SQLite-only rows during rebuild  |
| `--since <date>`               | Incrementally materialize records on/after this date          |
| `--canonical-log <path>`       | Canonical JSONL path override                                 |
| `--telemetry-log <path>`       | Session telemetry JSONL path override                         |
| `--evolution-audit-log <path>` | Evolution audit JSONL path override                           |
| `--evolution-evidence-log <path>` | Evolution evidence JSONL path override                     |
| `--orchestrate-run-log <path>` | Orchestrate runs JSONL path override                          |
| `--json`                       | Output a JSON summary                                         |

## Output

The command prints a summary of what was materialized into SQLite:

- sessions
- prompts
- skill invocations
- execution facts
- session telemetry
- legacy skill usage
- evolution audit
- evolution evidence
- orchestrate runs

With `--json`, the result includes `mode`, `source`, `since`, `force`, and the
full count breakdown.

## Common Patterns

**Backfill legacy JSONL into an existing SQLite DB**

> Run `selftune recover`.

**Rebuild a deleted DB from an explicit export snapshot**

> Run `selftune export --output ./recovery-snapshot`, then recover from the exported JSONL files explicitly:
>
> `selftune recover --full --force --telemetry-log ./recovery-snapshot/session_telemetry_log.jsonl --evolution-audit-log ./recovery-snapshot/evolution_audit_log.jsonl --evolution-evidence-log ./recovery-snapshot/evolution_evidence_log.jsonl --orchestrate-run-log ./recovery-snapshot/orchestrate_run_log.jsonl`

**Recover only recent JSONL rows**

> Run `selftune recover --since 2026-01-01`.

## Important Notes

- Do **not** use this as a normal freshness command. Use `selftune sync` for day-to-day operation.
- Alpha upload remains SQLite-first. Recovery only repopulates SQLite so the normal upload pipeline can stage and send data afterward.
- If you are recovering from post-cutover data, prefer a SQLite backup or `selftune export` snapshot. Passive legacy JSONL files do not contain all post-cutover records.

## Example Flags Used Above

| Flag | Description |
| --- | --- |
| `-o, --output <dir>` | Export SQLite into a portable snapshot directory |
| `--full` | Rebuild SQLite tables from scratch |
| `--force` | Skip the SQLite-only preflight guard during full rebuild |
| `--telemetry-log <path>` | Point recover at the exported telemetry JSONL file |
