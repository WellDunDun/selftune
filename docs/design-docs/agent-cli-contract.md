<!-- Verified: 2026-03-28 -->

# Agent CLI Contract

selftune's CLI is consumed by AI agents, not humans directly. This document codifies the mechanical contract between the CLI and its agent consumers — output formats, exit codes, error schemas, and behavioral guarantees that agents depend on for reliable automation.

**Relationship to other docs:**

- `golden-principles.md` — Taste and style rules (naming, code style, testing)
- `AGENTS.md` — Repository overview and project structure
- `ARCHITECTURE.md` — Module layering and data flow
- This doc — The agent-facing API contract

## Design Philosophy

> "Agent DX optimizes for predictability and defense-in-depth. Human DX optimizes for discoverability and forgiveness. These are different enough that retrofitting a human-first CLI for agents is a losing bet."
> — Justin Poehnelt, Google Workspace CLI

selftune was designed agent-first from inception. The skill definition (`skill/SKILL.md`) is the product surface. The workflow docs (`skill/Workflows/`) are the agent's instruction manual. The CLI is the agent's API. Users interact through their coding agent, never the CLI directly.

**Core tension:** Every CLI design choice must optimize for reducing agent turns (round trips), not human readability. An agent pays per token and per tool call. A human scrolls for free.

## Output Contract

### Structured Output

All commands that produce data SHOULD support `--json` for machine-readable output. When `--json` is active, all output goes to stdout as valid JSON. Human-readable text goes to stderr.

**Current coverage** (as of 0.2.14):

| Command        | `--json` | Notes                |
| -------------- | -------- | -------------------- |
| `sync`         | Yes      | Auto-detects non-TTY |
| `doctor`       | Yes      | Always JSON          |
| `alpha upload` | Yes      | JSON summary         |
| `export`       | Yes      | JSON paths + counts  |
| `status`       | Planned  | Text-only today      |
| `last`         | Planned  | Text-only today      |
| `grade`        | Planned  | Text-only today      |
| `orchestrate`  | Planned  | Text-only today      |

**Rule:** New commands MUST support `--json` from day one. Existing commands SHOULD be migrated incrementally.

### Output Stability

CLI output is an API contract. Breaking changes to structured output fields require a major version bump.

- **Safe changes:** New optional fields, new commands, new flag aliases
- **Breaking changes:** Removing fields, renaming fields, changing field types, reordering positional output

## Exit Code Semantics

Agents branch on exit codes to decide retry vs. abort vs. alternate path. Binary 0/1 is insufficient.

| Code | Meaning                | Agent Action                                                            |
| ---- | ---------------------- | ----------------------------------------------------------------------- |
| `0`  | Success                | Proceed                                                                 |
| `1`  | General error          | Report to user, do not retry                                            |
| `2`  | Guard/validation block | Expected block (e.g., evolution-guard); do not retry without user input |
| `3`  | No-op / already done   | Safe to proceed; command was idempotent and state is correct            |
| `4`  | Config missing         | Run `selftune init` first, then retry                                   |

**Current state:** Most commands use 0/1 only. `evolution-guard.ts` uses exit code 2. Migration to richer codes is incremental — new commands SHOULD use the full table; existing commands MAY be migrated.

**Rule:** Exit codes are part of the API contract. Once assigned, a code's meaning cannot change without a major version bump.

## Error Output Contract

When `--json` is active, errors MUST be structured JSON on stderr:

```json
{
  "error": {
    "code": "CONFIG_MISSING",
    "message": "No selftune config found at ~/.selftune/config.json",
    "suggestion": "Run: selftune init",
    "retryable": false
  }
}
```

When `--json` is not active, errors MUST still be actionable text that suggests the next CLI command (per golden principle: "Error messages must be actionable").

**Fields:**

- `code` — Machine-readable error identifier (SCREAMING_SNAKE_CASE)
- `message` — Human-readable description
- `suggestion` — The next CLI command to run (agent-actionable)
- `retryable` — Whether the agent should retry the same command

**Current state:** Most commands use text-only errors via `console.error()`. Alpha commands (`init`, `upload`, `relink`) already output structured JSON errors. Migration is incremental.

## CLIError Pattern

All CLI error paths use the `CLIError` class (`cli/selftune/utils/cli-error.ts`) instead of ad-hoc `console.error()` + `process.exit()`. This enforces structured errors at the type level.

```typescript
import { CLIError, handleCLIError } from "./utils/cli-error.js";

// Throwing a typed error (replaces console.error + process.exit)
throw new CLIError(
  "--max-skills must be a positive integer", // message
  "INVALID_FLAG", // machine-readable code
  "selftune orchestrate --max-skills 5", // agent-actionable suggestion
  1, // exit code (default: 1)
  false, // retryable (default: false)
);

// Top-level catch handler (replaces manual catch blocks)
cliMain().catch(handleCLIError);
```

**Error codes** (SCREAMING_SNAKE_CASE):

- `INVALID_FLAG` — Flag value failed validation
- `MISSING_FLAG` — Required flag not provided
- `CONFIG_MISSING` — selftune config not found
- `FILE_NOT_FOUND` — Required file does not exist
- `AGENT_NOT_FOUND` — No supported agent CLI in PATH
- `UNKNOWN_COMMAND` — Unrecognized command or subcommand
- `GUARD_BLOCKED` — Evolution guard prevented the operation
- `OPERATION_FAILED` — Command execution failed after validation passed
- `MISSING_DATA` — Required data (e.g., skill, session) not found in database

**Migration status:** `orchestrate.ts` is the reference implementation. Other CLI entry points adopt incrementally — new code uses `CLIError`; existing code is migrated as files are touched.

## No Interactive Prompts

**Rule:** The CLI MUST NEVER block waiting for interactive input. All parameters are provided via flags, environment variables, or structured stdin.

**Precedence model:** Explicit flags > environment variables > config file defaults.

If a command requires user consent (e.g., alpha enrollment), it MUST:

1. Output the consent notice to stderr
2. Exit with a specific code indicating "consent required"
3. Accept a `--accept` or `--yes` flag to skip the consent gate

**Current state:** `init` prints consent notices but does not block. `alpha relink` requires browser interaction for device code flow. Hook payloads read structured JSON from stdin (correct pattern).

## Idempotency Guarantees

Agents retry. Every mutating command MUST be safe to re-run.

| Command       | Idempotent  | Mechanism                                         |
| ------------- | ----------- | ------------------------------------------------- |
| `init`        | Yes         | Returns existing config; `--force` to overwrite   |
| `sync`        | Yes         | Marker files for deduplication                    |
| `orchestrate` | Yes         | Lock file prevents concurrent runs                |
| `evolve`      | Yes         | Validates before deploy; skips if no improvement  |
| `grade`       | Yes         | `INSERT OR IGNORE` on grading results             |
| `schedule`    | Conditional | Marker-based cron entries; safe if markers intact |

**Database-level:** All SQLite writes use `INSERT OR IGNORE` or `ON CONFLICT` clauses. Re-running a command with the same input produces the same database state.

**Rule:** New mutating commands MUST document their idempotency guarantee in their workflow doc.

## Dry-Run Contract

All mutating commands SHOULD support `--dry-run`. When active:

1. No side effects (no file writes, no database mutations, no API calls)
2. Output describes what WOULD happen in the same format as the real output
3. Include a `dry_run: true` field in JSON output

**Current coverage:**

| Command        | `--dry-run` | Output Format                  |
| -------------- | ----------- | ------------------------------ |
| `sync`         | Yes         | JSON with `dry_run: true`      |
| `evolve`       | Yes         | Validates without deploying    |
| `orchestrate`  | Yes         | Previews full loop             |
| `schedule`     | Yes         | Prints plan without installing |
| `alpha upload` | Yes         | Logs without sending           |
| `uninstall`    | Yes         | Previews removal               |
| `init`         | No          | Planned                        |
| `grade`        | No          | Planned                        |

## Operation Receipts

Mutating commands SHOULD return a receipt confirming what changed:

```json
{
  "success": true,
  "operation": "deploy",
  "target": { "skill_name": "Research", "proposal_id": "evo-abc123" },
  "timestamp": "2026-03-28T12:00:00Z",
  "undo_command": "selftune rollback --skill Research --proposal evo-abc123"
}
```

The `undo_command` field gives agents a recovery path without requiring additional turns to discover rollback syntax.

**Current state:** `evolve` and `rollback` partially implement this pattern. Not systematic across all mutating commands.

## Capabilities Endpoint

A capabilities endpoint reduces agent discovery from multiple `--help` round trips to a single call:

```bash
selftune --capabilities
```

```json
{
  "version": "0.2.14",
  "commands": {
    "sync": { "dry_run": true, "json": true, "mutating": false },
    "evolve": { "dry_run": true, "json": false, "mutating": true, "destructive": false },
    "orchestrate": { "dry_run": true, "json": false, "mutating": true },
    "grade": { "dry_run": false, "json": false, "mutating": true },
    "rollback": { "dry_run": false, "json": false, "mutating": true, "destructive": true },
    "schedule": { "dry_run": true, "json": false, "mutating": true }
  }
}
```

**Current state:** Not implemented. Agents discover capabilities through `skill/SKILL.md` routing table and workflow docs, which is effective but costs more turns than a single CLI call.

**Priority:** Low — the SKILL.md routing table serves this purpose well for selftune's primary use case (agent reads SKILL.md at conversation start).

## Input Hardening

Agents hallucinate. The CLI MUST validate all inputs defensively:

- **Skill names** — Reject control characters, path traversals, embedded query params
- **File paths** — Canonicalize and validate before use
- **Session IDs** — Validate format before database queries
- **Flag values** — Strict validation (e.g., `/^\d+$/` for integer flags, not permissive `parseInt`)

**Current state:** Integer flags use strict regex validation. Skill names are used as-is from `status` output. File paths are validated at system boundaries.

## Migration Plan

This contract describes both current state and target state. Migration is incremental:

**Phase 1 (current):** Document the contract. New commands follow it from day one.

**Phase 2 (next):** Add `--json` to `status`, `last`, and `grade` — the most frequently agent-consumed read commands.

**Phase 3 (future):** Richer exit codes, structured error schema, operation receipts, capabilities endpoint.

Each phase is independently valuable. No phase blocks on another.

## References

- [You Need to Rewrite Your CLI for AI Agents](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/) — Justin Poehnelt (Google)
- [Keep the Terminal Relevant: Patterns for AI Agent Driven CLIs](https://www.infoq.com/articles/ai-agent-cli/) — InfoQ
- [Agent-first CLIs are about reducing turns, not JSON](https://keyboardsdown.com/posts/01-agent-first-clis/) — keyboardsdown
- [Writing CLI Tools That AI Agents Actually Want to Use](https://dev.to/uenyioha/writing-cli-tools-that-ai-agents-actually-want-to-use-39no) — DEV Community
- [PatternFly CLI Handbook: Writing Guidelines](https://www.patternfly.org/developer-resources/cli-handbook/writing-guidelines) — PatternFly
