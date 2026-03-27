# Log Format Reference

selftune uses SQLite as its sole write target and operational store. This
reference describes the legacy JSONL log formats that remain on disk for
disaster recovery and export, plus the canonical event schema.

> **Important (Phase 3 complete):** JSONL writes have been removed from all hooks,
> ingestors, and normalization pipelines. New data is written exclusively to SQLite
> (`~/.selftune/selftune.db`). Existing JSONL files are retained on disk for disaster
> recovery via the materializer (`localdb/materialize.ts`) and on-demand export
> (`selftune export`). No runtime code path writes to JSONL files.

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

> **Deprecated.** The `skill_usage` and `skill_invocations` data paths have been
> consolidated into a single `skill_invocations` table in SQLite. This JSONL file
> is still written by hooks for backward compatibility, but the dashboard and
> queries now read exclusively from `skill_invocations`. New consumers should use
> the SQLite table via `localdb/queries.ts`.

One record per skill trigger event. Populated by skill-eval.ts (PostToolUse hook).

```json
{
  "timestamp": "2026-02-28T10:00:00+00:00",
  "session_id": "abc123",
  "skill_name": "pptx",
  "skill_path": "/mnt/skills/public/pptx/SKILL.md",
  "skill_scope": "project",
  "skill_project_root": "/home/user/projects/myapp",
  "skill_registry_dir": "/home/user/projects/myapp/.agents/skills",
  "skill_path_resolution_source": "raw_log",
  "query": "Make me a slide deck for the board meeting",
  "triggered": true,
  "source": "claude_code"
}
```

Optional provenance fields:

- `skill_scope`: `project | global | admin | system | unknown`
- `skill_project_root`: resolved repo/worktree root when the skill came from a project-local registry
- `skill_registry_dir`: the registry directory where the resolved `SKILL.md` came from
- `skill_path_resolution_source`: `raw_log | installed_scope | launcher_base_dir | fallback`

The repaired overlay at `~/.claude/skill_usage_repaired.jsonl` uses the same
record shape, but is rebuilt from source-truth transcripts/rollouts rather than
hooks alone.

Notes:

- `launcher_base_dir` means selftune recovered Claude's `Base directory for this skill:` launcher metadata. If that recovered `SKILL.md` path points into a stable registry like `~/.agents/skills`, `~/.claude/skills`, `/etc/codex/skills`, or a real project checkout, selftune now reclassifies the invocation into the matching `skill_scope`. Ephemeral temp launcher directories still remain `unknown`.
- `fallback` means selftune confirmed a skill invocation but could not yet resolve a concrete `SKILL.md` path.

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

## ~/.claude/canonical_telemetry_log.jsonl

Canonical append-only event stream. This is the normalization boundary for local
and cloud ingestion. Raw legacy logs remain unchanged; canonical events are
written separately. Parse it as JSONL: UTF-8 text, one canonical JSON object
per line, newline-delimited, with parsers reading line-by-line and allowing a
final trailing newline.

Observed record kinds:

- `session`
- `prompt`
- `skill_invocation`
- `execution_fact`
- `normalization_run` (reserved for future normalization job summaries)

Example prompt record:

```json
{
  "record_kind": "prompt",
  "schema_version": "2.0",
  "normalizer_version": "1.0.0",
  "normalized_at": "2026-03-10T10:00:00.000Z",
  "platform": "claude_code",
  "capture_mode": "hook",
  "source_session_kind": "interactive",
  "session_id": "abc123",
  "raw_source_ref": {
    "event_type": "UserPromptSubmit"
  },
  "prompt_id": "abc123:p0",
  "occurred_at": "2026-03-10T10:00:00.000Z",
  "prompt_text": "Make me a slide deck for the board meeting",
  "prompt_hash": "4d6c5c0b1a2f7a40",
  "prompt_kind": "user",
  "is_actionable": true,
  "prompt_index": 0
}
```

Example skill invocation record:

```json
{
  "record_kind": "skill_invocation",
  "schema_version": "2.0",
  "normalizer_version": "1.0.0",
  "normalized_at": "2026-03-10T10:00:05.000Z",
  "platform": "claude_code",
  "capture_mode": "hook",
  "source_session_kind": "interactive",
  "session_id": "abc123",
  "raw_source_ref": {
    "path": "/home/user/.claude/projects/.../abc123.jsonl",
    "event_type": "PostToolUse"
  },
  "skill_invocation_id": "abc123:s:pptx:0",
  "occurred_at": "2026-03-10T10:00:05.000Z",
  "matched_prompt_id": "abc123:p0",
  "skill_name": "pptx",
  "skill_path": "/mnt/skills/public/pptx/SKILL.md",
  "invocation_mode": "explicit",
  "triggered": true,
  "confidence": 1
}
```

Run `selftune export-canonical --out ~/.claude/canonical_telemetry_log.jsonl`
to write a canonical JSONL telemetry export ready for downstream cloud
ingestion.

---

## ~/.selftune/canonical-session-state-<session>.json

Per-session helper state used only to preserve deterministic canonical prompt IDs
for live Claude hooks. `<session>` is the `session_id` with every character
outside `[A-Za-z0-9_-]` replaced by `_`, so `user:abc/123` becomes
`canonical-session-state-user_abc_123.json`.

```json
{
  "session_id": "abc123",
  "next_prompt_index": 2,
  "last_prompt_id": "abc123:p1",
  "last_actionable_prompt_id": "abc123:p1",
  "updated_at": "2026-03-10T10:00:05.000Z"
}
```

This is operational state, not an analytics source of truth.

---

## ~/.claude/improvement_signals.jsonl

One record per detected improvement signal. Written by `prompt-log.ts` when a
user correction or explicit skill request is detected. Read by the orchestrator
for signal-aware candidate selection, and by `session-stop.ts` to decide whether
to spawn a reactive orchestrate run.

```json
{
  "timestamp": "2026-03-15T14:00:00.000Z",
  "session_id": "abc123",
  "query": "why didn't you use the commit skill?",
  "signal_type": "correction",
  "mentioned_skill": "commit",
  "consumed": false
}
```

Signal records are append-only. When an orchestrate run processes a signal,
the original record remains unchanged and the orchestrator rewrites the file
with `consumed: true` set on processed entries. This is the one exception
to strict append-only semantics in the log system — the rewrite is atomic
and race-protected by the orchestrate lockfile.

Consumed signal example:

```json
{
  "timestamp": "2026-03-15T14:00:00.000Z",
  "session_id": "abc123",
  "query": "why didn't you use the commit skill?",
  "signal_type": "correction",
  "mentioned_skill": "commit",
  "consumed": true,
  "consumed_at": "2026-03-15T14:05:00.000Z",
  "consumed_by_run": "run_1710511500000_a1b2c3"
}
```

**signal_type values:**

- `correction` — User pointing out a missed skill ("why didn't you use X?", "you should have used X", "next time use X")
- `explicit_request` — User asking to use a skill ("please use the X skill", "use the commit skill")
- `manual_invocation` — Direct `/skill` invocation detected

**Detection:** Pure regex in `prompt-log.ts`, no LLM calls. Skill names are matched against installed skills in `~/.claude/skills/`.

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
    "pass_rate": 0.7
  }
}
```

**action values:**

- `created` — New evolution proposal generated. `details` starts with `original_description:` prefix preserving the pre-evolution SKILL.md content.
- `validated` — Proposal tested against eval set. `eval_snapshot` contains before/after pass rates.
- `deployed` — Updated SKILL.md written to disk. `eval_snapshot` contains final pass rates.
- `rolled_back` — SKILL.md restored to pre-evolution state (from `.bak` file or audit trail).

**Required fields:** `timestamp`, `proposal_id`, `action`

**Optional fields:** `details`, `eval_snapshot`, `iterations_used`

- `iterations_used` (integer, nullable) — How many iteration loops the evolution run used before reaching a result. Present on `deployed` audit entries; null for legacy records or actions that don't track iterations.

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

## Codex Rollout Format ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-\*.jsonl)

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
  { "type": "text", "text": "I'll create the presentation." },
  { "type": "tool_use", "name": "Bash", "input": { "command": "pip install python-pptx" } },
  { "type": "tool_use", "name": "Read", "input": { "file_path": "/skills/pptx/SKILL.md" } }
]
```

Tool results appear in subsequent user messages:

```json
[{ "type": "tool_result", "tool_use_id": "...", "content": "OK", "is_error": false }]
```
