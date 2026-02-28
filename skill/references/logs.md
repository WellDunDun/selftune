# Log Format Reference

The skill eval system writes to three log files. This reference describes
each format in detail for the grader skill to use when parsing sessions.

---

## ~/.claude/session_telemetry_log.jsonl

One JSON record per line. Each record is one completed agent session.

```json
{
  "timestamp": "2026-02-28T10:00:00+00:00",
  "session_id": "abc123",
  "source": "claude_code",
  "cwd": "/home/user/projects/myapp",
  "transcript_path": "/home/user/.claude/projects/.../abc123.jsonl",
  "last_user_query": "Make me a slide deck for the board meeting",
  "tool_calls": {
    "Read": 2,
    "Write": 1,
    "Bash": 3,
    "Edit": 0
  },
  "total_tool_calls": 6,
  "bash_commands": [
    "pip install python-pptx --break-system-packages",
    "python3 /tmp/create_pptx.py"
  ],
  "skills_triggered": ["pptx"],
  "assistant_turns": 5,
  "errors_encountered": 0,
  "transcript_chars": 4200
}
```

**source values:**
- `claude_code` — written by session_stop_hook.py (Stop hook)
- `codex` — written by adapters/codex_wrapper.py
- `codex_rollout` — written by adapters/codex_rollout_ingest.py
- `opencode` — written by adapters/opencode_ingest.py
- `opencode_json` — legacy OpenCode JSON files

---

## ~/.claude/skill_usage_log.jsonl

One record per skill trigger event. Populated by skill_eval_hook.py (PostToolUse hook).

```json
{
  "timestamp": "2026-02-28T10:00:00+00:00",
  "session_id": "abc123",
  "skill_name": "pptx",
  "skill_path": "/mnt/skills/public/pptx/SKILL.md",
  "query": "Make me a slide deck for the board meeting",
  "triggered": true,
  "source": "claude_code"
}
```

---

## ~/.claude/all_queries_log.jsonl

Every user query, whether or not it triggered a skill. Populated by prompt_log_hook.py (UserPromptSubmit hook).

```json
{
  "timestamp": "2026-02-28T10:00:00+00:00",
  "session_id": "abc123",
  "query": "Make me a slide deck for the board meeting",
  "source": "claude_code"
}
```

---

## Claude Code Transcript Format (~/.claude/projects/.../session.jsonl)

One JSON object per line. Two observed variants:

**Variant A (nested, current):**
```json
{"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "..."}]}}
{"type": "assistant", "message": {"role": "assistant", "content": [
  {"type": "text", "text": "I'll read the skill first."},
  {"type": "tool_use", "name": "Read", "input": {"file_path": "/path/to/SKILL.md"}}
]}}
```

**Variant B (flat, older):**
```json
{"role": "user", "content": "..."}
{"role": "assistant", "content": [{"type": "tool_use", "name": "Bash", "input": {"command": "..."}}]}
```

Tool use always appears in assistant content blocks as `{"type": "tool_use", "name": "ToolName", "input": {...}}`.

Skill reads appear as `Read` tool calls where `input.file_path` ends in `SKILL.md`.

---

## Codex Rollout Format ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl)

```json
{"type": "thread.started", "thread_id": "..."}
{"type": "turn.started"}
{"type": "item.completed", "item": {"id": "i0", "item_type": "reasoning", "text": "I should use the setup-demo-app skill"}}
{"type": "item.completed", "item": {"id": "i1", "item_type": "command_execution", "command": "npm install", "exit_code": 0}}
{"type": "item.completed", "item": {"id": "i2", "item_type": "file_change", "changes": [{"path": "..."}]}}
{"type": "item.completed", "item": {"id": "i3", "item_type": "agent_message", "text": "Done!"}}
{"type": "turn.completed", "usage": {"input_tokens": 1200, "output_tokens": 450}}
```

Item types: `reasoning`, `command_execution`, `file_change`, `agent_message`,
`mcp_tool_call`, `web_search`, `todo_list`, `error`

---

## OpenCode Message Format (in SQLite message.content column)

Content is a JSON string containing an array of blocks. Anthropic format:

```json
[
  {"type": "text", "text": "I'll create the presentation."},
  {"type": "tool_use", "name": "Bash", "input": {"command": "pip install python-pptx"}},
  {"type": "tool_use", "name": "Read", "input": {"file_path": "/skills/pptx/SKILL.md"}}
]
```

Tool results appear in subsequent user messages:
```json
[{"type": "tool_result", "tool_use_id": "...", "content": "OK", "is_error": false}]
```
