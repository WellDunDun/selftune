# selftune Replay Workflow

Backfill the shared JSONL logs from existing Claude Code conversation
transcripts. Useful for bootstrapping selftune with historical session data.

## When to Use

- New selftune installation with months of Claude Code history
- After re-initializing logs and wanting to recover data
- To populate eval data without waiting for new sessions

## Key Difference from Hooks

Real-time hooks capture only the **last** user query per session. Replay
extracts **all** user queries, writing one `QueryLogRecord` per message.
This produces much richer eval data from historical sessions.

## Default Command

```bash
selftune replay
```

## Options

| Flag | Description |
|------|-------------|
| `--since <date>` | Only include transcripts modified after this date |
| `--dry-run` | Preview what would be ingested without writing |
| `--force` | Re-ingest all transcripts (ignore marker file) |
| `--verbose` | Show detailed progress per file |
| `--projects-dir <path>` | Override default `~/.claude/projects/` path |

## Source

Reads Claude Code transcripts from `~/.claude/projects/<hash>/<session>.jsonl`.
Each transcript is a JSONL file containing user and assistant messages.

## Output

Writes to:
- `~/.claude/all_queries_log.jsonl` -- one record per user query (all messages, not just last)
- `~/.claude/session_telemetry_log.jsonl` -- per-session metrics with `source: "claude_code_replay"`
- `~/.claude/skill_usage_log.jsonl` -- skill triggers detected in transcripts

## Idempotency

Uses a marker file at `~/.claude/claude_code_ingested_sessions.json` to track
which transcripts have already been ingested. Use `--force` to re-ingest all.

## Steps

1. Run `selftune replay --dry-run` to preview what would be ingested
2. Run `selftune replay` to perform the ingestion
3. Run `selftune doctor` to verify logs are healthy
4. Run `selftune evals --list-skills` to see if replayed sessions appear

## Common Patterns

**"Backfill my logs"**
> Run `selftune replay`. No options needed.

**"Only replay recent sessions"**
> Run `selftune replay --since 2026-02-01`

**"Re-ingest everything"**
> Run `selftune replay --force`

**"How do I know it worked?"**
> Run `selftune doctor` after replay. Check log file line counts increased.
