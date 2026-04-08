# selftune Auto-Activation Workflow

Automatically suggests selftune commands during a session based on
activation rules. Runs as a `UserPromptSubmit` hook, evaluates rules
against session context, and outputs advisory suggestions to stderr.

## How It Works

The `hooks/auto-activate.ts` script runs on every `UserPromptSubmit` event.
It reads session telemetry, query logs, and evolution audit data, then
evaluates a set of activation rules against the current context. When a
rule fires, the suggestion is written to stderr (shown to Claude as a
system message). The hook always exits 0 -- suggestions are advisory and
never block the user.

Flow:

1. Claude Code triggers `UserPromptSubmit` hook
2. Hook receives `{ session_id }` payload on stdin
3. Checks PAI coexistence (see below)
4. Loads default activation rules
5. Evaluates each rule against session context
6. Outputs suggestions to stderr (if any)
7. Exits 0

## PAI Coexistence

If PAI's `skill-activation-prompt` hook is detected in
`~/.claude/settings.json`, selftune skips all suggestions. PAI handles
skill-level activation; selftune handles observability. This prevents
duplicate or conflicting suggestions.

Detection scans all hook entries in settings for any command containing
`skill-activation-prompt`. If found, the hook exits silently.

## Default Rules

| Rule ID                    | Description               | Trigger Condition                                              | Suggestion                 |
| -------------------------- | ------------------------- | -------------------------------------------------------------- | -------------------------- |
| `post-session-diagnostic`  | Suggest diagnostic review | >2 unmatched queries in current session                        | `selftune last`            |
| `grading-threshold-breach` | Suggest evolution         | Session pass rate < 0.6 (60%)                                  | `selftune evolve`          |
| `stale-evolution`          | Suggest evolution         | >7 days since last evolution AND pending false negatives exist | `selftune evolve`          |
| `regression-detected`      | Suggest rollback          | Watch snapshot shows `regression_detected: true`               | `selftune evolve rollback` |

### Rule Details

**post-session-diagnostic**: Compares query count against skill usage count
for the current session. If the difference exceeds 2, unmatched queries
likely indicate gaps in skill coverage.

**grading-threshold-breach**: Reads grading result files from
`~/.selftune/grading/result-*.json`. If the current session's pass rate
is below 0.6, the skill description may need evolution.

**stale-evolution**: Reads the evolution audit log to find the last
evolution timestamp. If older than 7 days, checks
`~/.selftune/false-negatives/pending.json` for pending false negatives.
Both conditions must be true.

**regression-detected**: Reads the latest monitoring snapshot from
`~/.selftune/monitoring/latest-snapshot.json`. If `regression_detected`
is true, suggests rollback with the skill name if available.

## Session State Tracking

Each rule fires at most once per session. After a suggestion is shown,
the rule ID is recorded in session state to prevent repeated nags.

Session state is stored at `~/.selftune/session-state-<session_id>.json`:

```json
{
  "session_id": "abc-123",
  "suggestions_shown": ["post-session-diagnostic", "grading-threshold-breach"],
  "updated_at": "2026-03-02T10:00:00Z"
}
```

State is keyed by `session_id`. If the session ID changes (new session),
state resets automatically.

## Customizing Rules

Rules are defined in `cli/selftune/activation-rules.ts` as the
`DEFAULT_RULES` array. To customize rule behavior, edit that TypeScript
file directly. There is no runtime JSON config — the hook imports
`DEFAULT_RULES` at evaluation time.

Each rule conforms to the `ActivationRule` interface:

```typescript
interface ActivationRule {
  id: string;
  description: string;
  evaluate(ctx: ActivationContext): string | null;
}
```

The `ActivationContext` provides paths to all log files and the selftune
config directory. Return a suggestion string when the rule fires, or
`null` to skip.

## Disabling Auto-Activation

Remove the `auto-activate.ts` hook entry from `~/.claude/settings.json`.
The hook is registered under `UserPromptSubmit`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": "node /path/to/bin/run-hook.cjs /path/to/cli/selftune/hooks/auto-activate.ts"
      }
    ]
  }
}
```

Delete or comment out the entry to disable all auto-activation suggestions.

## Common Patterns

**User wants to disable auto-suggestions**

> Remove the auto-activate hook entry from `~/.claude/settings.json`
> (see Disabling section above). Each rule fires at most once per session.

**User asks why selftune suggestions appear**

> Explain that the auto-activate hook detected an actionable condition.
> Parse the suggestion text to identify which rule fired and report the
> recommended action.

**Suggestions are not appearing when expected**

> Run `selftune doctor` to verify the hook is installed. Check that
> `UserPromptSubmit` includes the auto-activate hook in settings.

**PAI coexistence conflict**

> Verify PAI's `skill-activation-prompt` hook is in `~/.claude/settings.json`.
> If present, selftune skips all suggestions automatically. If the user
> sees duplicates, one of the two hooks is misconfigured.

**User wants custom activation rules**

> Direct the user to `cli/selftune/activation-rules.ts`. New rules must
> conform to the `ActivationRule` interface: pure filesystem readers with
> no network calls or heavy imports.
