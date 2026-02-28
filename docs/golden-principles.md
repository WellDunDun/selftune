<!-- Verified: 2026-02-28 -->

# Golden Principles

Opinionated mechanical rules that encode human taste for selftune. These go beyond standard linters and are enforced in CI.

## Structural Rules

1. **Shared log schema is the contract**
   All three platform adapters write to the same JSONL schema. Schema changes require updating all writers and readers.

2. **Validate at boundaries, never YOLO**
   Parse and validate all external data at system boundaries: hook inputs, Codex JSONL streams, OpenCode SQLite rows. Never access unvalidated shapes.

3. **No external API keys required**
   Grading uses the user's existing agent subscription. selftune must never require a separate Anthropic API key or any other credential.

4. **Append-only logs**
   Log files are append-only JSONL. Never modify or truncate existing entries. Corrupted logs are skipped, not repaired.

5. **Zero-config hooks**
   After installation, hooks emit telemetry without configuration. No environment variables, no config files, no user action required.

6. **Real signal over synthetic**
   Evolution proposals use real user queries as ground truth, never synthetic test prompts. Eval sets are generated from actual session data.

## Naming Conventions

- Files: snake_case (`codex_wrapper.py`, `grade_session.py`)
- Functions: snake_case (`detect_false_negatives`)
- Classes: PascalCase (`SessionGrader`)
- Constants: SCREAMING_SNAKE_CASE (`MAX_RETRY_COUNT`)
- Log fields: snake_case (`session_id`, `tool_calls`)

## Code Style

- Python 3.12+, standard library preferred
- Type hints on all public functions
- Prefer explicit over implicit
- No magic strings — use constants or enums
- Error messages must be actionable (what happened, what to do)
- Functions do one thing
- Prefer early returns over deep nesting
- f-strings over `.format()` or `%`

## Testing Rules

- Every public function has at least one test
- Tests are co-located: `test_grade_session.py` next to `grade_session.py`
- Test names describe the expected state, not the action
- No test interdependence — each test is isolated
- JSONL output is validated against schema in tests

## Documentation Rules

- Every design decision is documented with rationale
- Docs are verified against code on a recurring cadence
- Stale docs are worse than no docs — delete or update
- PRD.md is the source of truth for product decisions

## Anti-Patterns

- Importing grading/eval modules from hooks (violates dependency direction)
- Platform-specific logic in shared modules (belongs in ingestors)
- Requiring user configuration for basic telemetry capture
- Using synthetic queries when real session data is available
- Mutating log files after write
