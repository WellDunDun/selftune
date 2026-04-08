# selftune Export Canonical Workflow

Export canonical telemetry records as JSONL or as a V2 push payload for cloud
upload. Canonical records are the normalized, platform-agnostic representation
of sessions, prompts, skill invocations, execution facts, and normalization runs.

## When to Use

- The user wants to export telemetry data for external analysis
- The user says "export canonical", "canonical export", or "canonical telemetry"
- The agent needs to produce a push payload for manual upload inspection
- Debugging what data would be sent to the cloud API

## Default Command

```bash
selftune export-canonical
```

## Options

| Flag                    | Description                                                         |
| ----------------------- | ------------------------------------------------------------------- |
| `--out <path>`          | Write output to a file instead of stdout                            |
| `--platform <name>`     | Filter by platform (`claude_code`, `codex`, `opencode`, `openclaw`) |
| `--record-kind <kind>`  | Filter by record kind (`session`, `prompt`, `skill_invocation`, `execution_fact`, `normalization_run`) |
| `--pretty`              | Pretty-print JSON output with 2-space indentation                   |
| `--log <path>`          | Path to canonical log file (default: `~/.claude/canonical_log.jsonl`) |
| `--projects-dir <path>` | Claude transcript directory for fallback synthesis (default: `~/.claude/projects`) |
| `--push-payload`        | Output as a V2 push payload envelope instead of raw JSONL           |

## Output Formats

### Default (JSONL)

One canonical record per line:

```jsonl
{"record_kind":"session","session_id":"abc123","platform":"claude_code",...}
{"record_kind":"prompt","prompt_id":"p1","session_id":"abc123",...}
{"record_kind":"skill_invocation","invocation_id":"inv1","skill_name":"selftune",...}
```

### Push Payload (`--push-payload`)

A single JSON envelope matching the V2 cloud upload schema:

```json
{
  "schema_version": "2.0",
  "client_version": "0.1.0",
  "push_id": "uuid",
  "normalizer_version": "1.0.0",
  "canonical": {
    "sessions": [...],
    "prompts": [...],
    "skill_invocations": [...],
    "execution_facts": [...],
    "normalization_runs": [...],
    "evolution_evidence": [...],
    "orchestrate_runs": [],
    "grading_results": [],
    "improvement_signals": []
  }
}
```

### File output (`--out`)

When `--out` is specified, the data is written to the file and a JSON summary
is printed to stdout:

```json
{
  "ok": true,
  "out": "/path/to/output.jsonl",
  "count": 42,
  "format": "jsonl",
  "pretty": false,
  "platform": null,
  "record_kind": null
}
```

## Fallback Behavior

If the canonical log file is empty or does not exist, the command falls back to
synthesizing canonical records directly from Claude Code transcripts in
`--projects-dir`. This supports existing installs that have rich transcript
data but have not yet generated a canonical log.

## Common Patterns

**Export all canonical data**

> Run `selftune export-canonical > export.jsonl` to dump everything.

**Export only skill invocations**

> Run `selftune export-canonical --record-kind skill_invocation` to filter.

**Inspect push payload before upload**

> Run `selftune export-canonical --push-payload --pretty` to see exactly what would be sent to the cloud API.

**Export to file with summary**

> Run `selftune export-canonical --out /tmp/export.jsonl --pretty` to write data and see a count summary.

**Filter by platform**

> Run `selftune export-canonical --platform claude_code` to export only Claude Code records.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Empty output | No canonical log and no transcripts | Run `selftune sync` or `selftune quickstart` to ingest data first |
| "Unknown platform" error | Invalid `--platform` value | Use one of: `claude_code`, `codex`, `opencode`, `openclaw` |
| "Unknown record kind" error | Invalid `--record-kind` value | Use one of: `session`, `prompt`, `skill_invocation`, `execution_fact`, `normalization_run` |
| Push payload missing evolution evidence | No evolution runs recorded | Run `selftune evolve` to generate evidence, then re-export |
