# selftune Unit Test Workflow

Run or generate unit tests for individual skills. Tests verify trigger
accuracy, output content, and tool usage with deterministic assertions.

## Default Command

```bash
selftune unit-test --skill <name> [--tests <path>] [options]
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

For a new skill, generate initial tests from the skill content:

```bash
selftune unit-test --skill Research --generate --skill-path ~/.claude/skills/Research/SKILL.md
```

This uses an LLM to create test cases covering:
- Explicit trigger queries
- Implicit trigger queries
- Contextual trigger queries
- Negative examples (should NOT trigger)

Tests are saved to `~/.selftune/unit-tests/Research.json`.

### 2. Run Tests

```bash
selftune unit-test --skill Research --tests ~/.selftune/unit-tests/Research.json
```

By default, only `trigger_check` assertions run (fast, no agent needed).
Add `--run-agent` for full agent-based assertions.

### 3. Review Results

Check `pass_rate` and investigate failures:
- Failed trigger checks → description needs improvement
- Failed output assertions → skill workflow needs fixes
- Failed tool assertions → skill routing is broken

### 4. Iterate

After evolving a skill, re-run unit tests to verify improvements:
1. Evolve: `selftune evolve --skill Research --skill-path /path/SKILL.md`
2. Test: `selftune unit-test --skill Research`
3. Check pass rate improved

## Common Patterns

**"Generate tests for the pptx skill"**
> `selftune unit-test --skill pptx --generate --skill-path /path/SKILL.md`

**"Run existing tests"**
> `selftune unit-test --skill pptx --tests ~/.selftune/unit-tests/pptx.json`

**"Run full agent tests"**
> `selftune unit-test --skill pptx --tests /path/tests.json --run-agent`

**"Test after evolution"**
> Run `selftune unit-test` after each `selftune evolve` to verify improvements.
