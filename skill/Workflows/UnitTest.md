# selftune Unit Test Workflow

Run or generate unit tests for individual skills. Tests verify trigger
accuracy, output content, and tool usage with deterministic assertions.

## Default Command

```bash
selftune eval unit-test --skill <name> --tests <path> [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--skill <name>` | Skill name | Required |
| `--tests <path>` | Path to unit test JSON file | `~/.selftune/unit-tests/<skill>.json` |
| `--run-agent` | Run agent-based assertions (not just trigger checks) | Off |
| `--generate` | Generate tests from skill content instead of running | Off |
| `--skill-path <path>` | Path to SKILL.md (required for `--generate`) | None |
| `--eval-set <path>` | Eval set for failure context (used with `--generate`) | None |
| `--model <flag>` | Model flag for LLM calls | Agent default |

## Test Format

Tests are stored as JSON arrays in `~/.selftune/unit-tests/<skill>.json`:

```json
[
  {
    "test_id": "research-trigger-1",
    "skill_name": "Research",
    "description": "Should trigger on explicit research request",
    "query": "Research the latest trends in AI safety",
    "expected_trigger": true,
    "assertions": [
      {
        "type": "trigger_check",
        "value": "true",
        "description": "Skill should trigger for this query"
      }
    ],
    "tags": ["explicit", "core"],
    "source": "manual"
  }
]
```

## Assertion Types

| Type | What it checks | Requires agent? |
|------|---------------|-----------------|
| `trigger_check` | Query triggers the skill description | No (LLM only) |
| `output_contains` | Agent output contains expected text | Yes |
| `output_matches_regex` | Agent output matches regex pattern | Yes |
| `tool_called` | Agent used a specific tool | Yes |

Trigger check assertions are cheap (single LLM call). Agent-based assertions
require `--run-agent` and run the query through the full agent.

## Output Format

```json
{
  "skill_name": "Research",
  "total": 10,
  "passed": 8,
  "failed": 2,
  "pass_rate": 0.80,
  "results": [
    {
      "test_id": "research-trigger-1",
      "overall_passed": true,
      "trigger_passed": true,
      "assertion_results": [
        { "type": "trigger_check", "value": "true", "passed": true, "evidence": "LLM responded YES" }
      ],
      "duration_ms": 450
    }
  ],
  "ran_at": "2026-03-04T12:00:00.000Z"
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

Tests are saved to `~/.selftune/unit-tests/Research.json`.

### 2. Run Tests

Run the test suite:

```bash
selftune eval unit-test --skill Research --tests ~/.selftune/unit-tests/Research.json
```

By default, only `trigger_check` assertions run (fast, no agent needed).
Add `--run-agent` for full agent-based assertions.

### 3. Parse Results

Parse the JSON output. Check `pass_rate` and investigate failures:
- Failed trigger checks -- description needs improvement (route to Evolve)
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
