# selftune Composability Workflow

Analyze how skills interact when triggered together in the same session.
Detects conflict candidates — skill pairs that produce more errors when
co-occurring than when used alone.

Use the same workflow when the user is asking whether a sibling skill family
should stay split apart or be consolidated under one parent skill.

## Default Command

```bash
selftune eval composability --skill <name> [options]
```

## Family Overlap Command

```bash
selftune eval family-overlap --prefix <family-> [options]
```

Or analyze an explicit set of siblings:

```bash
selftune eval family-overlap --skills <skill-a,skill-b,skill-c> [options]
```

## Options

| Flag                     | Description                            | Default                                 |
| ------------------------ | -------------------------------------- | --------------------------------------- |
| `--skill <name>`         | Skill to analyze                       | Required                                |
| `--window <n>`           | Only analyze sessions from last N days | All sessions                            |
| `--telemetry-log <path>` | Path to telemetry log                  | `~/.claude/session_telemetry_log.jsonl` |

### Family Overlap Options

| Flag                    | Description                                                        | Default |
| ----------------------- | ------------------------------------------------------------------ | ------- |
| `--prefix <family->`    | Analyze all installed/observed sibling skills with this prefix     | Required unless `--skills` |
| `--skills <a,b,c>`      | Analyze a specific skill family                                    | Required unless `--prefix` |
| `--parent-skill <name>` | Override the suggested consolidated parent skill name              | Derived from prefix |
| `--min-overlap <pct>`   | Minimum positive-query overlap to flag consolidation pressure      | `0.3` |
| `--min-shared <n>`      | Minimum shared positive queries to flag a sibling pair             | `2` |

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

## How Family Overlap Works

The family-overlap analyzer answers a different question:

1. Build a trusted positive query set for each sibling skill
2. Compare every pair of siblings using exact-query overlap
3. Flag pairs whose overlap crosses the configured threshold
4. If overlap is persistent across the family, emit:
   - consolidation recommendation
   - draft parent skill name
   - internal workflow mapping
   - compatibility alias / migration notes

This is for packaging questions like:

- "Should `sc-search`, `sc-model`, and `sc-compare` really be one parent skill?"
- "Are my sibling skills competing for the same user intent?"
- "Should I stop evolving these independently and redesign the family?"

## Steps

### 1. Run Analysis

```bash
selftune eval composability --skill Research
```

### 2. Interpret Results

| Conflict Score | Interpretation                                            |
| -------------- | --------------------------------------------------------- |
| 0.0–0.1        | No conflict — skills work well together                   |
| 0.1–0.3        | Minor friction — monitor but no action needed             |
| 0.3–0.6        | Moderate conflict — investigate trigger overlap           |
| 0.6–1.0        | Severe conflict — skills likely interfere with each other |

### 3. Address Conflicts

When conflict candidates are identified, present them to the user with recommended actions:

- Check for trigger keyword overlap between the skills
- Check if one skill's workflow interferes with the other's
- Consider evolving descriptions to reduce false triggers
- Use the `pattern-analyst` agent for deeper cross-skill analysis

### 4. Investigate Family Consolidation

```bash
selftune eval family-overlap --prefix sc-
```

Interpretation:

- `consolidation_candidate: false` means keep improving the sibling descriptions/workflows separately
- `consolidation_candidate: true` means the problem is likely packaging, not just wording
- `refactor_proposal` is a draft for human review only; do not auto-deploy a family rewrite

## Subagent Escalation

For deep cross-skill analysis beyond what the composability command provides,
read `skill/agents/pattern-analyst.md` and spawn a subagent with those instructions.
This is useful when conflict scores are high (> 0.3) and you need a full
resolution plan with trigger ownership recommendations.

## Common Patterns

**"Are there conflicts between my skills?"**

> `selftune eval composability --skill Research`

**"Check composability for recent sessions only"**

> `selftune eval composability --skill pptx --window 7`

**"Which skills conflict with Research?"**

> Run composability and check the `conflict_candidates` array.

**"Why are sessions with multiple skills failing?"**

> Run composability for each skill involved, look for high conflict scores.

**"Are my State Change skills too fragmented?"**

> `selftune eval family-overlap --prefix sc-`

**"Should I consolidate this sibling skill family?"**

> Run `selftune eval family-overlap` and look for `consolidation_candidate` plus the `refactor_proposal`.
