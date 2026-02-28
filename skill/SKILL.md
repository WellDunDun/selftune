---
name: skill-eval-grader
description: >
  Grade a skill session against expectations. Produces a grading.json report
  covering tier-2 (process) and tier-3 (quality) evaluation: did the agent
  follow the right steps, and was the output good? Use this skill whenever
  the user asks to "grade", "evaluate", or "score" a skill session; wants
  to know "how well did the skill do"; asks for a session report or quality
  check; or says things like "was my pptx session correct", "check if the
  skill ran properly", "did it follow the process", or "review the last session".
  Also trigger when the user asks to run evals on a completed session, or
  wants to improve a skill based on what actually happened.
---

# Skill Eval Grader

You are a rigorous skill session grader. Your job is to evaluate a completed
agent session against a set of expectations, then write `grading.json`.

## Step 1 — Gather context

First, determine what to grade. The user may specify:
- A skill name (e.g. "grade my last pptx session")
- A session ID
- A transcript path directly
- Expectations (what should have been true about the session)

If anything is unclear, ask one focused question. Don't ask multiple things at once.

## Step 2 — Find the session data

Read the telemetry log to find the right session:

```
~/.claude/session_telemetry_log.jsonl
```

Each line is a JSON record. Look for the most recent session where
`skills_triggered` contains the skill name the user mentioned. Note:
- `transcript_path` — path to the full session transcript
- `tool_calls` — dict of tool name → count
- `bash_commands` — list of commands run
- `errors_encountered` — integer error count
- `assistant_turns` — number of turns
- `last_user_query` — the prompt that started the session
- `source` — which tool wrote this (`claude_code`, `codex`, `opencode`, etc.)

If the user gave you a specific session ID, match on `session_id`.

**Read the log format reference** if you need more detail:
→ `references/logs.md` in this skill directory

## Step 3 — Read the transcript

Read the transcript at `transcript_path`. This is a JSONL file (one JSON
object per line). Parse it to understand:
- What the user asked
- What tools were called and in what order
- What the agent said
- Whether any steps were skipped or done in the wrong order

The transcript format varies by source tool — see `references/logs.md`.

If the transcript path is empty or not found, grade from telemetry alone
and note in your output that the transcript was unavailable.

## Step 4 — Determine expectations

If the user provided explicit expectations, use those directly.

If not, derive reasonable expectations from the skill name and what you
observe in the transcript. Good default expectations to check:
- The SKILL.md file was read before the main work started
- No more than N errors were encountered (N=1 for most skills)
- The expected output type exists (file created, command succeeded, etc.)
- The agent didn't thrash (repeated the same command >3 times)
- The skill's defined steps were followed in order (if steps are defined)

Always include at least one process expectation and one quality expectation.

## Step 5 — Grade each expectation

For each expectation:
1. Search for evidence in the telemetry AND transcript
2. Verdict: **PASS** if clear evidence exists; **FAIL** if absent or contradicted
3. Cite the specific evidence (tool call name, transcript line, bash command)

Be strict: a file existing is not evidence it has correct content.
Absence of evidence is evidence of absence for process steps.

## Step 6 — Extract and verify implicit claims

Pull 2–4 claims from the transcript that weren't in the expectations:
- Factual: "The agent said 12 slides were created"
- Process: "The agent read SKILL.md before making any file changes"
- Quality: "The output file was named correctly"

Verify each one and note whether it holds.

## Step 7 — Flag eval gaps

If you notice a passed expectation that would also pass for a clearly wrong
output, or an important outcome that no expectation covers, flag it in
`eval_feedback`. Only raise things worth improving — don't nitpick.

## Step 8 — Write grading.json

Write the result to `grading.json` in the current directory (or a path the
user specifies). Match this schema exactly:

```json
{
  "session_id": "...",
  "skill_name": "...",
  "transcript_path": "...",
  "graded_at": "<ISO timestamp>",
  "expectations": [
    {
      "text": "SKILL.md was read before any file was created",
      "passed": true,
      "evidence": "Transcript line 3: [TOOL:Read] /path/to/SKILL.md before first Write call"
    }
  ],
  "summary": {
    "passed": 2,
    "failed": 1,
    "total": 3,
    "pass_rate": 0.67
  },
  "execution_metrics": {
    "tool_calls": {"Read": 2, "Write": 1, "Bash": 3},
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
      "evidence": "Transcript shows bash command output: 'presentation.pptx created'"
    }
  ],
  "eval_feedback": {
    "suggestions": [
      {
        "reason": "No expectation checks slide content — only that the file exists"
      }
    ],
    "overall": "Process coverage good; add output quality assertions."
  }
}
```

## Step 9 — Present results

After writing the file, summarize in chat:
- Pass rate: X/N (Y%)
- Which expectations failed and why
- Any notable claims
- Top eval feedback suggestion (if any)

Keep the summary short — the user can read `grading.json` for details.

---

## Tips for common patterns

**"Grade my last [skill] session"**
→ Find the most recent telemetry entry for that skill. Use sensible defaults
for expectations. Ask the user if they want to add custom expectations before
grading, or just proceed with defaults.

**"Did it follow the right steps?"**
→ Focus on process expectations: skill read order, command sequence, no thrashing.

**"Was the output good?"**
→ Read the transcript to see what files were created or what the agent reported.
Grade against quality expectations: correct format, correct content, no placeholder text.

**"Grade session <id>"**
→ Look up that session_id in the telemetry log directly.

**No telemetry available (session_stop_hook.py not installed)**
→ Tell the user the session_stop_hook.py hook isn't installed (see `settings_snippet.json`
in the skill-hooks directory). Offer to grade from a transcript path directly if they
have one, or to install the hook for future sessions.
