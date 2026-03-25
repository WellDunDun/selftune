# Execution Plan: Telemetry Normalization and Canonical Event Model

<!-- Verified: 2026-03-10 -->

**Status:** Active
**Created:** 2026-03-10
**Goal:** Introduce a canonical multi-agent telemetry model that supports local append-only logs, repaired overlays, and a cloud Neon projection without duplicating platform-specific logic across Claude Code, Codex, OpenClaw, and OpenCode.

## Implementation Status (2026-03-10)

Implemented in this repo:

- raw legacy logs remain separate from the canonical event stream
- canonical events now write to `~/.claude/canonical_telemetry_log.jsonl`
- live Claude hooks now emit canonical `prompt`, `skill_invocation`, and `execution_fact` records with deterministic prompt IDs
- replay and batch ingestors now write canonical records to the dedicated canonical log instead of polluting legacy logs
- the canonical schema has been extracted into the internal package `packages/telemetry-contract/`
- `selftune export-canonical` can export canonical records for downstream cloud ingestion

Still pending:

- move downstream local analytics fully onto canonical readers/projections
- make the cloud repo consume the extracted contract instead of re-declaring canonical types
- expand stronger source-native IDs and richer lifecycle coverage where the platform supports it

---

## Problem Statement

The current telemetry model is operational, but it is too adapter-shaped and too thin for long-term maintainability.

Today:

1. **Source information is present but not normalized.**
   `QueryLogRecord`, `SkillUsageRecord`, and `SessionTelemetryRecord` only carry an optional `source?: string`, while `SelftuneConfig` separately stores `agent_type`.
2. **The same logical session is split across three append-only JSONL logs.**
   Queries, skill usage, and session telemetry must be rejoined downstream with heuristics.
3. **Platform adapters emit different semantics into the same fields.**
   Examples: `claude_code`, `claude_code_replay`, `codex_rollout`, `codex`, `opencode_json`, `openclaw`.
4. **We lack stable event identity and lineage.**
   There is no first-class message ID, turn ID, invocation ID, normalization version, repair provenance, or canonical session origin.
5. **The cloud use case is under-modeled.**
   A Neon-backed offering should consume canonical events, not adapter-specific JSONL assumptions.

If we do not fix this, every new agent adapter and every new observability surface will keep re-solving the same normalization problem.

---

## Verified Current State

### What We Collect Today

From the current codebase:

- `SelftuneConfig.agent_type` captures the local installation's primary agent family.
- `QueryLogRecord.source` is populated by writers such as:
  - `claude_code`
  - `claude_code_replay`
  - `codex`
  - `codex_rollout`
  - `opencode`
  - `opencode_json`
  - `openclaw`
- `SessionTelemetryRecord` includes useful execution data:
  - `tool_calls`
  - `total_tool_calls`
  - `bash_commands`
  - `skills_triggered`
  - `skills_invoked?`
  - `assistant_turns`
  - `errors_encountered`
  - `input_tokens?`
  - `output_tokens?`
  - `rollout_path?`
- `SkillUsageRecord` captures:
  - `skill_name`
  - `skill_path`
  - `query`
  - `triggered`
  - `source?`

### What Is Missing

- No first-class `platform`, `agent_family`, `capture_mode`, or `ingest_mode`
- No stable `event_id`, `message_id`, `prompt_id`, or `skill_invocation_id`
- No normalized `prompt_kind` or `is_actionable` flag at write time across all adapters
- No per-record `schema_version`
- No repair provenance except the new `source: "claude_code_repair"` overlay rows
- No canonical way to represent explicit vs inferred skill invocation across all platforms
- No shared local+cloud projection layer

---

## Answering the Product Questions

### Why is this not easy to maintain right now?

Because the repository treats adapter output as if it were already canonical. It is not.

The current shape is:

`adapter output -> raw JSONL -> downstream heuristics`

It needs to become:

`adapter output -> canonical normalization -> projections (local UI, local CLI, cloud DB)`

Right now, maintenance cost shows up as:

- platform-specific `source` strings leaking into analytics
- repeated filter logic in `status`, `dashboard`, `evals`, `watch`, and repair paths
- reconstruction work happening after ingestion instead of during normalization
- local JSONL assumptions bleeding into cloud concerns

### Are we collecting data on the source agent as well?

Partially, but not well enough.

We currently collect:

- local install `agent_type` in config
- per-record `source` strings in logs
- some adapter-specific metadata like `rollout_path`

We do **not** currently collect source-agent identity as a first-class normalized dimension on every event.

We should explicitly model:

- `platform`: `claude_code | codex | opencode | openclaw`
- `capture_mode`: `hook | replay | wrapper | batch_ingest | repair`
- `agent_cli`: exact CLI family used to generate the event
- `adapter_version`: normalization/writer version
- `source_session_kind`: `interactive | replayed | synthetic | repaired`

### What other telemetry do we need?

At minimum:

1. **Canonical source metadata**
   - `platform`
   - `capture_mode`
   - `adapter_version`
   - `schema_version`

2. **Session identity**
   - `session_id`
   - `external_session_id` where different
   - `thread_id` / `conversation_id` where available
   - `workspace_path`
   - repo remote / repo root / branch / commit when available

3. **Prompt identity**
   - `prompt_id`
   - `prompt_text`
   - `prompt_hash`
   - `prompt_kind` (`user`, `meta`, `continuation`, `task_notification`, `teammate_message`, etc.)
   - `is_actionable`

4. **Skill invocation identity**
   - `skill_invocation_id`
   - `skill_name`
   - `skill_path`
   - `skill_version_hash` if available
   - `invocation_mode` (`explicit`, `implicit`, `inferred`, `repaired`)
   - `confidence`
   - `matched_prompt_id`

5. **Execution telemetry**
   - tool counts
   - tool sequence summary
   - error count
   - error classes where available
   - assistant turn count
   - completion / interruption status
   - duration

6. **Model telemetry**
   - provider
   - model name
   - input tokens
   - output tokens
   - cost estimate when available

7. **Normalization provenance**
   - `normalized_at`
   - `normalizer_version`
   - `raw_source_ref`
   - `repair_applied`

### Platform Docs Already Worth Encoding

Official docs verify several source-native fields we should design around up front:

- **Claude Code** exposes `session_id`, `transcript_path`, `model` on `SessionStart`, `prompt` on `UserPromptSubmit`, `agent_id` / `agent_type` / `agent_transcript_path` on `SubagentStop`, `reason` on `SessionEnd`, plus worktree and pre-compaction events.
- **Codex** documents `codex exec --json` JSONL events including `thread.started`, `turn.*`, `item.*`, `usage`, resumable `SESSION_ID`s, explicit sandbox mode, and per-run model override.
- **OpenCode** documents first-class `Session`, `Message`, and `Part` types in the SDK, session list/export commands, stats/model breakdowns, and programmatic prompt/command APIs against a running server.
- **OpenClaw** documents transport-to-session-key mapping, hook/event automation, command logging, session cleanup, and pruning semantics without rewriting JSONL history.

That means the normalization layer should be grounded in verified platform contracts, not inferred solely from our current ingestors.

### Track 0 Verification Snapshot (2026-03-10)

The implementation contract derived from this snapshot lives in
[`telemetry-field-map.md`](../reference/telemetry-field-map.md).

**Official source references**

- Claude Code hooks: <https://docs.anthropic.com/en/docs/claude-code/hooks>
- Codex CLI: <https://developers.openai.com/codex/cli>
- Codex non-interactive JSONL: <https://developers.openai.com/codex/noninteractive>
- OpenCode CLI: <https://opencode.ai/docs/cli/>
- OpenCode SDK: <https://opencode.ai/docs/sdk/>
- OpenClaw hooks: <https://docs.openclaw.ai/automation/hooks>
- OpenClaw agent loop: <https://docs.openclaw.ai/concepts/agent-loop>
- OpenClaw channels/messages: <https://docs.openclaw.ai/channels/channel-routing>, <https://docs.openclaw.ai/concepts/messages>

**Observed capture availability on this machine**

- Claude Code: verified against real local transcript JSONL plus repo hook fixtures
- Codex: verified against real local rollout JSONL plus repo unit tests
- OpenCode: verified against real local legacy session metadata JSON plus repo unit tests
- OpenClaw: verified against repo fixture sessions only; no live `~/.openclaw/agents` tree on this machine

#### Claude Code

- **Docs say:** hook payloads expose lifecycle fields we are not preserving today: `session_id`, `prompt`, `model`, `reason`, `agent_id`, `agent_type`, `agent_transcript_path`, and worktree metadata.
- **Observed locally:** transcript lines use camelCase and nested message records such as `sessionId`, `parentUuid`, `permissionMode`, `gitBranch`, `isSidechain`, `uuid`, and nested `message` objects. Real transcript lines are not the same thing as hook payloads.
- **Current code assumes:** `PromptSubmitPayload`, `PostToolUsePayload`, and `StopPayload` only need `session_id`, `transcript_path`, `cwd`, and the last actionable user message.
- **Implication:** the canonical model needs distinct support for hook events vs transcript events, plus explicit subagent lineage, permission mode, worktree state, and stop reason. We should also normalize camelCase transcript fields into canonical IDs instead of treating transcripts as if they already matched hook payload contracts.

#### Codex

- **Docs say:** `codex exec --json` emits machine-readable session/turn/item events and exposes session IDs, usage, sandbox settings, approval policy, and model selection.
- **Observed locally:** rollout files on this machine are not using the event names our parser expects. The live files start with `session_meta`, `response_item`, `event_msg`, and `turn_context` records. Nested payloads expose fields like `id`, `cwd`, `git`, `model_provider`, `originator`, `source`, `approval_policy`, `sandbox_policy`, `model`, `user_message`, `token_count`, `agent_reasoning`, and `function_call`.
- **Current code assumes:** both `codex-wrapper.ts` and `codex-rollout.ts` look for `thread.started`, `turn.started`, `turn.completed`, `item.completed`, and `error`.
- **Implication:** the current Codex ingestors are contract-fragile and likely incomplete against real local rollouts. Codex needs to move to a versioned adapter that can parse both documented event streams and the actual rollout schema we observed, with canonical fields for `approval_policy`, `sandbox_policy`, `model`, `git`, and session origin.

#### OpenCode

- **Docs say:** OpenCode has first-class session/message/part entities, programmatic prompt/command APIs, export/share flows, and model usage stats.
- **Observed locally:** this machine has legacy session JSON files under `~/.local/share/opencode/storage/session/...`, but the sampled files are metadata-only with keys like `directory`, `id`, `projectID`, `slug`, `time`, `title`, and `version`. No live `opencode.db` was present, and the sampled JSON files did not embed `messages`.
- **Current code assumes:** `opencode-ingest.ts` can read either a SQLite `session` + `message` schema or legacy JSON files with embedded `messages`.
- **Implication:** OpenCode needs a stricter capture-mode split. Metadata-only local session files should not be treated like full transcripts. We likely need to ingest message bodies from the current export/server API path, and we should model export/share lineage separately from local storage snapshots.

#### OpenClaw

- **Docs say:** OpenClaw has transport-aware session routing (`sessionKey` vs `sessionId`), hook automation, command logging, cleanup/pruning, and channel/account/session/message dedupe semantics.
- **Observed in repo fixtures:** session files begin with a `session` header and then message lines using roles such as `user`, `assistant`, and `toolResult`. Content blocks include `text`, `thinking`, `toolCall`, and `toolUse`, with `toolCallId` and `isError` on result lines.
- **Current code assumes:** `openclaw-ingest.ts` parses the fixture file format and derives prompt/tool/error data from those message blocks.
- **Implication:** the current OpenClaw ingestor is only covering the transcript layer. The canonical schema should also reserve transport and routing dimensions from the official docs, such as `session_key`, `channel`, `account_id`, and dedupe identifiers, even when those are absent from fixture-only captures.

### Track 0 Decisions From Verification

- `platform`, `capture_mode`, `source_session_kind`, `session_id`, and `raw_source_ref` should be required on every canonical event.
- `prompt_id`, `prompt_kind`, `is_actionable`, and `matched_prompt_id` should be canonicalized at normalization time, not inferred separately in dashboard/status/evals code.
- `model`, `provider`, `approval_policy`, `sandbox_policy`, `cwd`, `branch`, `git`, `agent_id`, `agent_type`, `session_key`, and `channel` should be optional canonical fields with source-specific population rules.
- `skill_invocation_id`, `invocation_mode`, and `confidence` should be explicit canonical fields so repaired/inferred/explicit invocations stop collapsing into the same raw log shape.
- The refactor priority order should be: Codex adapter rewrite first, OpenCode capture-mode split second, Claude hook expansion third, OpenClaw transport metadata fourth.

---

## Target Architecture

### Layer 1: Raw Capture

Preserve append-only raw logs exactly as they arrive from each adapter.

- Claude Code hooks / replay
- Codex wrapper / rollout ingest
- OpenCode ingest
- OpenClaw ingest

### Layer 2: Canonical Normalization

Create a single internal event model that every adapter maps into.

Candidate entities:

- `CanonicalSession`
- `CanonicalPrompt`
- `CanonicalSkillInvocation`
- `CanonicalExecutionTelemetry`
- `CanonicalEvolutionEvent`

### Layer 3: Projections

Project canonical events into:

- local JSONL materializations for CLI/dashboard
- repaired overlays
- cloud Neon tables
- contribution bundles

The cloud product should consume the same canonical model as local, not a second interpretation.

---

## Proposed Canonical Tables / Records

### `sessions`

- `session_id`
- `platform`
- `capture_mode`
- `source_session_kind`
- `started_at`
- `ended_at`
- `workspace_path`
- `repo_root`
- `repo_remote`
- `branch`
- `commit_sha`
- `agent_cli`
- `model`
- `input_tokens`
- `output_tokens`
- `duration_ms`

### `prompts`

- `prompt_id`
- `session_id`
- `timestamp`
- `prompt_text`
- `prompt_hash`
- `prompt_kind`
- `is_actionable`
- `source_ref`

### `skill_invocations`

- `skill_invocation_id`
- `session_id`
- `prompt_id`
- `timestamp`
- `skill_name`
- `skill_path`
- `skill_version_hash`
- `invocation_mode`
- `triggered`
- `confidence`
- `source_ref`

### `execution_facts`

- `session_id`
- `tool_calls_json`
- `total_tool_calls`
- `assistant_turns`
- `errors_encountered`
- `bash_commands_redacted`
- `interrupted`

### `normalization_runs`

- `normalizer_version`
- `run_at`
- `source_platform`
- `capture_mode`
- `raw_records_seen`
- `canonical_records_written`
- `repair_applied`

---

## Implementation Tracks

### Track 0: Platform Contract Verification

| Step | Description                                                                                                                                         | Depends On |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 0A   | Inventory official docs for Claude Code, Codex, OpenCode, and OpenClaw fields relevant to sessions, prompts, invocations, hooks, stats, and exports | —          |
| 0B   | Capture fresh local sessions where available, and fall back to checked-in fixtures when a platform is not installed on this machine                 | 0A         |
| 0C   | Record drift cases where docs and observed payloads differ, and decide whether canonical fields are `required`, `optional`, or `derived`            | 0B         |
| 0D   | Freeze a source-to-canonical field mapping table before adapter refactors begin                                                                     | 0C         |

### Track A: Schema and Domain Model

| Step | Description                                                                         | Depends On |
| ---- | ----------------------------------------------------------------------------------- | ---------- |
| A1   | Define canonical event entities in `types.ts` without breaking existing log readers | —          |
| A2   | Add explicit enums for `platform`, `capture_mode`, `prompt_kind`, `invocation_mode` | A1         |
| A3   | Add `schema_version` + `normalizer_version` to canonical records                    | A1         |
| A4   | Write design doc for canonical event model and local/cloud projection rules         | A1         |

### Track B: Local Normalizer

| Step | Description                                                                       | Depends On |
| ---- | --------------------------------------------------------------------------------- | ---------- |
| B1   | Add a normalization module that converts raw adapter data into canonical events   | A2         |
| B2   | Move actionable/meta classification into normalization, not downstream dashboards | B1         |
| B3   | Emit normalized local projections from canonical events                           | B1         |
| B4   | Fold repaired overlays into the same normalization pipeline                       | B1         |

### Track C: Adapter Upgrades

| Step | Description                                                                     | Depends On     |
| ---- | ------------------------------------------------------------------------------- | -------------- |
| C1   | Upgrade Claude Code hook/replay writers to populate canonical source dimensions | B1             |
| C2   | Upgrade Codex wrapper/rollout ingest to canonical source dimensions             | B1             |
| C3   | Upgrade OpenCode ingest to canonical source dimensions                          | B1             |
| C4   | Upgrade OpenClaw ingest to canonical source dimensions                          | B1             |
| C5   | Add adapter fixture coverage for normalization output parity                    | C1, C2, C3, C4 |

### Track D: Cloud Projection

| Step | Description                                                             | Depends On |
| ---- | ----------------------------------------------------------------------- | ---------- |
| D1   | Define Neon schema for sessions, prompts, invocations, telemetry facts  | A4         |
| D2   | Add canonical-to-Neon projection layer                                  | D1, B3     |
| D3   | Ensure local and cloud dashboards consume the same canonical view model | D2         |
| D4   | Add replay-safe idempotency keys for cloud upserts                      | D2         |

### Track E: Analytics and Evidence

| Step | Description                                                                       | Depends On |
| ---- | --------------------------------------------------------------------------------- | ---------- |
| E1   | Replace free-form `source` heuristics in analytics with canonical fields          | B3         |
| E2   | Add quality dashboards for `meta_rate`, `repair_rate`, `explicit_invocation_rate` | B3         |
| E3   | Track invocation confidence and prompt/invocation joins in reports                | E1         |
| E4   | Add cloud-facing evidence exports from canonical records                          | D2, E3     |

---

## Success Criteria

- [ ] A canonical event model exists and is documented
- [ ] Every adapter maps to the same source dimensions
- [ ] Prompt/actionability classification happens once in normalization
- [ ] Local CLI/dashboard read canonical projections, not raw adapter assumptions
- [ ] Repair overlays are first-class normalization inputs
- [ ] Neon schema mirrors canonical entities instead of raw JSONL shapes
- [ ] Session, prompt, and skill invocation identity are stable and joinable
- [ ] We can answer “which agent, from which platform, in which mode, invoked which skill for which prompt?” without heuristics
- [ ] We can measure data quality itself: meta contamination, repair dependence, explicit invocation coverage

---

## Recommended Immediate Next Steps

1. Finish Track 0 and write down the source-to-canonical field mapping table
2. Introduce canonical enums and types in `cli/selftune/types.ts`
3. Add a normalization module that all adapters call before writing projections
4. Add first-class `platform` and `capture_mode` to every canonical event
5. Move the current query filters and repair overlay logic under that normalizer
6. Design the Neon tables from canonical entities, not from the current JSONL log files
