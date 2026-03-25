# selftune Ingest (Claude) Workflow

> **Note:** This workflow documents `selftune ingest claude`. The command was
> renamed from `selftune replay` to `selftune ingest claude`. This file is
> kept as `Replay.md` for routing compatibility.

Backfill the shared JSONL logs from existing Claude Code conversation
transcripts. Useful for bootstrapping selftune with historical session data.

## When to Use

- The user has a new selftune installation with months of Claude Code history
- The user re-initialized logs and wants to recover data
- The agent needs to populate eval data without waiting for new sessions

## Key Difference from Hooks

Real-time hooks capture only the **last** user query per session. Ingest
extracts **all** user queries, writing one `QueryLogRecord` per message.
This produces much richer eval data from historical sessions.

## Default Command

```bash
selftune ingest claude
```

## Options

| Flag                    | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `--since <date>`        | Only include transcripts modified after this date |
| `--dry-run`             | Preview what would be ingested without writing    |
| `--force`               | Re-ingest all transcripts (ignore marker file)    |
| `--verbose`             | Show detailed progress per file                   |
| `--projects-dir <path>` | Override default `~/.claude/projects/` path       |

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

### 1. Preview Ingestion

Run `selftune ingest claude --dry-run`. Parse the output to check how many
transcripts would be ingested. Report the count to the user.

### 2. Run Ingestion

Run `selftune ingest claude`. Parse the output for ingested session counts
and any errors.

### 3. Verify Results

Run `selftune doctor` to verify logs are healthy. Run
`selftune eval generate --list-skills` to confirm ingested sessions appear.

### 4. Report Results

Report the number of sessions ingested and any skills discovered to the user.

## Common Patterns

**User wants to backfill logs from Claude Code history**

> Run `selftune ingest claude`. No options needed for a full backfill.
> Parse the output and report ingested session counts.

**User wants to ingest only recent sessions**

> Run `selftune ingest claude --since <date>` with the user's specified date.

**User wants to re-ingest everything from scratch**

> Run `selftune ingest claude --force`. This ignores the marker file and
> rescans all transcripts.

**Agent needs to verify ingestion succeeded**

> Run `selftune doctor` after ingestion. Parse the JSON output to check
> that log file entry counts increased.
