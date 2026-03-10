# Telemetry Source-to-Canonical Field Map

<!-- Verified: 2026-03-10 -->

**Status:** Active
**Purpose:** Define the canonical telemetry contract that all platform adapters must emit before any downstream projection or analytics.
**Audience:** Adapter implementers, reviewers, and anyone building the shared local/cloud telemetry pipeline.

---

## Contract Rules

1. Preserve raw capture separately. Normalization is additive, not destructive.
2. Every canonical record must include `platform`, `capture_mode`, `source_session_kind`, `session_id`, and `raw_source_ref`.
3. Platform-specific fields may be optional, but they must not be silently dropped when available.
4. `prompt_kind`, `is_actionable`, `invocation_mode`, and `confidence` are normalization outputs, not downstream dashboard heuristics.
5. Stable IDs must be deterministic:
   - `prompt_id`: derived from `session_id` + prompt order or source-native prompt/message ID
   - `skill_invocation_id`: derived from `session_id` + tool call ID + skill identity where possible
   - `event_id`: derived from the source record location when no native event ID exists

---

## Confidence and Invocation Rules

| Canonical field | Rule |
|---|---|
| `invocation_mode = explicit` | Direct skill tool invocation or source-native equivalent |
| `invocation_mode = implicit` | SKILL.md read or equivalent high-signal guidance access without explicit invocation |
| `invocation_mode = inferred` | Text/tool sequence strongly implies skill usage but no direct invocation artifact exists |
| `invocation_mode = repaired` | Reconstructed from historical transcripts after ingestion |
| `confidence = 1.0` | Explicit invocation |
| `confidence = 0.7` | Implicit invocation |
| `confidence = 0.4` | Inferred invocation |
| `confidence = 0.9` | Repaired invocation with transcript evidence |

---

## Session and Source Fields

| Canonical field | Requirement | Claude Code | Codex | OpenCode | OpenClaw | Notes |
|---|---|---|---|---|---|---|
| `platform` | required | constant `claude_code` | constant `codex` | constant `opencode` | constant `openclaw` | Source identity must be first-class, not a free-form `source` string |
| `capture_mode` | required | `hook` for live hooks, `replay` for transcript backfill | `wrapper` for live `codex exec`, `batch_ingest` for rollout files | `batch_ingest` for storage/db/export ingestion | `batch_ingest` for session-file ingestion | Repairs use `repair` in overlay paths |
| `source_session_kind` | required | `interactive`, `replayed`, or `repaired` | `interactive` for wrapper, `replayed` for rollout ingest | `interactive` if exported live, `replayed` for local historical ingest | `interactive` for live sessions, `replayed` for file ingest | `synthetic` is test-only |
| `raw_source_ref` | required | hook event name and/or transcript path + line | rollout path + line or wrapper stream event | DB row/table or JSON file path | session file path + line | Needed for auditability and repair |
| `session_id` | required | hook `session_id` or transcript `sessionId` | docs `SESSION_ID`; observed `session_meta.payload.id` | DB/session JSON `id` | session header `id`; docs also distinguish `sessionKey` | Canonical `session_id` must be stable across projections |
| `external_session_id` | optional | same as `session_id` today | source-native session/thread ID if we mint a different canonical ID | source-native session ID if normalized ID changes | source-native `sessionId` if distinct from `session_key` | Avoid unless we truly need an internal surrogate ID |
| `parent_session_id` | optional | transcript `parentUuid`, subagent lineage | not yet observed | not yet observed | not yet observed | Important for subagents and branch sessions |
| `agent_id` | optional | docs `SubagentStop.agent_id` | observed `session_meta.payload.originator` if it proves to be agent identity | use source-native agent ID if present in exports/server API | docs may expose agent/account context | Do not guess when uncertain |
| `agent_type` | optional | docs `SubagentStop.agent_type` | not yet observed | not yet observed | source-native if present | Important for multi-agent attribution |
| `session_key` | optional | none | none | none | docs `sessionKey` | Keep separate from `session_id` |
| `channel` | optional | none | none | none | docs channel routing metadata | Needed for transport-aware analytics |
| `workspace_path` | optional | hook/transcript `cwd` | observed `session_meta.payload.cwd` or `turn_context.payload.cwd` | observed legacy session `directory` or export metadata | session header `cwd` | Normalize to absolute path when possible |
| `repo_root` | optional | derive from `cwd` when stable | derive from `cwd` | derive from `directory` | derive from `cwd` | Derived field |
| `repo_remote` | optional | derive from repo state if available | observed nested `git` payload when available | derive from repo state if directory exists | derive from repo state if available | Derived field |
| `branch` | optional | transcript `gitBranch` | observed nested `git` payload when available | derive from repo state or export metadata | derive from repo state if available | Do not make branch mandatory |
| `commit_sha` | optional | derive from repo state if available | observed nested `git` payload when available | derive from repo state if available | derive from repo state if available | Derived field |
| `permission_mode` | optional | observed transcript `permissionMode` | none | none | none | Claude-specific but useful |
| `approval_policy` | optional | none | observed `turn_context.payload.approval_policy` | use export/server metadata if present | none | Codex-specific today |
| `sandbox_policy` | optional | none | observed `turn_context.payload.sandbox_policy` | use export/server metadata if present | none | Codex-specific today |
| `provider` | optional | typically `anthropic` | observed `session_meta.payload.model_provider` | from stats/export/session metadata | from runtime metadata if present | Keep provider separate from model |
| `model` | optional | docs `SessionStart.model` | observed `turn_context.payload.model` | from stats/export/session metadata | from runtime metadata if present | Session-level default model |
| `started_at` | optional | hook start timestamp or first transcript event | `session_meta.timestamp` | session/export `time` or first message time | session header `timestamp` | Prefer source-native start time |
| `ended_at` | optional | `SessionEnd` time or last transcript event | last terminal event | last message/export end time | last session file line time | Derived when not explicitly emitted |
| `completion_status` | optional | derived from `SessionEnd.reason` | derived from terminal event outcome | derived from export/session status | derived from session outcome | `completed`, `failed`, `interrupted`, `cancelled`, `unknown` |
| `end_reason` | optional | docs `SessionEnd.reason` | terminal event/error payload | export/session status reason if present | hook/session reason if available | Preserve raw reason text |

---

## Prompt Fields

| Canonical field | Requirement | Claude Code | Codex | OpenCode | OpenClaw | Notes |
|---|---|---|---|---|---|---|
| `prompt_id` | required | derive from `session_id` + prompt order or source-native message UUID | derive from source event order unless native ID exists | DB/export message ID when present, otherwise derive | derive from session file line order | Must be deterministic |
| `prompt_text` | required | hook `user_prompt` or transcript user text blocks | observed `event_msg.payload.message` when `payload.type = user_message` | user message text parts from DB/export/session JSON | `role = user` text blocks | Raw prompt text before sanitization |
| `prompt_hash` | optional | derive from `prompt_text` | derive | derive | derive | Useful for dedupe and privacy-safe analytics |
| `prompt_kind` | required | normalization classifier over hook/transcript text | normalization classifier over `event_msg` payloads | normalization classifier over message parts | normalization classifier over user blocks | Do not hardcode per-platform logic downstream |
| `is_actionable` | required | derived from `prompt_kind` + actionable-query filter | derived | derived | derived | Must be written at normalization time |
| `prompt_index` | optional | transcript order | event order within session | message order | file line order | Useful for replay/debugging |
| `parent_prompt_id` | optional | continuation chains when detectable | turn/thread ancestry if exposed | conversation ancestry if exposed | follow-up linkage if exposed | Usually absent; keep optional |
| `source_message_id` | optional | transcript `uuid` where present | native message/item ID if exposed | DB/export message ID | native message ID if introduced later | Preserve source-native IDs separately |

---

## Skill Invocation and Execution Fields

| Canonical field | Requirement | Claude Code | Codex | OpenCode | OpenClaw | Notes |
|---|---|---|---|---|---|---|
| `skill_invocation_id` | required | derive from session + tool call identity + skill | derive from source event/item identity + skill | derive from message/tool call identity + skill | derive from `toolCall.id` + skill | Deterministic synthetic ID is acceptable |
| `matched_prompt_id` | required | latest actionable prompt in session when invocation occurs | user_message event matched to invocation window | user message matched to tool/message window | latest actionable user message before invocation | Required so skill analytics stop using all-query denominators |
| `skill_name` | required when skill known | `Skill` tool arg or `SKILL.md` parent dir | source-native explicit skill signal when available; otherwise only after validated mapping | `SKILL.md` parent dir or explicit tool arg | `SKILL.md` parent dir or explicit tool arg | Avoid text-mention-only names unless `invocation_mode = inferred` |
| `skill_path` | optional | `Read.file_path` for `SKILL.md` | source path when available | source path when available | `Read.file_path` for `SKILL.md` | May be synthetic for wrappers |
| `skill_version_hash` | optional | derive from file contents when available | derive if path/file is available | derive if source export includes file access | derive if file path is available | Not required for first refactor |
| `invocation_mode` | required | `explicit` for `Skill` tool use, `implicit` for `SKILL.md` read, `repaired` for repair overlay | source-specific mapping after rollout parser rewrite | source-specific mapping after export/server integration | `implicit` from `SKILL.md` read, `inferred` only with high-signal evidence | See confidence rules above |
| `triggered` | required | true only for actual/validated invocation, false for browsing or negative checks | true only for validated skill use | true only for validated skill use | true only for validated skill use | Do not overload with “mentioned” |
| `confidence` | required | derived from invocation mode and evidence strength | derived | derived | derived | Numeric, 0.0-1.0 |
| `tool_name` | optional | hook/transcript tool name | response/function call item name | tool_use/function name | `toolCall.name` / `toolUse.name` | Useful for evidence pages |
| `tool_call_id` | optional | source-native tool call ID when available | function call ID or item ID | tool call ID if present | `toolCall.id` | Important for stable invocation IDs |
| `tool_calls_json` | optional | session-level parse output | session-level parse output | session-level parse output | session-level parse output | Use for execution fact records, not prompt records |
| `total_tool_calls` | optional | transcript metrics | rollout/wrapper metrics | DB/export metrics | session-file metrics | Execution fact record |
| `assistant_turns` | optional | transcript metrics | turn count | message/turn count | assistant message count | Execution fact record |
| `errors_encountered` | optional | transcript/hook metrics | terminal/error events | tool result / export errors | `toolResult.isError` | Execution fact record |
| `input_tokens` | optional | hook/session metrics when available | usage/token_count payloads | stats/export/session metrics | runtime metadata if present | Execution fact record |
| `output_tokens` | optional | hook/session metrics when available | usage/token_count payloads | stats/export/session metrics | runtime metadata if present | Execution fact record |
| `duration_ms` | optional | derived from start/end timestamps | derived from session timeline | derived from message/export timestamps | derived from session timeline | Derived field |

---

## Adapter Brief

### Claude Code

- Add canonical support for `SessionStart`, `SubagentStop`, and `SessionEnd` fields rather than relying only on prompt/stop/post-tool hooks.
- Treat hook payloads and transcript lines as separate raw source types.
- Normalize `sessionId`/`parentUuid`/`permissionMode` into canonical session fields.

### Codex

- Rewrite the parser to handle the observed local rollout schema first.
- Preserve `session_meta`, `turn_context`, `event_msg`, and `response_item` payload types in raw capture.
- Map `approval_policy`, `sandbox_policy`, `model`, `provider`, `git`, and `user_message` into canonical fields before any analytics run.

### OpenCode

- Split ingestion into `metadata_snapshot`, `export`, and `db_ingest` source variants under the same `batch_ingest` capture mode.
- Stop assuming that local `storage/session/*.json` files always contain message bodies.
- Prefer source-native export/server APIs for prompts, messages, and model usage when local storage is metadata-only.

### OpenClaw

- Keep parsing session files, but reserve transport metadata fields from the official docs even when fixtures do not contain them.
- When a live OpenClaw install is available, add fixture captures that include `sessionKey`, channel context, and command-log metadata.

---

## Immediate Follow-Through

1. Add the canonical type layer in `cli/selftune/types.ts`.
2. Migrate Codex first because it is the largest observed contract mismatch.
3. Update adapters to emit canonical records plus raw-source references.
4. Only then migrate dashboard/status/evals/watch to canonical readers.
