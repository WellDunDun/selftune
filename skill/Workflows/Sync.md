# selftune Sync Workflow

Refresh source-truth telemetry across supported agent CLIs, then rebuild the
repaired skill-usage overlay so status, dashboard, grading, and evolution work
from real transcripts/rollouts instead of stale hook data.

## When to Use

- Before running `status`, `dashboard`, `watch`, or `evolve` when data may be stale
- The user has run many Claude Code, Codex, OpenCode, or OpenClaw sessions since last sync
- The agent detects host logs may be polluted and needs the repaired/source-first view
- Before exporting data to cloud ingest

## Default Command

```bash
selftune sync
```

## Options

| Flag             | Description                                     |
| ---------------- | ----------------------------------------------- |
| `--since <date>` | Only sync sessions modified on/after this date  |
| `--dry-run`      | Show summary without writing files              |
| `--force`        | Ignore per-source markers and rescan everything |
| `--no-claude`    | Skip Claude transcript replay                   |
| `--no-codex`     | Skip Codex rollout ingest                       |
| `--no-opencode`  | Skip OpenCode ingest                            |
| `--no-openclaw`  | Skip OpenClaw ingest                            |
| `--no-repair`    | Skip rebuilding `skill_usage_repaired.jsonl`    |
| `--json`         | Output results as JSON                          |

## Output

Writes/refreshed data:

- `~/.claude/session_telemetry_log.jsonl`
- `~/.claude/all_queries_log.jsonl`
- `~/.claude/skill_usage_log.jsonl`
- `~/.claude/skill_usage_repaired.jsonl`
- per-source marker files

## Steps

### 1. Preview Sync

Run `selftune sync --dry-run`. The output includes per-source `scanned`
counts. Report the preview summary to the user.

### 2. Run Sync

Run `selftune sync`. The output includes:

- Per-source `scanned`, `synced`, and `skipped` counts
- Repaired overlay totals
- Any errors or warnings

### 3. Verify Results

Verify there are no sync errors and that per-source counters are internally
consistent (`scanned`, `synced`, `skipped`). `synced=0` is valid when no
new sessions exist since the last sync. Run `selftune doctor` only when
sync reports source/hook failures or expected active sources are missing.

### 4. Continue to Next Workflow

After sync completes, proceed with the user's intended workflow:
`selftune status`, `selftune dashboard`, `selftune watch --sync-first`,
or `selftune evolve --sync-first`.

## `--json` Usage

```bash
selftune sync --json
```

Sample output:

```json
{
  "sources": {
    "claude": { "scanned": 12, "synced": 3, "skipped": 9 },
    "codex": { "scanned": 0, "synced": 0, "skipped": 0 }
  },
  "repaired": { "total": 42 },
  "errors": []
}
```

Use `--json` when the agent needs to parse sync results programmatically
(e.g., to decide whether to proceed with evolution or surface counts to the user).

## Common Patterns

**User wants to refresh telemetry data**

> Run `selftune sync`. Report per-source `scanned`, `synced`, and `skipped` counts.

**User wants to sync only recent sessions**

> Run `selftune sync --since <date>` with the user's specified date.

**User wants a full rescan from scratch**

> Run `selftune sync --force`. This ignores per-source markers and rescans
> all sessions.

**Agent needs to verify sync worked**

> Check per-source `scanned`, `synced`, and `skipped` counts. `synced=0`
> is normal when data is already up-to-date. Verify `scanned > 0` for
> expected sources to confirm sync ran successfully.

**Agent is chaining into monitoring or evolution**

> Use `selftune watch --sync-first` or `selftune evolve --sync-first` to
> refresh source truth automatically before making decisions.
