# Log Format Reference

selftune writes to four log files. This reference describes each format
in detail for the skill to use when parsing sessions and audit trails.

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
- `claude_code` — written by session-stop.ts (Stop hook)
- `codex` — written by ingestors/codex-wrapper.ts
- `codex_rollout` — written by ingestors/codex-rollout.ts
- `opencode` — written by ingestors/opencode-ingest.ts
- `opencode_json` — legacy OpenCode JSON files

---

## ~/.claude/skill_usage_log.jsonl

One record per skill trigger event. Populated by skill-eval.ts (PostToolUse hook).

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

Every user query, whether or not it triggered a skill. Populated by prompt-log.ts (UserPromptSubmit hook).

```json
{
  "timestamp": "2026-02-28T10:00:00+00:00",
  "session_id": "abc123",
  "query": "Make me a slide deck for the board meeting",
  "source": "claude_code"
}
```

---

## ~/.claude/evolution_audit_log.jsonl

One record per evolution action. Written by the evolution and rollback modules.

```json
{
  "timestamp": "2026-02-28T12:00:00+00:00",
  "proposal_id": "evolve-pptx-1709125200000",
  "action": "created",
  "details": "original_description: Grade a skill session against expectations...",
  "eval_snapshot": {
    "total": 50,
    "passed": 35,
    "failed": 15,
    "pass_rate": 0.70
  }
}
```

**action values:**
- `created` — New evolution proposal generated. `details` starts with `original_description:` prefix preserving the pre-evolution SKILL.md content.
- `validated` — Proposal tested against eval set. `eval_snapshot` contains before/after pass rates.
- `deployed` — Updated SKILL.md written to disk. `eval_snapshot` contains final pass rates.
- `rolled_back` — SKILL.md restored to pre-evolution state (from `.bak` file or audit trail).

**Required fields:** `timestamp`, `proposal_id`, `action`

**Optional fields:** `details`, `eval_snapshot`

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
