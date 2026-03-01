<!-- Verified: 2026-03-01 -->

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

6. **Bootstrap before operate**
   Every agent interaction starts with config. `selftune init` writes `~/.selftune/config.json` once; all workflows read it. No workflow should hardcode paths or assume agent type.

7. **Real signal over synthetic**
   Evolution proposals use real user queries as ground truth, never synthetic test prompts. Eval sets are generated from actual session data.

8. **Pure functions as shared backbone**
   Core computations (`computeMonitoringSnapshot`, `computeStatus`, `computeLastInsight`) are pure functions with no side effects. This enables reuse across CLI, dashboard, and monitoring surfaces without modification.

## Naming Conventions

- Files: kebab-case (`codex-wrapper.ts`, `grade-session.ts`)
- Functions: camelCase (`detectFalseNegatives`)
- Interfaces: PascalCase (`SessionTelemetryRecord`)
- Constants: SCREAMING_SNAKE_CASE (`MAX_RETRY_COUNT`)
- Log fields: snake_case (`session_id`, `tool_calls`)

## Code Style

- TypeScript on Bun, zero runtime dependencies
- Strict types on all exported functions
- Prefer explicit over implicit
- No magic strings — use constants from `constants.ts`
- Error messages must be actionable (what happened, what to do)
- Functions do one thing
- Prefer early returns over deep nesting
- Template literals over string concatenation

## Testing Rules

- Every public function has at least one test
- Tests are in `tests/` mirroring source structure: `tests/hooks/prompt-log.test.ts`
- Test names describe the expected state, not the action
- No test interdependence — each test is isolated
- JSONL output is validated against schema in tests
- Run with `bun test`

## Documentation Rules

- Every design decision is documented with rationale
- Docs are verified against code on a recurring cadence
- Stale docs are worse than no docs — delete or update
- PRD.md is the source of truth for product decisions

## Evolution Rules

9. **Audit every state change**
   Every evolution proposal records `created`, `validated`, `rejected`, or `deployed` to the audit log. No silent transitions.

10. **Validate before deploy, always**
    A proposal must improve the eval pass rate with <5% regression before deployment. No exceptions, even with high confidence.

11. **Backup before overwrite**
    Every SKILL.md deployment creates a `.bak` backup. Rollback must always have a path — either backup file or audit trail.

12. **Dependency injection for testability**
    Evolution modules accept injectable dependencies (`_deps` parameter) so tests avoid `mock.module` contamination. Real imports are the default; tests inject mocks.

## Activation and Agent Rules

13. **Suggestions are advisory, never blocking**
    Auto-activation hooks suggest commands but never block the user prompt. Fail-open design: if the hook errors, the session continues uninterrupted.

14. **Evolution memory survives resets**
    The 3-file memory system (`~/.selftune/memory/`) persists context, plans, and decisions across sessions. `decisions.md` is append-only so history is never lost.

15. **Guardrails protect active evolutions**
    `evolution-guard.ts` blocks SKILL.md edits on monitored skills during active evolutions. Exit code 2 blocks with a message explaining why; never silent failure.

16. **Agents are pure markdown, cheap to create**
    Specialized Claude Code agents (diagnosis-analyst, pattern-analyst, evolution-reviewer, integration-guide) are markdown files with focused single-purpose instructions. Prefer narrow, single-purpose agents over general-purpose ones.

## Anti-Patterns

- Importing grading/eval modules from hooks (violates dependency direction)
- Importing monitoring modules from evolution (monitoring reads audit, not the reverse)
- Platform-specific logic in shared modules (belongs in ingestors)
- Requiring user configuration for basic telemetry capture
- Using synthetic queries when real session data is available
- Mutating log files after write
- Using `mock.module` for modules shared across test files (causes global contamination; use dependency injection instead)
- Deploying proposals without validation (even in "fast" or "confident" modes)
- Rollback without audit trail entry (silent reverts break observability)
- Hardcoding CLI paths in skill workflows (use `selftune <command>` directly)
- Running commands without checking for config first (init must precede all other commands)
