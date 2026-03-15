# selftune Composability Workflow

Analyze how skills interact when triggered together in the same session.
Detects conflict candidates — skill pairs that produce more errors when
co-occurring than when used alone.

## Default Command

```bash
selftune eval composability --skill <name> [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--skill <name>` | Skill to analyze | Required |
| `--window <n>` | Only analyze sessions from last N days | All sessions |
| `--telemetry-log <path>` | Path to telemetry log | `~/.claude/session_telemetry_log.jsonl` |

## Output Format

```json
{
  "skill_name": "Research",
  "analyzed_sessions": 150,
  "co_occurring_skills": [
    {
      "skill_a": "Research",
      "skill_b": "Browser",
      "co_occurrence_count": 42,
      "conflict_score": 0.12,
      "avg_errors_together": 1.5,
      "avg_errors_alone": 1.3
    }
  ],
  "conflict_candidates": [
    {
      "skill_a": "Research",
      "skill_b": "Content",
      "co_occurrence_count": 15,
      "conflict_score": 0.45,
      "avg_errors_together": 3.2,
      "avg_errors_alone": 1.1
    }
  ],
  "generated_at": "2026-03-04T12:00:00.000Z"
}
```

## How It Works

The analyzer is a pure function that computes conflict scores from telemetry:

1. Filters sessions where `skills_triggered` includes the target skill
2. For each co-occurring skill, computes:
   - Average errors when both skills are triggered together
   - Average errors when each skill is triggered alone
   - `conflict_score = clamp((errors_together - errors_alone) / (errors_alone + 1), 0, 1)`
3. Pairs with `conflict_score > 0.3` are flagged as conflict candidates
4. Results sorted by co-occurrence count (most common first)

## Steps

### 1. Run Analysis

```bash
selftune eval composability --skill Research
```

### 2. Interpret Results

| Conflict Score | Interpretation |
|---------------|---------------|
| 0.0–0.1 | No conflict — skills work well together |
| 0.1–0.3 | Minor friction — monitor but no action needed |
| 0.3–0.6 | Moderate conflict — investigate trigger overlap |
| 0.6–1.0 | Severe conflict — skills likely interfere with each other |

### 3. Address Conflicts

When conflict candidates are identified, present them to the user with recommended actions:
- Check for trigger keyword overlap between the skills
- Check if one skill's workflow interferes with the other's
- Consider evolving descriptions to reduce false triggers
- Use the `pattern-analyst` agent for deeper cross-skill analysis

## Subagent Escalation

For deep cross-skill analysis beyond what the composability command provides,
spawn the `pattern-analyst` agent as a subagent. This is useful when conflict
scores are high (> 0.3) and you need a full resolution plan with trigger
ownership recommendations.

## Common Patterns

**"Are there conflicts between my skills?"**
> `selftune eval composability --skill Research`

**"Check composability for recent sessions only"**
> `selftune eval composability --skill pptx --window 7`

**"Which skills conflict with Research?"**
> Run composability and check the `conflict_candidates` array.

**"Why are sessions with multiple skills failing?"**
> Run composability for each skill involved, look for high conflict scores.
