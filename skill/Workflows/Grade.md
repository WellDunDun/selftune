# selftune Grade Workflow

Grade a completed skill session against expectations. Produces `grading.json`
with a 3-tier evaluation covering trigger, process, and quality.

## Default Command

```bash
selftune grade --skill <name> [options]
```

## Options

| Flag                   | Description                                 | Default       |
| ---------------------- | ------------------------------------------- | ------------- |
| `--skill <name>`       | Skill name to grade                         | Required      |
| `--expectations "..."` | Explicit expectations (semicolon-separated) | Auto-derived  |
| `--evals-json <path>`  | Pre-built eval set JSON file                | None          |
| `--eval-id <n>`        | Specific eval ID to grade from the eval set | None          |
| `--agent <name>`       | Agent CLI to use (claude, codex, opencode)  | Auto-detected |

## Output Format

The command produces `grading.json`. See `references/grading-methodology.md`
for the full schema. Key fields:

```json
{
  "session_id": "abc123",
  "skill_name": "pptx",
  "transcript_path": "~/.claude/projects/.../abc123.jsonl",
  "graded_at": "2026-02-28T12:00:00Z",
  "expectations": [{ "text": "...", "passed": true, "evidence": "..." }],
  "summary": { "passed": 2, "failed": 1, "total": 3, "pass_rate": 0.67 },
  "execution_metrics": { "tool_calls": {}, "total_tool_calls": 6, "errors_encountered": 0 },
  "claims": [{ "claim": "...", "type": "factual", "verified": true, "evidence": "..." }],
  "eval_feedback": { "suggestions": [], "overall": "..." }
}
```

## Parsing Instructions

### Get Pass Rate

```bash
# Parse: .summary.pass_rate (float 0-1)
# Parse: .summary.passed / .summary.total
```

### Find Failed Expectations

```bash
# Parse: .expectations[] | select(.passed == false) | .text
```

### Extract Claims

```bash
# Parse: .claims[] | { claim, type, verified }
```

### Get Eval Feedback

```bash
# Parse: .eval_feedback.suggestions[].reason
# Parse: .eval_feedback.overall
```

## Steps

### 1. Find the Session

Read `~/.claude/session_telemetry_log.jsonl`. Find the most recent entry
where `skills_triggered` contains the target skill name. Extract the
`transcript_path`, `tool_calls`, `errors_encountered`, and `session_id`
fields. See `references/logs.md` for the telemetry format.

### 2. Read the Transcript

Parse the JSONL file at `transcript_path`. Extract:

- User messages (what was asked)
- Assistant tool calls (what the agent did)
- Tool results (what happened)
- Error patterns (what went wrong)

See `references/logs.md` for transcript format variants.

### 3. Determine Expectations

If `--expectations` was provided, parse the semicolon-separated list.
Otherwise, derive defaults from `references/grading-methodology.md`.
Ensure at least one Process expectation and one Quality expectation.

### 4. Grade Each Expectation

Search both the telemetry record and the transcript for evidence per
expectation. Mark as:

- **PASS** if evidence exists and supports the expectation
- **FAIL** if evidence is absent or contradicts the expectation

Cite specific evidence: transcript line numbers, tool call names, bash output.

### 5. Extract Implicit Claims

Pull 2-4 claims from the transcript not covered by explicit expectations.
Classify each as factual, process, or quality. Verify each against the
transcript. See `references/grading-methodology.md` for claim types.

### 6. Flag Eval Gaps

Review each passed expectation. If it would also pass for wrong output,
record it in `eval_feedback.suggestions`. See
`references/grading-methodology.md` for gap flagging criteria.

### 7. Write grading.json

Write the full grading result to `grading.json` in the current directory.

### 8. Report Results

Report to the user:

- Pass rate (e.g., "2/3 passed, 67%")
- Failed expectations with evidence
- Notable claims
- Top eval feedback suggestion

Keep the summary concise. The full details are in `grading.json`.

## Common Patterns

**User asks to grade a skill session**

> Run `selftune grade --skill <name>` with default expectations. Results are
> written to `grading.json`. Read that file and report the pass rate and any
> failures to the user.

**User provides specific expectations**

> Run `selftune grade --skill <name> --expectations "expect1;expect2;expect3"`.
> Parse results and report.

**User wants to grade from an eval set**

> Run `selftune grade --skill <name> --evals-json path/to/evals.json`.
> Optionally add `--eval-id N` for a specific scenario.

**Agent detection override needed**

> The grader auto-detects the agent CLI. If detection fails or the user
> specifies an agent, pass `--agent <name>` to override.

## Autonomous Mode

Grading runs implicitly during orchestrate as part of status computation.
The orchestrator reads grading results to determine which skills are
candidates for evolution. No explicit grade command is called — the
grading results from previous sessions feed into candidate selection.
