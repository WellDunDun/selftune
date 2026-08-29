# selftune Unit Test Workflow

Run or generate unit tests for individual skills. Tests verify trigger
accuracy, output content, and tool usage with deterministic assertions.

## Default Command

```bash
selftune eval unit-test --skill <name> --tests <path> [options]
```

## Where selftune stores the contract and result

- Test definitions live in `<skill-dir>/evals/evals.json` when `--skill-path`
  is supplied. This portable, version-controlled file is the source of truth.
- `~/.selftune/unit-tests/<skill>.json` remains a compatibility mirror.
- The latest run summary is mirrored into `~/.selftune/unit-tests/<skill>.last-run.json`

The dashboard and `selftune status` read those files to decide whether a skill still needs test
generation or already has a passing suite.

## Options

| Flag                  | Description                                           | Default                               |
| --------------------- | ----------------------------------------------------- | ------------------------------------- |
| `--skill <name>`      | Skill name                                            | Required                              |
| `--tests <path>`      | Override or additional unit-test JSON path            | `<skill-dir>/evals/evals.json` when `--skill-path` is available |
| `--run-agent`         | Evaluate assertions against a real agent response     | Off                                   |
| `--generate`          | Generate tests from skill content instead of running  | Off                                   |
| `--skill-path <path>` | Path to SKILL.md used for richer generated tests      | Skill name only                       |
| `--eval-set <path>`   | Eval set for failure context (used with `--generate`) | None                                  |
| `--model <flag>`      | Model flag for LLM calls                              | Agent default                         |
| `--help`              | Show the typed unit-test command help                 | Off                                   |

## Test Format

Portable tests follow the Agent Skills `evals/evals.json` contract. Each case
has a realistic `prompt`, human-readable `expected_output`, optional `files`,
and human-readable `assertions`. SelfTune adds `selftune_assertions` as an
extension for deterministic execution:

```json
{
  "skill_name": "Research",
  "evals": [
    {
      "id": 1,
      "prompt": "Research the latest trends in AI safety",
      "expected_output": "A sourced summary of current AI safety trends.",
      "files": [],
      "assertions": ["The response addresses AI safety and cites sources"],
      "selftune_assertions": [
        {
          "type": "contains",
          "value": "AI safety",
          "description": "Response should address the requested topic"
        }
      ]
    }
  ]
}
```

## Assertion Types

| Type              | What it checks                          | Requires agent? |
| ----------------- | --------------------------------------- | --------------- |
| `contains`        | Transcript contains expected text       | No              |
| `not_contains`    | Transcript omits forbidden text         | No              |
| `regex`           | Transcript matches a regular expression | No              |
| `json_path`       | JSON output contains a `key=value`      | No              |
| `tool_called`     | Transcript records a tool call          | Yes             |
| `tool_not_called` | Transcript omits a tool call            | Yes             |

Without `--run-agent`, selftune evaluates assertions against the query text as
a deterministic dry-run. With `--run-agent`, it evaluates the same assertion
types against the full agent response.

## Output Format

```json
{
  "skill_name": "Research",
  "total": 10,
  "passed": 8,
  "failed": 2,
  "pass_rate": 0.8,
  "results": [
    {
      "test_id": "research-trigger-1",
      "passed": true,
      "assertion_results": [
        {
          "assertion": {
            "type": "contains",
            "value": "AI safety"
          },
          "passed": true,
          "actual": "AI safety"
        }
      ],
      "duration_ms": 450
    }
  ],
  "run_at": "2026-03-04T12:00:00.000Z"
}
```

## Steps

### 1. Generate Tests (First Time)

If no test file exists for the skill, generate initial tests:

```bash
selftune eval unit-test --skill Research --generate --skill-path ~/.claude/skills/Research/SKILL.md
```

Parse the output. The LLM creates test cases covering:

- Explicit trigger queries
- Implicit trigger queries
- Contextual trigger queries
- Negative examples (should NOT trigger)

Tests are saved to the package at `evals/evals.json` and mirrored to
`~/.selftune/unit-tests/Research.json` for compatibility.

### 2. Run Tests

Run the test suite:

```bash
selftune eval unit-test --skill Research --tests ~/.selftune/unit-tests/Research.json
```

By default, the query itself is used as a deterministic dry-run transcript.
Add `--run-agent` to evaluate assertions against a real agent response.

### 3. Parse Results

Parse the JSON output. Check `pass_rate` and investigate failures:

- Failed content assertions -- inspect the skill instructions and expected response
- Failed output assertions -- skill workflow needs fixes
- Failed tool assertions -- skill routing is broken

Report the pass rate and any failures to the user.

### 4. Post-Evolution Verification

After evolving a skill, re-run unit tests to verify improvements:

```bash
selftune eval unit-test --skill Research
```

Compare the new `pass_rate` against the previous run. Report whether
the evolution improved trigger accuracy.

### 5. Continue the pipeline

After unit tests exist, the next pipeline step is usually:

```bash
selftune verify --skill-path <path>
```

If `verify` still reports missing runtime proof, the next explicit supporting
steps are usually:

```bash
selftune create replay --skill-path <path> --mode package
selftune create baseline --skill-path <path> --mode package
selftune verify --skill-path <path>
```

That keeps the sequence aligned with the dashboard readiness surface:
evals -> unit tests -> replay/baseline proof -> publish -> watch.

## Common Patterns

**User asks to generate tests for a skill**

> Run `selftune eval unit-test --skill <name> --generate --skill-path <path>`.
> Parse the output and report how many tests were generated.

**User asks to run existing tests**

> Run `selftune eval unit-test --skill <name>`. Parse the JSON output and
> report pass rate and any failures.

**User asks for full agent-based testing**

> Run `selftune eval unit-test --skill <name> --run-agent`. This runs queries
> through the full agent, so inform the user it will take longer.

**After an evolution completes**

> Run unit tests to verify the evolution improved trigger accuracy. Compare
> the new pass rate against the pre-evolution baseline.
