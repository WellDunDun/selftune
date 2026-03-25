# Grading Methodology Reference

How selftune evaluates skill sessions. Used by the `grade` command and
referenced by evolution workflows to understand quality signals.

---

## 3-Tier Grading Model

Every session is graded across three tiers, each answering a different question:

| Tier        | Question                              | Example expectation                           |
| ----------- | ------------------------------------- | --------------------------------------------- |
| **Trigger** | Did the skill fire at all?            | `skills_triggered` contains the skill name    |
| **Process** | Did the agent follow the right steps? | SKILL.md was read before main work started    |
| **Quality** | Was the output actually good?         | Output file has correct content and structure |

A session can pass Trigger but fail Process (skill fired, but steps were wrong),
or pass Process but fail Quality (steps were right, but output was bad).

---

## Expectation Derivation

When the user does not supply explicit expectations, derive reasonable defaults.
Always include at least one Process and one Quality expectation.

### Default Expectations

1. **SKILL.md was read before main work started** (Process)
   - Evidence: a `Read` tool call with a path ending in `SKILL.md` appears before
     any `Write`, `Edit`, or significant `Bash` command.

2. **No more than 1 error encountered** (Quality)
   - Evidence: `errors_encountered` field in session telemetry is 0 or 1.

3. **Expected output type exists** (Quality)
   - Evidence: the file, command output, or artifact the user asked for is present.

4. **No thrashing** (Process)
   - Evidence: no single bash command or tool call is repeated more than 3 times
     consecutively in the transcript.

5. **Skill steps followed in order** (Process)
   - Evidence: the sequence of tool calls matches the step order in SKILL.md.

---

## Evidence Standards

### What counts as evidence

- A specific tool call from the transcript (e.g., `[TOOL:Read] /path/to/SKILL.md`)
- A bash command and its output (e.g., `Bash output: 'presentation.pptx created'`)
- A telemetry field value (e.g., `errors_encountered: 0`)
- A transcript line number and content

### Strictness rules

- **A file existing is NOT evidence it has correct content.** Verify content claims
  separately from existence claims.
- **Absence of evidence IS evidence of absence** for process steps. If the transcript
  does not show SKILL.md being read, the expectation fails.
- **Cite specific evidence.** Never mark PASS without pointing to a transcript line,
  tool call, or telemetry field.

---

## Claims Extraction

After grading explicit expectations, extract 2-4 implicit claims from the transcript.
Each claim falls into one of three types:

| Type        | What it captures                      | Example                                                  |
| ----------- | ------------------------------------- | -------------------------------------------------------- |
| **Factual** | A verifiable statement the agent made | "The agent said 12 slides were created"                  |
| **Process** | An observed behavior pattern          | "The agent read SKILL.md before making any file changes" |
| **Quality** | An output characteristic              | "The output file was named correctly"                    |

For each claim:

1. State the claim clearly
2. Classify its type
3. Mark `verified: true` or `verified: false`
4. Cite evidence (or note its absence)

---

## Eval Feedback and Eval Gap Flagging

After grading, review each PASSED expectation and ask:

> "Would this expectation also pass if the agent produced wrong output?"

If yes, flag it in `eval_feedback.suggestions` with a reason. This drives
eval set improvement over time.

### When to flag

- An expectation checks file existence but not content
- An expectation checks command success but not output correctness
- An expectation is too generic to catch quality regressions

### When NOT to flag

- The expectation is already specific enough
- The gap is trivial or not worth the eval set complexity

Only raise things worth improving. The goal is actionable feedback, not exhaustive nitpicking.

---

## grading.json Schema

```json
{
  "session_id": "abc123",
  "skill_name": "pptx",
  "transcript_path": "/home/user/.claude/projects/.../abc123.jsonl",
  "graded_at": "2026-02-28T12:00:00Z",
  "expectations": [
    {
      "text": "SKILL.md was read before any file was created",
      "passed": true,
      "evidence": "Transcript line 3: [TOOL:Read] /path/to/SKILL.md"
    },
    {
      "text": "Output file has correct slide count",
      "passed": false,
      "evidence": "Expected 12 slides, found 8 in bash output"
    }
  ],
  "summary": {
    "passed": 2,
    "failed": 1,
    "total": 3,
    "pass_rate": 0.67
  },
  "execution_metrics": {
    "tool_calls": { "Read": 2, "Write": 1, "Bash": 3 },
    "total_tool_calls": 6,
    "total_steps": 4,
    "bash_commands_run": 3,
    "errors_encountered": 0,
    "skills_triggered": ["pptx"],
    "transcript_chars": 4200
  },
  "claims": [
    {
      "claim": "Output was a .pptx file",
      "type": "factual",
      "verified": true,
      "evidence": "Bash output: 'presentation.pptx created'"
    }
  ],
  "eval_feedback": {
    "suggestions": [{ "reason": "No expectation checks slide content" }],
    "overall": "Process coverage good; add output quality assertions."
  }
}
```

### Field descriptions

| Field               | Type   | Description                                |
| ------------------- | ------ | ------------------------------------------ |
| `session_id`        | string | From session telemetry                     |
| `skill_name`        | string | The skill being graded                     |
| `transcript_path`   | string | Path to the session transcript JSONL       |
| `graded_at`         | string | ISO 8601 timestamp of grading              |
| `expectations[]`    | array  | Each expectation with verdict and evidence |
| `summary`           | object | Aggregate pass/fail counts and rate        |
| `execution_metrics` | object | Raw metrics from session telemetry         |
| `claims[]`          | array  | Implicit claims extracted from transcript  |
| `eval_feedback`     | object | Suggestions for improving the eval set     |
