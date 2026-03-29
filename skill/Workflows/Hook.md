# selftune Hook Workflow

Manually invoke individual Claude Code hooks for debugging and testing.
Each hook reads its payload from stdin and behaves exactly as it would when
triggered by the Claude Code host agent.

## When to Use

- Debugging a specific hook's behavior with a known payload
- The user says "hook", "run hook", "invoke hook", "manual hook", or "debug hook"
- Testing hook installation by simulating a hook event
- Verifying hook output before or after configuration changes

## Default Command

```bash
echo '{"payload":"..."}' | selftune hook <name>
```

Where `<name>` is one of the 6 available hooks.

## Available Hooks

| Hook Name              | Claude Code Event      | Purpose                                                                 |
| ---------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `prompt-log`           | UserPromptSubmit       | Logs every user query to SQLite for false-negative eval detection        |
| `session-stop`         | Stop                   | Extracts session-level telemetry from transcript when a session ends     |
| `skill-eval`           | PostToolUse            | Records skill usage when a SKILL.md is read or a Skill tool is invoked  |
| `auto-activate`        | UserPromptSubmit       | Evaluates activation rules and suggests selftune actions via stderr      |
| `skill-change-guard`   | PreToolUse             | Warns (advisory) when an agent is about to write to a SKILL.md file     |
| `evolution-guard`      | PreToolUse             | Blocks writes to monitored SKILL.md files until `selftune watch` runs   |

## Hook Details

### prompt-log

Fires on every user message before Claude processes it. Writes the query to
SQLite so that `hooks-to-evals` can identify prompts that did NOT trigger a
skill — the raw material for false-negative eval entries. Also writes a
canonical prompt record.

### session-stop

Fires when a Claude Code session ends. Reads the session transcript JSONL and
extracts process-level telemetry (tool calls, errors, skills triggered, token
counts). Writes one record per session to SQLite with a JSONL backup. May
trigger a reactive `selftune orchestrate` spawn if conditions are met.

### skill-eval

Fires after Read or Skill tool calls. If the target is a SKILL.md file or a
Skill invocation, finds the triggering user query from the transcript and
writes a usage record. Builds the real-usage eval dataset over time.

### auto-activate

Fires on every user message. Evaluates activation rules against the session
context and outputs suggestions to stderr (shown to Claude as system messages).
Suggestions are advisory only — exit code is always 0. Tracks session state to
avoid repeated suggestions.

### skill-change-guard

Fires before Write/Edit tool calls. If the target is a SKILL.md file, outputs
a suggestion to run `selftune watch --skill <name>` to monitor impact. Advisory
only — exit code is always 0, never blocking. Uses session state to avoid
repeating suggestions for the same skill.

### evolution-guard

Fires before Write/Edit tool calls. If the target is a SKILL.md file that has
a deployed evolution under active monitoring, and no recent `selftune watch`
snapshot exists, this hook BLOCKS the write with exit code 2. This prevents
unmonitored changes to skills that are being tracked.

Exit codes:

- `0` — Allow (not a SKILL.md, not monitored, or watch is recent)
- `2` — Block with message (Claude Code convention for PreToolUse hooks)

Fail-open: any internal error results in exit 0 (never blocks accidentally).

## Output Format

Hook output varies by hook type:

- **prompt-log, session-stop, skill-eval**: Write to SQLite and JSONL logs silently. Exit 0 on success.
- **auto-activate**: Writes suggestions to stderr. Exit 0 always.
- **skill-change-guard**: Writes advisory message to stderr. Exit 0 always.
- **evolution-guard**: Writes block message to stderr on exit 2. Exit 0 when allowing.

## Common Patterns

**Debug a prompt-log hook**

> Pipe a UserPromptSubmit payload to test prompt logging:
>
> ```bash
> echo '{"session_id":"test","query":"improve my skills"}' | selftune hook prompt-log
> ```

**Test skill-eval with a PostToolUse payload**

> ```bash
> echo '{"tool_name":"Read","file_path":"/path/to/SKILL.md","session_id":"test"}' | selftune hook skill-eval
> ```

**Verify evolution-guard blocks correctly**

> ```bash
> echo '{"tool_name":"Write","file_path":"/path/to/monitored/SKILL.md"}' | selftune hook evolution-guard
> echo $?  # Should be 2 if skill is monitored without recent watch
> ```

## Error Handling

If no hook name is provided or the name is unrecognized, the command exits with
a `UNKNOWN_COMMAND` error listing available hooks:

```
Unknown hook: (none). Available: prompt-log, session-stop, skill-eval, auto-activate, skill-change-guard, evolution-guard
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Unknown hook" error | Typo in hook name | Use one of: `prompt-log`, `session-stop`, `skill-eval`, `auto-activate`, `skill-change-guard`, `evolution-guard` |
| Hook exits 0 but no data written | Payload missing required fields | Check the hook's expected payload schema in `cli/selftune/types.ts` |
| evolution-guard always exits 0 | No deployed evolution for the target skill | Run `selftune evolve` first to deploy an evolution, then test the guard |
| auto-activate produces no suggestions | Activation rules not configured or already suggested in session | Check `~/.selftune/` for activation rules and session state files |
