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

## Recommended Creator Loop

Use eval generation as step 1 of the default creator loop:

```bash
selftune eval generate --skill <name>
selftune eval unit-test --skill <name> --generate --skill-path <path>
selftune evolve --skill <name> --skill-path <path> --dry-run --validation-mode replay
selftune grade baseline --skill <name> --skill-path <path>
selftune evolve --skill <name> --skill-path <path> --with-baseline
selftune watch --skill <name>
```

The command still writes the requested output path, and it now also mirrors a canonical copy into
`~/.selftune/eval-sets/<skill>.json` so the dashboard and `selftune status` can track whether eval
coverage exists. Once the earlier steps are complete, the creator loop surfaces now flip from
"needs testing" to "ready to deploy" and then "watching" after ship.

## Options

| Flag                               | Description                                           | Default                           |
| ---------------------------------- | ----------------------------------------------------- | --------------------------------- |
| `--skill <name>`                   | Skill to generate evals for                           | Required (unless `--list-skills`) |
| `--list-skills`                    | List skills with trusted-vs-raw readiness counts      | Off                               |
| `--stats`                          | Show aggregate telemetry stats for the skill          | Off                               |
| `--max <n>`                        | Maximum eval entries per side                         | 50                                |
| `--seed <n>`                       | Seed for deterministic shuffling                      | 42                                |
| `--output <path>` / `--out <path>` | Output file path                                      | `{skillName}_trigger_eval.json`   |
| `--no-negatives`                   | Exclude negative examples from output                 | Off                               |
| `--no-taxonomy`                    | Skip invocation_type classification                   | Off                               |
| `--skill-log <path>`               | Path to skill_usage_log.jsonl                         | Default log path                  |
| `--query-log <path>`               | Path to all_queries_log.jsonl                         | Default log path                  |
| `--telemetry-log <path>`           | Path to session_telemetry_log.jsonl                   | Default log path                  |
| `--synthetic`                      | Generate evals from SKILL.md via LLM (no logs needed) | Off                               |
| `--auto-synthetic`                 | Fall back to SKILL.md-based cold-start evals when no trusted triggers exist | Off                  |
| `--skill-path <path>`              | Path to SKILL.md (required with `--synthetic`)        | —                                 |
| `--model <model>`                  | LLM model to use for synthetic generation             | Agent default                     |
| `--blend`                          | Blend log-based and synthetic evals into one set      | Off                               |
| `--help`                           | Show command help                                     | Off                               |

## Output Format

### Eval Set (default)

```json
[
  {
    "query": "Make me a slide deck for the Q3 board meeting",
    "should_trigger": true,
    "invocation_type": "contextual",
    "source": "log",
    "created_at": "2026-04-01T12:00:00Z"
  },
  {
    "query": "What format should I use for a presentation?",
    "should_trigger": false,
    "source": "synthetic"
  }
]
```

Each entry has `query` (string, max 500 chars), `should_trigger` (boolean),
and optional `invocation_type` (omitted when `--no-taxonomy` is set).

Entries also carry optional provenance fields:

- `source` — `"log"` (from real usage logs), `"synthetic"` (LLM-generated from SKILL.md), or `"blended"` (synthetic entry that survived dedup in a blended set)
- `created_at` — ISO timestamp of when the entry was created

Use `computeEvalSourceStats(entries)` to get aggregate provenance statistics:

```json
{
  "total": 80,
  "synthetic": 10,
  "log": 50,
  "blended": 20,
  "oldest": "2026-03-01T00:00:00Z",
  "newest": "2026-04-01T12:00:00Z"
}
```

### List Skills

```json
{
  "skills": [
    {
      "name": "pptx",
      "trusted_trigger_count": 42,
      "raw_trigger_count": 42,
      "trusted_session_count": 15,
      "raw_session_count": 15,
      "readiness": "log-ready"
    },
    {
      "name": "sc-search",
      "trusted_trigger_count": 0,
      "raw_trigger_count": 1,
      "trusted_session_count": 0,
      "raw_session_count": 1,
      "readiness": "cold-start"
    }
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
# Parse: .[] | select(.should_trigger == true and .invocation_type != "explicit")
# These are queries that should trigger but might be missed
```

### Get Negative Examples

```bash
# Parse: .[] | select(.should_trigger == false)
```

## Sub-Workflows

### List Skills

Discover which skills have telemetry data and how many queries each has.

```bash
selftune eval generate --list-skills
```

Run this first to identify which skills have enough trusted data for eval generation.
Installed skills with no trusted trigger history now appear as `cold-start`, which means the
skill is installed locally and ready for `--auto-synthetic` / `--synthetic` eval generation.
If raw trigger history exists but trusted positives do not, the list now shows both counts so the
creator can see that telemetry exists without being misled into thinking the skill is fully ready.

### Generate Synthetic Evals (Cold Start)

When a skill has no telemetry data yet, use `--synthetic` to generate eval
queries directly from the SKILL.md content via an LLM.

```bash
selftune eval generate --skill pptx --synthetic --skill-path /path/to/skills/pptx/SKILL.md
```

If the skill is installed locally but has no trusted trigger history yet, use the faster creator
onboarding path:

```bash
selftune eval generate --skill pptx --auto-synthetic --skill-path /path/to/skills/pptx/SKILL.md
```

`--auto-synthetic` keeps the normal log-based path when real trigger data exists, but falls back
to synthetic cold-start generation when it does not.

The command:

1. Reads the SKILL.md file content
2. Loads real user queries from the database (if available) as few-shot style examples so synthetic queries match real phrasing patterns
3. Detects nearby installed sibling skills to generate harder negative controls
4. Over-generates a candidate pool with a balanced prompt family mix (explicit / implicit / contextual positives plus sibling-confusion / adjacent / unrelated negatives)
5. Runs a second critique/prune pass to remove weak paraphrases, overlaps, and blurry boundary cases
6. Parses the response into eval entries with invocation type annotations
7. Classifies each positive query using the deterministic `classifyInvocation()` heuristic
8. Writes the eval set to the output file

**Note:** When real query data exists in the database, synthetic generation
automatically includes high-confidence positive triggers and general queries as
phrasing references. This produces more natural-sounding eval queries. If no
database is available, generation proceeds without real examples (fail-open).

The synthetic cold-start path is intentionally small and targeted. It is meant to bootstrap a
creator skill into its first supervised evolution cycle, not serve as the long-term source of
truth once real telemetry exists.

Use `--model` to override the default LLM model:

```bash
selftune eval generate --skill pptx --synthetic --skill-path ./skills/pptx/SKILL.md --model claude-sonnet-4-5-20250514
```

### Generate Blended Evals

When a skill has real log data but you want to fill coverage gaps with synthetic
entries, use `--blend` to combine both sources into one eval set.

```bash
selftune eval generate --skill pptx --blend --skill-path /path/to/skills/pptx/SKILL.md
```

The blending policy:

1. Keep ALL log-based entries (marked `source: "log"`)
2. Generate synthetic entries from SKILL.md
3. Deduplicate: drop any synthetic entry whose normalized Levenshtein distance to any log entry is < 0.3
4. Mark surviving synthetic entries as `source: "blended"`
5. Cap total entries at 2x the log-based count

This preserves real-world boundary cases from logs while filling underrepresented
invocation types with synthetic entries. The 2x cap prevents synthetic entries from
overwhelming log signal.

`--blend` requires a resolvable SKILL.md path. Use `--skill-path` or install the
skill locally so selftune can find it.

### Generate Evals (Log-Based)

Cross-reference `skill_usage_log.jsonl` (positive triggers) against
`all_queries_log.jsonl` (all queries, including non-triggers) to produce
an eval set annotated with invocation types.

```bash
selftune eval generate --skill pptx --max 50 --output evals-pptx.json
```

The command:

1. Reads positive triggers from `skill_usage_log.jsonl`
2. Reads all queries from `all_queries_log.jsonl`
3. Identifies queries that should have triggered but did not
4. Samples negative examples (unrelated queries)
5. Annotates each entry with invocation type
6. Writes the eval set to the output file

After generation, the current validation path is:

```bash
selftune evolve --skill <name> --skill-path /path/to/SKILL.md --eval-set <generated-file> --dry-run
```

That dry run validates a proposal against the generated eval set without deploying.

If the selected skill has no trusted positives yet but selftune can resolve a local `SKILL.md`,
the command now prints the exact `--auto-synthetic` rerun hint instead of leaving the creator to
guess the cold-start path.

After reviewing a dry-run proposal, deploy by rerunning without `--dry-run`.

### Show Stats

View aggregate telemetry for a skill: average turns, tool call breakdown,
error rates, and common bash command patterns.

```bash
selftune eval generate --skill pptx --stats
```

## Steps

### 0. Pre-Flight Configuration

Before generating evals, use the `AskUserQuestion` tool to present structured configuration options.

If the user responds with "use defaults" or similar shorthand, skip to step 1 using the recommended defaults. If the user cancels, stop -- do not proceed with defaults.

For `--list-skills` or `--stats` requests, skip pre-flight entirely — these are read-only operations.

Ask one `AskUserQuestion` at a time in this order:

1. `Generation Mode`
   Options:
   - `Log-based — build from real usage logs (recommended if logs exist)`
   - `Synthetic — generate from SKILL.md via LLM (for new skills)`
2. If the user chose synthetic, ask `Model (for synthetic mode)`
   Options:
   - `Fast (haiku) — quick generation`
   - `Balanced (sonnet) — better diversity (recommended)`
   - `Best (opus) — highest quality`
3. Ask `Max Entries`
   Options:
   - `50 (default)`
   - `25 (quick)`
   - `100 (comprehensive)`

If `AskUserQuestion` is not available or Claude does not invoke it, fall back to presenting the same choices as inline numbered options.

After the user responds, parse their selections and map each choice to the corresponding CLI flags:

| Selection          | CLI Flag                                          |
| ------------------ | ------------------------------------------------- |
| 1a (log-based)     | _(no flag, default)_                              |
| 1b (synthetic)     | `--synthetic --skill-path <path>`                 |
| Custom max entries | `--max <value>`                                   |
| 4a (haiku)         | `--model haiku` (resolved internally by selftune) |
| 4b (sonnet)        | `--model sonnet`                                  |
| 4c (opus)          | `--model opus`                                    |
| Custom output path | `--out <path>`                                    |

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
