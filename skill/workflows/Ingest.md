# selftune Ingest Workflow

> **Note:** Claude Code is the fully supported platform. Codex, OpenCode, Pi, and OpenClaw adapters are experimental and may have gaps.

Import sessions from agent platforms into the shared selftune log format.
Covers six sub-commands: `ingest claude`, `ingest codex`, `ingest opencode`,
`ingest openclaw`, `ingest pi`, and `ingest wrap-codex`.

`ingest claude`, `ingest codex`, `ingest opencode`, and `ingest pi` use the
same source-sync pipeline: records enter the local SQLite canonical store, then
eligible traces flow through the shared SQLite-to-DuckDB `LocalTraceImporter`.
An explicit ingest command imports its selected source regardless of onboarding
source-enable preferences. OpenClaw remains canonical-only, and Cline remains
hook-only; neither uses this batch trace-import path.

## When to Use Each

| Sub-command         | Platform    | Mode      | When                                                |
| ------------------- | ----------- | --------- | --------------------------------------------------- |
| `ingest claude`     | Claude Code | Batch     | Backfill logs from existing Claude Code transcripts |
| `ingest codex`      | Codex       | Batch     | Import existing Codex rollout logs                  |
| `ingest opencode`   | OpenCode    | Batch     | Import existing OpenCode sessions                   |
| `ingest openclaw`   | OpenClaw    | Batch     | Import existing OpenClaw agent sessions             |
| `ingest pi`         | Pi          | Batch     | Import existing Pi agent sessions                   |
| `ingest wrap-codex` | Codex       | Real-time | Wrap `codex exec` to capture telemetry live         |

---

## ingest claude

Batch ingest existing Claude Code session transcripts into the shared JSONL schema.

### Default Command

```bash
selftune ingest claude
```

### Shared options for Claude, Codex, OpenCode, and Pi

| Flag                   | Description                                  |
| ---------------------- | -------------------------------------------- |
| `--source-root <path>` | Override the selected platform's source root |
| `--since <date>`       | Only ingest sessions from this date onward   |
| `--dry-run`            | Preview without writing                      |
| `--force`              | Re-ingest files that are already marked      |
| `--skill-log <path>`   | Override the skill-usage JSONL output path   |
| `--verbose` / `-v`     | Show source-sync progress                    |

Each route also accepts its source-root alias: `--projects-dir` (Claude),
`--codex-home` (Codex), `--data-dir` (OpenCode), or `--sessions-dir` (Pi).

### Claude-specific source alias

| Flag                    | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `--since <date>`        | Only ingest sessions modified after this date (e.g., `2026-01-01`) |
| `--dry-run`             | Show what would be ingested without writing to logs                |
| `--force`               | Re-ingest all sessions, ignoring the marker file                   |
| `--verbose`             | Show per-file progress during ingestion                            |
| `--projects-dir <path>` | Override default `~/.claude/projects/` directory                   |

### Source

Reads from `~/.claude/projects/<hash>/<session-id>.jsonl`. These are the
transcript files Claude Code automatically saves for every session.

### Output

Writes to:

- `~/.claude/all_queries_log.jsonl` -- extracted user queries (one per query, not just last)
- `~/.claude/session_telemetry_log.jsonl` -- per-session metrics with `source: "claude_code_replay"`
- `~/.claude/skill_usage_log.jsonl` -- skill triggers with `source: "claude_code_replay"`

### Steps

1. Run `selftune ingest claude --dry-run` to preview what would be ingested
2. Run `selftune ingest claude` to ingest all sessions
3. Run `selftune doctor` to confirm logs are healthy
4. Run `selftune eval generate --list-skills` to see if the ingested sessions appear

### Notes

- Idempotent: uses a marker file (`~/.claude/claude_code_ingested_sessions.json`) to track
  which transcripts have already been ingested. Safe to run repeatedly.
- Extracts ALL user queries per session, not just the last one.
- Filters out system messages, short queries (<4 chars), and queries matching `SKIP_PREFIXES`.
- Retains promptless subagent sidechains when they contain assistant or tool execution. These
  contribute system-observability spans without inventing prompt rows or skill invocations.

---

## ingest codex

Batch ingest Codex rollout logs into the shared JSONL schema.

### Default Command

```bash
selftune ingest codex
```

### Source

Reads from `$CODEX_HOME/sessions/` directory. Expects the Codex rollout
JSONL format. See `references/logs.md` for the Codex rollout format.

### Output

Writes to:

- `~/.claude/all_queries_log.jsonl` -- extracted user queries
- `~/.claude/session_telemetry_log.jsonl` -- per-session metrics with `source: "codex_rollout"`
- the local SQLite observability store when the rollout contains one actionable prompt and
  source timestamps for a real interval; this records metadata-only trace timing and scalar
  token, error, and tool-call signals, correlated with the canonical skill invocation when one
  was observed

### Notes

- Source-correct: multi-turn rollouts and rollouts without a real source interval do not produce
  a synthetic actionable-turn span.
- Replay-safe: trace-to-skill aggregates use stable canonical invocation links, so re-importing
  the same rollout does not inflate duration, token, error, or tool-call counts.
- Pattern-safe: Skill Intelligence reads all per-skill aggregates in one batch. When errors
  correlate with at least two of three traced executions and at least half of the sample, the
  report records a supported `repeated_correlated_errors` pattern. This is observational,
  does not claim the skill caused the errors, and does not trigger autonomous evolution.
- Conservative skill attribution: Codex rollout ingest only attributes a skill when it has
  explicit evidence, such as a skill file/path read or an explicit user mention that invokes
  the skill. Incidental mentions inside assistant reasoning, optimizer prompts, or eval text do
  not count as triggers.
- Append-aware: resumed rollout files are reprocessed when their size or modification time changes.
  Each replay atomically replaces that Codex session's prior batch-derived prompts, skill
  invocations, and execution facts while preserving live hook and wrapper records.
- Memory-bounded: rollout JSONL is streamed in 64 KiB chunks. Individual records above 8 MiB are
  omitted from the metadata projection while surrounding records continue to import; the durable
  rollout file is never modified.

### Steps

1. Verify `$CODEX_HOME/sessions/` directory exists and contains session files
2. Run `selftune ingest codex`
3. Verify entries were written by checking log file line counts
4. Run `selftune doctor` to confirm logs are healthy

---

## ingest opencode

Ingest OpenCode sessions from the SQLite database.

### Default Command

```bash
selftune ingest opencode
```

### Source

Primary: `~/.local/share/opencode/opencode.db` (SQLite database)
Fallback: Legacy JSON session files in the OpenCode data directory

See `references/logs.md` for the OpenCode message format.

### Output

Writes to:

- `~/.claude/all_queries_log.jsonl` -- extracted user queries
- `~/.claude/session_telemetry_log.jsonl` -- per-session metrics with `source: "opencode"` or `"opencode_json"`

### Notes

- Current OpenCode databases are read from the separate `session`, `message`, and `part` tables.
  SelfTune projects only bounded text, tool metadata, timestamps, model identity, token counts, and
  error state; embedded diffs, file bodies, images, and tool output do not enter the trace importer.
- Sessions are materialized in bounded chunks, and unchanged databases use a fingerprint fast path.
- Legacy JSON session stores remain supported.

### Steps

1. Verify the OpenCode database exists at the expected path
2. Run `selftune ingest opencode`
3. Verify entries were written by checking log file line counts
4. Run `selftune doctor` to confirm logs are healthy

---

## ingest openclaw

Batch ingest OpenClaw agent session histories into the shared JSONL schema.
Supports multiple agents and auto-discovers session files across all agent directories.

### Default Command

```bash
selftune ingest openclaw
```

### Options

| Flag                  | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `--agents-dir <path>` | Override default `~/.openclaw/agents/` directory                   |
| `--since <date>`      | Only ingest sessions modified after this date (e.g., `2026-01-01`) |
| `--dry-run`           | Show what would be ingested without writing to logs                |
| `--force`             | Re-ingest all sessions, ignoring the marker file                   |
| `--verbose` / `-v`    | Show per-session progress during ingestion                         |

### Source

Reads from `~/.openclaw/agents/<agentId>/sessions/*.jsonl`. Each JSONL file contains:

- Line 1 (session header): `{"type":"session","version":5,"id":"<uuid>","timestamp":"<iso>","cwd":"<path>"}`
- Line 2+ (messages): `{"role":"user|assistant|toolResult","content":[...],"timestamp":<ms>}`

### Output

Writes to:

- `~/.claude/all_queries_log.jsonl` -- extracted user queries
- `~/.claude/session_telemetry_log.jsonl` -- per-session metrics with `source: "openclaw"`
- `~/.claude/skill_usage_log.jsonl` -- skill triggers with `source: "openclaw"`

### Steps

1. Run `selftune ingest openclaw --dry-run` to preview what would be ingested
2. Run `selftune ingest openclaw` to ingest all sessions
3. Run `selftune doctor` to confirm logs are healthy
4. Run `selftune eval generate --list-skills` to see if the ingested sessions appear

### Notes

- Idempotent: uses a marker file to track which sessions have already been ingested.
  Safe to run repeatedly. Use `--force` to re-ingest everything.
- Skill detection heuristic: identifies skills by checking for `SKILL.md` file reads in
  tool calls and by matching known skill names in assistant text content.
- Multi-agent support: scans all agent directories under the agents root, ingesting
  sessions from every agent found.

---

## ingest pi

Batch ingest Pi agent session histories into the shared JSONL schema.

### Default Command

```bash
selftune ingest pi
```

### Options

| Flag                    | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `--sessions-dir <path>` | Override default `~/.pi/agent/sessions/` directory                 |
| `--since <date>`        | Only ingest sessions modified after this date (e.g., `2026-01-01`) |
| `--dry-run`             | Show what would be ingested without writing to logs                |
| `--force`               | Re-ingest all sessions, ignoring the marker file                   |
| `--verbose` / `-v`      | Show per-session progress during ingestion                         |

### Source

Reads from `~/.pi/agent/sessions/`. Each session file contains Pi agent
conversation history in JSONL format.

Skill discovery includes Pi's global `~/.pi/agent/skills/` registry and compatible
project-local registries. Real Pi `read` tool calls to `SKILL.md` are correlated with
their canonical skill invocation.

### Output

Writes to:

- `~/.claude/all_queries_log.jsonl` -- extracted user queries
- `~/.claude/session_telemetry_log.jsonl` -- per-session metrics with `source: "pi"`
- `~/.claude/skill_usage_log.jsonl` -- skill triggers with `source: "pi"`

### Steps

1. Run `selftune ingest pi --dry-run` to preview what would be ingested
2. Run `selftune ingest pi` to ingest all sessions
3. Run `selftune doctor` to confirm logs are healthy
4. Run `selftune eval generate --list-skills` to see if the ingested sessions appear

### Notes

- Idempotent: uses a marker file to track which sessions have already been ingested.
  Safe to run repeatedly. Use `--force` to re-ingest everything.
- Skill detection heuristic: identifies skills by checking for `SKILL.md` file reads in
  tool calls and by matching known skill names in assistant text content.

---

## ingest wrap-codex

Wrap `codex exec` with real-time telemetry capture. Drop-in replacement
that tees the JSONL stream while passing through to Codex.

### Default Command

```bash
selftune ingest wrap-codex -- <your codex args>
```

### Usage

Everything after `--` is passed directly to `codex exec`:

```bash
selftune ingest wrap-codex -- --model o3 "Fix the failing tests"
```

### Output

Writes to:

- `~/.claude/all_queries_log.jsonl` -- the user query
- `~/.claude/session_telemetry_log.jsonl` -- session metrics with `source: "codex"`

The Codex output is passed through unchanged. The wrapper only tees the
stream for telemetry; it does not modify Codex behavior.

### Steps

1. Build the wrap-codex command with the desired Codex arguments
2. Run the command (replaces `codex exec` in your workflow)
3. Session telemetry is captured automatically
4. Verify with `selftune doctor` after first use

If telemetry capture fails, check that the codex binary is accessible and that
the target working directory exists. Inspect the wrapper's stderr output for
error details — `wrap-codex` captures telemetry through the Codex wrapper, not
through hooks.

---

## Common Patterns

**"Backfill Claude Code sessions"**

> Run `selftune ingest claude`. No options needed. Reads from `~/.claude/projects/`.

**"Replay only recent Claude Code sessions"**

> Run `selftune ingest claude --since 2026-02-01` with an appropriate date.

**"Ingest codex logs"**

> Run `selftune ingest codex`. No options needed. Reads from `$CODEX_HOME/sessions/`.

**"Import opencode sessions"**

> Run `selftune ingest opencode`. Reads from the SQLite database automatically.

**"Ingest OpenClaw sessions"**

> Run `selftune ingest openclaw`. Reads from `~/.openclaw/agents/` automatically.

**"Import only recent OpenClaw sessions"**

> Run `selftune ingest openclaw --since 2026-02-01` with an appropriate date.

**"Ingest Pi sessions"**

> Run `selftune ingest pi`. Reads from `~/.pi/agent/sessions/` automatically.

**"Import only recent Pi sessions"**

> Run `selftune ingest pi --since 2026-02-01` with an appropriate date.

**"Run codex through selftune"**

> Use `selftune ingest wrap-codex -- <codex args>` instead of `codex exec <args>` directly.

**"Batch ingest vs real-time"**

> Use `selftune ingest codex` or `selftune ingest opencode` for historical sessions.
> Use `selftune ingest wrap-codex` for ongoing sessions. Both produce the same log format.

**"How do I know it worked?"**

> Run `selftune doctor` after ingestion. Check that log files exist and are parseable.
> Run `selftune eval generate --list-skills` to see if the ingested sessions appear.
