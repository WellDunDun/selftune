# selftune Import SkillsBench Workflow

Import evaluation tasks from the SkillsBench corpus (87 real-world agent
benchmarks) and convert them to selftune eval entries. This enriches
your skill's eval set with externally validated test cases.

## Default Command

```bash
selftune import-skillsbench --dir <path> --skill <name> --output <path> [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--dir <path>` | Path to SkillsBench tasks directory | Required |
| `--skill <name>` | Target skill to match tasks against | Required |
| `--output <path>` | Output eval set JSON file | Required |
| `--match-strategy <type>` | Matching strategy: `exact` or `fuzzy` | `exact` |

## Match Strategies

### `exact`

Matches tasks where `expected_skill` in `task.toml` exactly matches the
target skill name. Precise but may miss relevant tasks.

### `fuzzy`

Uses keyword overlap between the task's category/tags and the skill name.
Casts a wider net but may include marginally relevant tasks. Review the
output and remove false matches.

## SkillsBench Directory Structure

The importer expects this layout:

```
tasks/
├── task-001/
│   ├── instruction.md     # Task description (used as query)
│   └── task.toml          # Metadata (difficulty, category, tags, expected_skill)
├── task-002/
│   ├── instruction.md
│   └── task.toml
└── ...
```

### `task.toml` Format

```toml
difficulty = "medium"
category = "research"
tags = ["web-search", "analysis", "summarization"]
expected_skill = "Research"
expected_tools = ["WebSearch", "Read"]
```

All fields are optional. Tasks without `task.toml` use default values.

## Output Format

Standard selftune eval entries:

```json
[
  {
    "id": 1,
    "query": "Find and summarize the latest papers on transformer architectures",
    "expected": true,
    "invocation_type": "implicit",
    "skill_name": "Research",
    "source_session": null,
    "source": "skillsbench"
  }
]
```

## Steps

### 1. Obtain SkillsBench Corpus

Clone or download the SkillsBench repository containing the task directory.

### 2. Import Tasks

```bash
selftune import-skillsbench --dir /path/to/skillsbench/tasks --skill Research --output evals-bench.json
```

### 3. Review Output

Inspect the generated eval entries. Remove any that don't match your skill's
intended scope. Adjust match strategy if needed.

### 4. Merge with Existing Evals

Combine imported entries with your existing eval set for a richer validation
corpus. Use the merged set with `selftune evolve --eval-set merged-evals.json`.

## Common Patterns

**"Import SkillsBench tasks for Research"**
> `selftune import-skillsbench --dir /path/tasks --skill Research --output bench-evals.json`

**"Use fuzzy matching for broader coverage"**
> `selftune import-skillsbench --dir /path/tasks --skill pptx --output bench-evals.json --match-strategy fuzzy`

**"Enrich my eval set with external benchmarks"**
> Import with `import-skillsbench`, then pass the output to `evolve --eval-set`.
