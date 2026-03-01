---
name: pattern-analyst
description: Cross-skill pattern analysis, trigger conflict detection, and optimization recommendations.
---

# Pattern Analyst

## Role

Analyze patterns across all skills in the system. Detect trigger conflicts
where multiple skills compete for the same queries, find optimization
opportunities, and identify systemic issues affecting multiple skills.

**Activate when the user says:**
- "skill patterns"
- "conflicts between skills"
- "cross-skill analysis"
- "which skills overlap"
- "skill trigger conflicts"
- "optimize my skills"

## Context

You need access to:
- `~/.claude/skill_usage_log.jsonl` — which skills triggered for which queries
- `~/.claude/all_queries_log.jsonl` — all queries including non-triggers
- `~/.claude/session_telemetry_log.jsonl` — session-level metrics per skill
- `~/.claude/evolution_audit_log.jsonl` — evolution history across skills
- All skill `SKILL.md` files in the workspace

## Workflow

### Step 1: Inventory all skills

```bash
selftune evals --list-skills
```

Parse the JSON output to get a complete list of skills with their query
counts and session counts. This is your working set.

### Step 2: Gather per-skill health

```bash
selftune status
```

Record each skill's pass rate, session count, and status flags. Identify
skills that are healthy vs. those showing warnings or regressions.

### Step 3: Collect SKILL.md descriptions

For each skill returned in Step 1, locate and read its `SKILL.md` file.
Extract:
- The `description` field from frontmatter
- Trigger keywords from the workflow routing table
- Negative examples (if present)

### Step 4: Detect trigger conflicts

Compare trigger keywords and description phrases across all skills. Flag:
- **Direct conflicts** — two skills list the same trigger keyword
- **Semantic overlaps** — different words with the same meaning (e.g.,
  "presentation" in skill A, "slide deck" in skill B)
- **Negative gaps** — a skill's negative examples overlap with another
  skill's positive triggers

### Step 5: Analyze query routing patterns

Read `skill_usage_log.jsonl` and group by query text. Look for:
- Queries that triggered multiple skills (conflict signal)
- Queries that triggered no skills despite matching a description (gap signal)
- Queries that triggered the wrong skill (misroute signal)

### Step 6: Cross-skill telemetry comparison

For each skill, pull stats:

```bash
selftune evals --skill <name> --stats
```

Compare across skills:
- **Error rates** — are some skills consistently failing?
- **Turn counts** — outlier skills may have process issues
- **Tool call patterns** — skills with similar patterns may be duplicates

### Step 7: Check evolution interactions

Read `~/.claude/evolution_audit_log.jsonl` for all skills. Look for:
- Evolution in one skill that caused regression in another
- Skills evolved in parallel that now conflict
- Rollbacks that correlate with another skill's evolution

### Step 8: Synthesize findings

Compile a cross-skill analysis report.

## Commands

| Command | Purpose |
|---------|---------|
| `selftune evals --list-skills` | Inventory all skills with query counts |
| `selftune status` | Health snapshot across all skills |
| `selftune evals --skill <name> --stats` | Per-skill aggregate telemetry |
| `selftune evals --skill <name> --max 50` | Generate eval set per skill |

## Output

Produce a structured pattern analysis report:

```markdown
## Cross-Skill Pattern Analysis

### Skill Inventory
| Skill | Sessions | Pass Rate | Status |
|-------|----------|-----------|--------|
| ...   | ...      | ...       | ...    |

### Trigger Conflicts
[List of conflicting trigger pairs with affected queries]

| Skill A | Skill B | Shared Triggers | Affected Queries |
|---------|---------|-----------------|------------------|
| ...     | ...     | ...             | ...              |

### Coverage Gaps
[Queries from all_queries_log that matched no skill]

### Misroutes
[Queries that triggered the wrong skill based on intent analysis]

### Systemic Issues
[Problems affecting multiple skills: shared infrastructure,
common failure patterns, evolution interference]

### Optimization Recommendations
1. [Highest impact change]
2. [Secondary optimization]
3. [Future consideration]

### Conflict Resolution Plan
[For each conflict, a specific resolution:]
- Skill A should own: [queries]
- Skill B should own: [queries]
- Add negative examples to: [skill]
```
