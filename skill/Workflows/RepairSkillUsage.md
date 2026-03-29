# selftune Repair Skill Usage Workflow

Rebuild trustworthy skill-usage records by replaying Claude Code transcripts
and Codex rollouts. Produces a repaired overlay (`skill_usage_repaired.jsonl`)
that corrects missing or inaccurate skill paths, scopes, and query associations
from the raw hook-captured data.

## When to Use

- Skill usage data appears incomplete or has missing `skill_path` values
- The user says "repair", "rebuild usage", "fix skill usage", or "trustworthy usage"
- Before evolution or grading when hook data may be unreliable
- After changing skill directory layouts or reinstalling skills

## Default Command

```bash
selftune repair-skill-usage
```

## Options

| Flag                        | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| `--projects-dir <dir>`      | Claude transcript directory (default: `~/.claude/projects`) |
| `--codex-home <dir>`        | Codex home directory (default: `~/.codex`)               |
| `--since <date>`            | Only repair sessions modified on/after this date         |
| `--out <path>`              | Repaired overlay log output path                         |
| `--sessions-marker <path>`  | Repaired session-id marker file path                     |
| `--skill-log <path>`        | Raw skill usage log path (for path lookup bootstrap)     |
| `--dry-run`                 | Show summary counts without writing files                |
| `--help`                    | Show usage information                                   |

## How It Works

1. **Discover transcripts** — Finds all Claude Code transcript JSONL files under `--projects-dir` and Codex rollout files under `--codex-home`.
2. **Bootstrap path lookup** — Reads existing skill usage records from SQLite (or `--skill-log` JSONL) to build a skill-name-to-path lookup table.
3. **Replay transcripts** — For each transcript, parses the conversation to find Skill tool invocations, associates them with the preceding user query, and resolves skill paths via installed-scope discovery or the lookup table.
4. **Replay Codex rollouts** — Same process for Codex rollout files, using Codex-specific path resolution.
5. **Write repaired overlay** — Writes deduplicated records to the repaired log and updates the session marker.

## Output Format

JSON summary printed to stdout:

```json
{
  "transcripts_scanned": 42,
  "codex_rollouts_scanned": 8,
  "repaired_sessions": 35,
  "repaired_records": 127,
  "codex_repaired_records": 12,
  "unique_matched_queries": 98,
  "reins_queries_seen": 5,
  "reins_skill_matches": 3,
  "output": "~/.claude/skill_usage_repaired.jsonl"
}
```

With `--dry-run`, the same summary is printed but no files are written.

## Common Patterns

**Preview repair scope**

> Run `selftune repair-skill-usage --dry-run` to see how many sessions and records would be repaired.

**Repair only recent sessions**

> Run `selftune repair-skill-usage --since 2025-01-01` to limit the repair to sessions from this year.

**Full rebuild from scratch**

> Run `selftune repair-skill-usage` without `--since` to rebuild the entire overlay from all available transcripts.

**Agent chaining into evolution**

> Run repair before evolution to ensure skill usage data is accurate: `selftune repair-skill-usage && selftune evolve --skill my-skill`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `repaired_records: 0` | No Skill tool invocations found in transcripts | Verify skills are being invoked in sessions; check `selftune status` |
| Many `(repaired:name)` paths | Skill not installed or path not discoverable | Install the skill or provide a `--skill-log` with known paths |
| `transcripts_scanned: 0` | No transcripts in projects directory | Verify `~/.claude/projects/` contains session directories |
| Invalid `--since` date error | Date format not parseable | Use ISO format: `--since 2025-01-15` |
