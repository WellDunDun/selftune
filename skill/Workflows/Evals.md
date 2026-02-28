# selftune Evals Workflow

Generate eval sets from hook logs. Detects false negatives (queries that
should have triggered a skill but did not) and annotates each entry with
its invocation type.

## Default Command

```bash
CLI_PATH=$(cat ~/.selftune/config.json | jq -r .cli_path)
bun run $CLI_PATH evals --skill <name> [options]
```

Fallback:
```bash
bun run <repo-path>/cli/selftune/index.ts evals --skill <name> [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--skill <name>` | Skill to generate evals for | Required (unless `--list-skills`) |
| `--list-skills` | List all logged skills with query counts | Off |
| `--stats` | Show aggregate telemetry stats for the skill | Off |
| `--max <n>` | Maximum eval entries to generate | 50 |
| `--seed <n>` | Random seed for negative sampling | Random |
| `--out <path>` | Output file path | `evals-<skill>.json` |

## Output Format

### Eval Set (default)

```json
[
  {
    "id": 1,
    "query": "Make me a slide deck for the Q3 board meeting",
    "expected": true,
    "invocation_type": "contextual",
    "skill_name": "pptx",
    "source_session": "abc123"
  },
  {
    "id": 2,
    "query": "What format should I use for a presentation?",
    "expected": false,
    "invocation_type": "negative",
    "skill_name": "pptx",
    "source_session": null
  }
]
```

### List Skills

```json
{
  "skills": [
    { "name": "pptx", "query_count": 42, "session_count": 15 },
    { "name": "selftune", "query_count": 28, "session_count": 10 }
  ]
}
```

### Stats

```json
{
  "skill_name": "pptx",
  "sessions": 15,
  "avg_turns": 4.2,
  "tool_call_breakdown": { "Read": 30, "Write": 15, "Bash": 45 },
  "error_rate": 0.13,
  "bash_patterns": ["pip install python-pptx", "python3 /tmp/create_pptx.py"]
}
```

## Parsing Instructions

### Count by Invocation Type

```bash
# Parse: group_by(.invocation_type) | map({ type: .[0].invocation_type, count: length })
```

### Find Missed Queries (False Negatives)

```bash
# Parse: .[] | select(.expected == true and .invocation_type != "explicit")
# These are queries that should trigger but might be missed
```

### Get Negative Examples

```bash
# Parse: .[] | select(.expected == false)
```

## Sub-Workflows

### List Skills

Discover which skills have telemetry data and how many queries each has.

```bash
CLI_PATH=$(cat ~/.selftune/config.json | jq -r .cli_path)
bun run $CLI_PATH evals --list-skills
```

Use this first to identify which skills have enough data for eval generation.

### Generate Evals

Cross-reference `skill_usage_log.jsonl` (positive triggers) against
`all_queries_log.jsonl` (all queries, including non-triggers) to produce
an eval set annotated with invocation types.

```bash
CLI_PATH=$(cat ~/.selftune/config.json | jq -r .cli_path)
bun run $CLI_PATH evals --skill pptx --max 50 --out evals-pptx.json
```

The command:
1. Reads positive triggers from `skill_usage_log.jsonl`
2. Reads all queries from `all_queries_log.jsonl`
3. Identifies queries that should have triggered but did not
4. Samples negative examples (unrelated queries)
5. Annotates each entry with invocation type
6. Writes the eval set to the output file

### Show Stats

View aggregate telemetry for a skill: average turns, tool call breakdown,
error rates, and common bash command patterns.

```bash
CLI_PATH=$(cat ~/.selftune/config.json | jq -r .cli_path)
bun run $CLI_PATH evals --skill pptx --stats
```

## Steps

### 1. List Available Skills

Run `--list-skills` to see what skills have telemetry data. If the target
skill has zero or very few queries, more sessions are needed before
eval generation is useful.

### 2. Generate the Eval Set

Run with `--skill <name>`. Review the output file for:
- Balance between positive and negative entries
- Coverage of all three positive invocation types (explicit, implicit, contextual)
- Reasonable negative examples (keyword overlap but wrong intent)

### 3. Review Invocation Type Distribution

A healthy eval set has:
- Some explicit queries (easy baseline)
- Many implicit queries (natural usage)
- Several contextual queries (real-world usage)
- Enough negatives to prevent false positives

See `references/invocation-taxonomy.md` for what each type means and
what healthy distribution looks like.

### 4. Identify Coverage Gaps

If the eval set is missing implicit or contextual queries, the skill may be
undertriggering. This is the signal for `evolve` to improve the description.

### 5. Optional: Check Stats

Use `--stats` to understand session patterns before evolution. High error
rates or unusual tool call distributions may indicate process issues
beyond trigger coverage.

## Common Patterns

**"What skills are undertriggering?"**
> Run `--list-skills`, then for each skill with significant query counts,
> generate evals and check for missed implicit/contextual queries.

**"Generate evals for pptx"**
> Run `evals --skill pptx`. Review the invocation type distribution.
> Feed the output to `evolve` if coverage gaps exist.

**"Show me skill stats"**
> Run `evals --skill <name> --stats` for aggregate telemetry.

**"I want reproducible evals"**
> Use `--seed <n>` to fix the random sampling of negative examples.
