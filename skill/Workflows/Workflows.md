# selftune Workflows Workflow

Discover repeated multi-skill sequences from telemetry and optionally save a
discovered workflow into a skill's `## Workflows` section.

## Default Commands

```bash
selftune workflows [options]
selftune workflows save <workflow-id|index> [--skill-path <path>]
```

## Options

- `--min-occurrences <n>`: Minimum times a workflow must appear before it is
  shown. Default: `3`.
- `--window <n>`: Only analyze the last `n` sessions. Default: all sessions.
- `--skill <name>`: Only show workflows containing this skill. Default: all
  skills.
- `--json`: Emit machine-readable `WorkflowDiscoveryReport` JSON. Default:
  human-readable text.
- `--skill-path <path>`: Target SKILL.md when using `save`. Default:
  auto-detect the first skill's SKILL.md path across contributing sessions. If
  that skill maps to multiple SKILL.md files in those sessions, the command
  errors and you must pass `--skill-path` explicitly.

## Save Semantics

`save` accepts either:

- A workflow ID, which is the ordered skill chain joined with `→`
- A 1-based index from the `selftune workflows` output

Examples:

```bash
selftune workflows save "Copywriting→MarketingAutomation→SelfTuneBlog"
selftune workflows save 1
```

When saved, selftune appends a subsection to `## Workflows` in the target
SKILL.md. The subsection name is derived from the skill chain
(`Copywriting-MarketingAutomation-SelfTuneBlog`) and includes
discovered-source metadata with occurrence count and synergy score.

## Output Format

### Human-readable output

The number prefix (for example, `1.`) is the 1-based index you can pass to
`selftune workflows save <index>`.

```text
Discovered Workflows (from 450 sessions):

  1. Copywriting → MarketingAutomation → SelfTuneBlog
     Occurrences: 12 | Synergy: 0.72 | Consistency: 92% | Completion: 83%
     Common trigger: "write and publish a blog post"
```

### JSON output

```json
{
  "workflows": [
    {
      "workflow_id": "Copywriting→MarketingAutomation→SelfTuneBlog",
      "skills": ["Copywriting", "MarketingAutomation", "SelfTuneBlog"],
      "occurrence_count": 12,
      "avg_errors": 0.5,
      "avg_errors_individual": 1.8,
      "synergy_score": 0.72,
      "representative_query": "write and publish a blog post",
      "sequence_consistency": 0.92,
      "completion_rate": 0.83,
      "first_seen": "2026-03-01T10:00:00Z",
      "last_seen": "2026-03-08T16:30:00Z",
      "session_ids": ["s1", "s2"]
    }
  ],
  "total_sessions_analyzed": 450,
  "generated_at": "2026-03-09T12:00:00.000Z"
}
```

## How It Works

1. Reads `session_telemetry_log.jsonl` and `skill_usage_log.jsonl`
2. Orders skill usage inside each session by timestamp
3. Deduplicates consecutive same-skill entries
4. Keeps only sequences with 2+ skills
5. Counts repeated ordered sequences across sessions
6. Computes workflow metrics:
   - `synergy_score` — whether the sequence performs better together than solo
     baselines, where each skill's solo baseline is its average error rate from
     single-skill sessions and the workflow uses the max of those solo rates
   - `sequence_consistency` — how stable the ordering is for the same skill
     set
   - `completion_rate` — how often all skills in the sequence fire
7. Filters by `--min-occurrences` and optional `--skill`
8. Optionally appends the chosen workflow to SKILL.md via `save`

## Interpreting Results

- `synergy_score > 0.3`: Strong candidate for codifying as a workflow.
- `synergy_score < -0.3`: The sequence adds friction or conflicts.
- Low `sequence_consistency`: Same skills appear in multiple orders; the
  pattern may still be unstable.
- Low `completion_rate`: One or more skills in the sequence often are not
  invoked, so the full workflow does not complete.

## Common Patterns

- "Which skills always get used together?"  
  `selftune workflows`
- "Only show workflows involving Deploy"  
  `selftune workflows --skill Deploy`
- "Focus on recent behavior"  
  `selftune workflows --window 20`
- "Save the top workflow into SKILL.md"  
  `selftune workflows save 1 --skill-path /path/to/SKILL.md`
- "Save a specific discovered workflow by ID"  
  `selftune workflows save "Copywriting→MarketingAutomation→SelfTuneBlog"`
