# selftune Evals Workflow

Generate eval sets from hook logs. Detects false negatives (queries that
should have triggered a skill but did not) and annotates each entry with
its invocation type.

## When to Invoke

Invoke this workflow when the user requests any of the following:
- Generating eval sets or test data for a skill
- Checking which skills are undertriggering
- Viewing skill telemetry or usage stats
- Preparing data before running the Evolve workflow
- Any request containing "evals", "eval set", "test queries", or "skill stats"

## Default Command

```bash
selftune eval generate --skill <name> [options]
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
| `--synthetic` | Generate evals from SKILL.md via LLM (no logs needed) | Off |
| `--skill-path <path>` | Path to SKILL.md (required with `--synthetic`) | — |
| `--model <model>` | LLM model to use for synthetic generation | Agent default |

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
selftune eval generate --list-skills
```

Run this first to identify which skills have enough data for eval generation.

### Generate Synthetic Evals (Cold Start)

When a skill has no telemetry data yet, use `--synthetic` to generate eval
queries directly from the SKILL.md content via an LLM.

```bash
selftune eval generate --skill pptx --synthetic --skill-path /path/to/skills/pptx/SKILL.md
```

The command:
1. Reads the SKILL.md file content
2. Sends it to an LLM with a prompt requesting realistic test queries
3. Parses the response into eval entries with invocation type annotations
4. Classifies each positive query using the deterministic `classifyInvocation()` heuristic
5. Writes the eval set to the output file

Use `--model` to override the default LLM model:

```bash
selftune eval generate --skill pptx --synthetic --skill-path ./skills/pptx/SKILL.md --model claude-sonnet-4-5-20250514
```

### Generate Evals (Log-Based)

Cross-reference `skill_usage_log.jsonl` (positive triggers) against
`all_queries_log.jsonl` (all queries, including non-triggers) to produce
an eval set annotated with invocation types.

```bash
selftune eval generate --skill pptx --max 50 --out evals-pptx.json
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
selftune eval generate --skill pptx --stats
```

## Steps

### 0. Pre-Flight Configuration

Before generating evals, use the `AskUserQuestion` tool to present structured configuration options.

If the user responds with "use defaults", cancels, or similar shorthand, skip to step 1 using the recommended defaults.

For `--list-skills` or `--stats` requests, skip pre-flight entirely — these are read-only operations.

Use `AskUserQuestion` with these questions:

```json
{
  "questions": [
    {
      "question": "Generation Mode",
      "options": ["Log-based — build from real usage logs (recommended if logs exist)", "Synthetic — generate from SKILL.md via LLM (for new skills)"]
    },
    {
      "question": "Model (for synthetic mode)",
      "options": ["Fast (haiku) — quick generation", "Balanced (sonnet) — better diversity (recommended)", "Best (opus) — highest quality"]
    },
    {
      "question": "Max Entries",
      "options": ["50 (default)", "25 (quick)", "100 (comprehensive)"]
    }
  ]
}
```

If `AskUserQuestion` is not available, fall back to presenting these as inline numbered options.

After the user responds, parse their selections and map each choice to the corresponding CLI flags:

| Selection | CLI Flag |
|-----------|----------|
| 1a (log-based) | _(no flag, default)_ |
| 1b (synthetic) | `--synthetic --skill-path <path>` |
| Custom max entries | `--max <value>` |
| 4a (haiku) | `--model haiku` (resolved internally by selftune) |
| 4b (sonnet) | `--model sonnet` |
| 4c (opus) | `--model opus` |
| Custom output path | `--out <path>` |

Show a confirmation summary to the user:

```text
Configuration Summary:
  Mode:          log-based
  Max entries:   50
  Output:        evals-pptx.json

Proceeding...
```

Build the CLI command string with all selected flags and continue to step 1.

### 1. List Available Skills

Run `selftune eval generate --list-skills` to see what skills have telemetry data. If the target
skill has zero or very few queries, more sessions are needed before
eval generation is useful.

### 2. Generate the Eval Set

Run with `--skill <name>`. Parse the JSON output and review for:
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

**User asks which skills are undertriggering:**
Run `selftune eval generate --list-skills`, then for each skill with significant query counts,
generate evals and check for missed implicit/contextual queries.

**User asks to generate evals for a specific skill:**
Run `selftune eval generate --skill <name>`. Parse the JSON output and review the invocation type distribution.
Feed the output to the Evolve workflow if coverage gaps exist.

**User asks for skill telemetry or stats:**
Run `selftune eval generate --skill <name> --stats` for aggregate telemetry.

**User has a new skill with no usage data:**
Use `selftune eval generate --skill <name> --synthetic --skill-path /path/to/SKILL.md`.
This generates eval queries from the skill description without needing session logs.

**User wants reproducible evals:**
Add `--seed <n>` to fix the random sampling of negative examples.
