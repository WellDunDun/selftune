# selftune Ingest Workflow

Import sessions from non-Claude-Code agent platforms into the shared
selftune log format. Covers three sub-commands: `ingest-codex`,
`ingest-opencode`, and `wrap-codex`.

## When to Use Each

| Sub-command | Platform | Mode | When |
|-------------|----------|------|------|
| `ingest-codex` | Codex | Batch | Import existing Codex rollout logs |
| `ingest-opencode` | OpenCode | Batch | Import existing OpenCode sessions |
| `wrap-codex` | Codex | Real-time | Wrap `codex exec` to capture telemetry live |

---

## ingest-codex

Batch ingest Codex rollout logs into the shared JSONL schema.

### Default Command

```bash
selftune ingest-codex
```

### Options

None. Reads from the standard Codex session directory.

### Source

Reads from `$CODEX_HOME/sessions/` directory. Expects the Codex rollout
JSONL format. See `references/logs.md` for the Codex rollout format.

### Output

Writes to:
- `~/.claude/all_queries_log.jsonl` -- extracted user queries
- `~/.claude/session_telemetry_log.jsonl` -- per-session metrics with `source: "codex_rollout"`

### Steps

1. Verify `$CODEX_HOME/sessions/` directory exists and contains session files
2. Run `selftune ingest-codex`
3. Verify entries were written by checking log file line counts
4. Run `selftune doctor` to confirm logs are healthy

---

## ingest-opencode

Ingest OpenCode sessions from the SQLite database.

### Default Command

```bash
selftune ingest-opencode
```

### Options

None. Auto-discovers the database location.

### Source

Primary: `~/.local/share/opencode/opencode.db` (SQLite database)
Fallback: Legacy JSON session files in the OpenCode data directory

See `references/logs.md` for the OpenCode message format.

### Output

Writes to:
- `~/.claude/all_queries_log.jsonl` -- extracted user queries
- `~/.claude/session_telemetry_log.jsonl` -- per-session metrics with `source: "opencode"` or `"opencode_json"`

### Steps

1. Verify the OpenCode database exists at the expected path
2. Run `selftune ingest-opencode`
3. Verify entries were written by checking log file line counts
4. Run `selftune doctor` to confirm logs are healthy

---

## wrap-codex

Wrap `codex exec` with real-time telemetry capture. Drop-in replacement
that tees the JSONL stream while passing through to Codex.

### Default Command

```bash
selftune wrap-codex -- <your codex args>
```

### Usage

Everything after `--` is passed directly to `codex exec`:

```bash
selftune wrap-codex -- --model o3 "Fix the failing tests"
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

---

## Common Patterns

**"Ingest codex logs"**
> Run `selftune ingest-codex`. No options needed. Reads from `$CODEX_HOME/sessions/`.

**"Import opencode sessions"**
> Run `selftune ingest-opencode`. Reads from the SQLite database automatically.

**"Run codex through selftune"**
> Use `selftune wrap-codex -- <codex args>` instead of `codex exec <args>` directly.

**"Batch ingest vs real-time"**
> Use `selftune ingest-codex` or `selftune ingest-opencode` for historical sessions.
> Use `selftune wrap-codex` for ongoing sessions. Both produce the same log format.

**"How do I know it worked?"**
> Run `selftune doctor` after ingestion. Check that log files exist and are parseable.
> Run `selftune evals --list-skills` to see if the ingested sessions appear.
