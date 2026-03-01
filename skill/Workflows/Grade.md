# selftune Grade Workflow

Grade a completed skill session against expectations. Produces `grading.json`
with a 3-tier evaluation covering trigger, process, and quality.

## Default Command

```bash
selftune grade --skill <name> [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--skill <name>` | Skill name to grade | Required |
| `--expectations "..."` | Explicit expectations (semicolon-separated) | Auto-derived |
| `--evals-json <path>` | Pre-built eval set JSON file | None |
| `--eval-id <n>` | Specific eval ID to grade from the eval set | None |
| `--use-agent` | Grade via agent subprocess (no API key needed) | Off (uses API) |

## Output Format

The command produces `grading.json`. See `references/grading-methodology.md`
for the full schema. Key fields:

```json
{
  "session_id": "abc123",
  "skill_name": "pptx",
  "transcript_path": "~/.claude/projects/.../abc123.jsonl",
  "graded_at": "2026-02-28T12:00:00Z",
  "expectations": [
    { "text": "...", "passed": true, "evidence": "..." }
  ],
  "summary": { "passed": 2, "failed": 1, "total": 3, "pass_rate": 0.67 },
  "execution_metrics": { "tool_calls": {}, "total_tool_calls": 6, "errors_encountered": 0 },
  "claims": [
    { "claim": "...", "type": "factual", "verified": true, "evidence": "..." }
  ],
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

Read `~/.claude/session_telemetry_log.jsonl` and find the most recent entry
where `skills_triggered` contains the target skill name.

Note the `transcript_path`, `tool_calls`, `errors_encountered`, and
`session_id` fields. See `references/logs.md` for the telemetry format.

### 2. Read the Transcript

Parse the JSONL file at `transcript_path`. Identify:
- User messages (what was asked)
- Assistant tool calls (what the agent did)
- Tool results (what happened)
- Error patterns (what went wrong)

See `references/logs.md` for transcript format variants.

### 3. Determine Expectations

If the user provided `--expectations`, parse the semicolon-separated list.
Otherwise, derive defaults. See `references/grading-methodology.md` for the
full default expectations list.

Always include at least one Process expectation and one Quality expectation.

### 4. Grade Each Expectation

For each expectation, search both the telemetry record and the transcript
for evidence. Mark as:
- **PASS** if evidence exists and supports the expectation
- **FAIL** if evidence is absent or contradicts the expectation

Cite specific evidence: transcript line numbers, tool call names, bash output.

### 5. Extract Implicit Claims

Pull 2-4 claims from the transcript that are not covered by the explicit
expectations. Classify each as factual, process, or quality. Verify each
against the transcript. See `references/grading-methodology.md` for claim
types and examples.

### 6. Flag Eval Gaps

Review each passed expectation. If it would also pass for wrong output,
note it in `eval_feedback.suggestions`. See `references/grading-methodology.md`
for gap flagging criteria.

### 7. Write grading.json

Write the full grading result to `grading.json` in the current directory.

### 8. Summarize

Report to the user:
- Pass rate (e.g., "2/3 passed, 67%")
- Failed expectations with evidence
- Notable claims
- Top eval feedback suggestion

Keep the summary concise. The full details are in `grading.json`.

## Common Patterns

**"Grade my last pptx session"**
> Find the most recent telemetry entry for `pptx`. Use default expectations.
> Ask if the user wants custom expectations or proceed with defaults.

**"Grade with these specific expectations"**
> Pass `--expectations "expect1;expect2;expect3"` to override defaults.

**"Grade using an eval set"**
> Pass `--evals-json path/to/evals.json` and optionally `--eval-id N`
> to grade a specific eval scenario.

**"I don't have an API key"**
> Use `--use-agent` to grade via agent subprocess instead of direct API.
