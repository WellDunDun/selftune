#!/usr/bin/env python3
"""
grade_session.py

Rubric-based grader for Claude Code skill sessions.

TWO MODES:

  1. --use-agent (default when no ANTHROPIC_API_KEY is set)
     Invokes the agent you already have installed — claude, codex, or opencode —
     so grading uses your existing subscription, not a separate API key.
     Auto-detects which agent is available.

  2. Direct API (default when ANTHROPIC_API_KEY is set)
     Calls the Anthropic API directly. Useful in CI/CD where no agent CLI
     is available.

Usage:
  # Grade using your existing Claude Code / Codex / OpenCode subscription:
  python grade_session.py --skill pptx \\
      --expectations "SKILL.md was read before any files were created" \\
                     "Output is a .pptx file"

  # Force agent mode, specify which tool:
  python grade_session.py --skill pptx --use-agent --agent claude \\
      --expectations "..."

  # Use agent mode with codex:
  python grade_session.py --skill pptx --use-agent --agent codex \\
      --expectations "..."

  # Force direct API (requires ANTHROPIC_API_KEY):
  python grade_session.py --skill pptx --use-api \\
      --expectations "..."

  # Grade a specific session:
  python grade_session.py --skill pptx --session-id abc123 \\
      --expectations "..."

  # Grade using expectations from evals.json:
  python grade_session.py --skill pptx --evals-json /path/to/evals.json \\
      --eval-id 1

  # Grade a transcript directly:
  python grade_session.py --transcript /path/to/transcript.jsonl \\
      --skill pptx --expectations "..."

Output: grading.json matching the skill-creator schema (schemas.md)
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

TELEMETRY_LOG = Path.home() / ".claude" / "session_telemetry_log.jsonl"
SKILL_LOG = Path.home() / ".claude" / "skill_usage_log.jsonl"

API_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-4-20250514"

# Agent CLI detection order
AGENT_CANDIDATES = ["claude", "codex", "opencode"]


# ---------------------------------------------------------------------------
# Agent detection
# ---------------------------------------------------------------------------

def detect_agent() -> str | None:
    """Return the first available agent CLI, or None."""
    for agent in AGENT_CANDIDATES:
        if shutil.which(agent):
            return agent
    return None


def agent_supports_headless(agent: str) -> bool:
    """All three support non-interactive mode, but invocation differs."""
    return agent in ("claude", "codex", "opencode")


# ---------------------------------------------------------------------------
# Data loading (shared with API mode)
# ---------------------------------------------------------------------------

def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    records = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return records


def find_session(records: list[dict], session_id: str) -> dict | None:
    for r in reversed(records):
        if r.get("session_id") == session_id:
            return r
    return None


def latest_session_for_skill(telemetry: list[dict], skill_name: str) -> dict | None:
    for r in reversed(telemetry):
        if skill_name in r.get("skills_triggered", []):
            return r
    return None


def read_transcript_excerpt(transcript_path: str, max_chars: int = 8000) -> str:
    """Parse transcript JSONL into a readable summary for the grader."""
    path = Path(transcript_path)
    if not path.exists():
        return "(transcript not found)"

    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.strip().splitlines()
    readable: list[str] = []

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        msg = entry.get("message", entry)
        role = msg.get("role", entry.get("role", ""))
        content = msg.get("content", entry.get("content", ""))

        if role == "user":
            if isinstance(content, str):
                readable.append(f"[USER] {content[:200]}")
            elif isinstance(content, list):
                texts = [p.get("text", "") for p in content
                         if isinstance(p, dict) and p.get("type") == "text"]
                text = " ".join(texts).strip()[:200]
                if text:
                    readable.append(f"[USER] {text}")

        elif role == "assistant":
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text":
                        readable.append(f"[ASSISTANT] {block.get('text', '')[:200]}")
                    elif block.get("type") == "tool_use":
                        name = block.get("name", "?")
                        inp = block.get("input", {})
                        detail = (inp.get("file_path") or inp.get("command") or
                                  inp.get("query") or str(inp)[:100])
                        readable.append(f"[TOOL:{name}] {detail}")

    full = "\n".join(readable)
    if len(full) <= max_chars:
        return full
    head = int(max_chars * 0.6)
    tail = max_chars - head
    return full[:head] + "\n\n... [truncated] ...\n\n" + full[-tail:]


def load_expectations_from_evals_json(evals_json_path: str, eval_id: int) -> list[str]:
    data = json.loads(Path(evals_json_path).read_text())
    for ev in data.get("evals", []):
        if ev.get("id") == eval_id:
            return ev.get("expectations", [])
    raise ValueError(f"Eval ID {eval_id} not found in {evals_json_path}")


def build_execution_metrics(telemetry: dict) -> dict:
    return {
        "tool_calls": telemetry.get("tool_calls", {}),
        "total_tool_calls": telemetry.get("total_tool_calls", 0),
        "total_steps": telemetry.get("assistant_turns", 0),
        "bash_commands_run": len(telemetry.get("bash_commands", [])),
        "errors_encountered": telemetry.get("errors_encountered", 0),
        "skills_triggered": telemetry.get("skills_triggered", []),
        "transcript_chars": telemetry.get("transcript_chars", 0),
    }


# ---------------------------------------------------------------------------
# Build the grading prompt (shared by both modes)
# ---------------------------------------------------------------------------

GRADER_SYSTEM = """You are a rigorous skill session evaluator. You receive:
1. Expectations to grade (things that should be true)
2. Process telemetry: tool calls, bash commands, skills triggered, errors
3. A transcript excerpt showing what happened

Grade each expectation and output ONLY valid JSON matching this schema:
{
  "expectations": [
    {"text": "...", "passed": true/false, "evidence": "specific quote or metric"}
  ],
  "summary": {"passed": N, "failed": N, "total": N, "pass_rate": 0.0},
  "claims": [
    {"claim": "...", "type": "factual|process|quality", "verified": true/false, "evidence": "..."}
  ],
  "eval_feedback": {
    "suggestions": [{"assertion": "...", "reason": "..."}],
    "overall": "one sentence"
  }
}

Rules:
- PASS only when there is clear, specific evidence — not assumptions
- FAIL when evidence is absent or contradictory
- Cite exact quotes or specific metric values
- Extract 2-4 implicit claims from the transcript and verify them
- Suggest eval improvements only for clear gaps"""


def build_grading_prompt(expectations: list[str], telemetry: dict,
                          transcript_excerpt: str, skill_name: str) -> str:
    tool_summary = json.dumps(telemetry.get("tool_calls", {}), indent=2)
    commands = telemetry.get("bash_commands", [])
    cmd_summary = "\n".join(f"  $ {c[:120]}" for c in commands[:20]) or "  (none)"

    return f"""Skill: {skill_name}

=== PROCESS TELEMETRY ===
Skills triggered: {telemetry.get("skills_triggered", [])}
Assistant turns: {telemetry.get("assistant_turns", "?")}
Errors: {telemetry.get("errors_encountered", "?")}
Total tool calls: {telemetry.get("total_tool_calls", "?")}

Tool breakdown:
{tool_summary}

Bash commands:
{cmd_summary}

=== TRANSCRIPT EXCERPT ===
{transcript_excerpt}

=== EXPECTATIONS ===
{chr(10).join(f"{i+1}. {e}" for i, e in enumerate(expectations))}

Grade each expectation. Output JSON only."""


# ---------------------------------------------------------------------------
# Mode 1: Agent subprocess
# ---------------------------------------------------------------------------

def grade_via_agent(prompt: str, agent: str) -> dict:
    """
    Call the installed agent CLI with the grading prompt.
    Returns the parsed grading result dict.
    """
    # Write prompt to a temp file (avoids shell quoting issues)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt",
                                     delete=False, encoding="utf-8") as f:
        f.write(GRADER_SYSTEM + "\n\n" + prompt)
        prompt_file = f.name

    try:
        if agent == "claude":
            # claude -p reads from stdin or accepts a prompt argument
            cmd = ["claude", "-p", f"@{prompt_file}"]
            # Fallback if @file syntax not supported: pipe via stdin
            result = subprocess.run(
                ["claude", "-p", open(prompt_file).read()],
                capture_output=True, text=True, timeout=120,
                env={**os.environ, "CLAUDECODE": ""}  # allow nesting
            )

        elif agent == "codex":
            # codex exec in a temp git-init'd dir (codex requires a git repo)
            with tempfile.TemporaryDirectory() as tmpdir:
                subprocess.run(["git", "init"], cwd=tmpdir,
                               capture_output=True)
                result = subprocess.run(
                    ["codex", "exec", "--skip-git-repo-check",
                     open(prompt_file).read()],
                    capture_output=True, text=True, timeout=120,
                    cwd=tmpdir
                )

        elif agent == "opencode":
            result = subprocess.run(
                ["opencode", "-p", open(prompt_file).read(), "-f", "text", "-q"],
                capture_output=True, text=True, timeout=120
            )

        else:
            raise ValueError(f"Unknown agent: {agent}")

    finally:
        Path(prompt_file).unlink(missing_ok=True)

    if result.returncode != 0:
        raise RuntimeError(
            f"Agent '{agent}' exited with code {result.returncode}.\n"
            f"stderr: {result.stderr[:500]}"
        )

    raw = result.stdout.strip()

    # Strip markdown fences
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
    raw = raw.strip()

    # Find first { in case there's preamble text
    brace_idx = raw.find("{")
    if brace_idx > 0:
        raw = raw[brace_idx:]

    return json.loads(raw)


# ---------------------------------------------------------------------------
# Mode 2: Direct Anthropic API
# ---------------------------------------------------------------------------

def grade_via_api(prompt: str) -> dict:
    """Call the Anthropic API directly. Requires ANTHROPIC_API_KEY."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY not set. Use --use-agent to grade via your "
            "installed Claude Code / Codex / OpenCode subscription instead."
        )

    payload = {
        "model": MODEL,
        "max_tokens": 2000,
        "system": GRADER_SYSTEM,
        "messages": [{"role": "user", "content": prompt}],
    }

    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"API error {e.code}: {body}")

    raw = ""
    for block in data.get("content", []):
        if block.get("type") == "text":
            raw += block.get("text", "")

    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
    raw = raw.strip()

    return json.loads(raw)


# ---------------------------------------------------------------------------
# Result assembly and output
# ---------------------------------------------------------------------------

def assemble_result(grader_output: dict, telemetry: dict, session_id: str,
                    skill_name: str, transcript_path: str) -> dict:
    return {
        "session_id": session_id,
        "skill_name": skill_name,
        "transcript_path": transcript_path,
        "graded_at": datetime.now(timezone.utc).isoformat(),
        "expectations": grader_output.get("expectations", []),
        "summary": grader_output.get("summary", {}),
        "execution_metrics": build_execution_metrics(telemetry),
        "claims": grader_output.get("claims", []),
        "eval_feedback": grader_output.get("eval_feedback",
                                            {"suggestions": [], "overall": ""}),
    }


def print_summary(result: dict):
    summary = result.get("summary", {})
    passed = summary.get("passed", "?")
    total = summary.get("total", "?")
    rate = summary.get("pass_rate", 0)
    print(f"\nResults: {passed}/{total} passed ({rate:.0%})")
    for exp in result.get("expectations", []):
        icon = "✓" if exp.get("passed") else "✗"
        print(f"  {icon} {exp.get('text', '')[:70]}")
        if not exp.get("passed"):
            print(f"      → {exp.get('evidence', '')[:100]}")

    feedback = result.get("eval_feedback", {})
    if feedback.get("suggestions"):
        print(f"\nEval feedback: {feedback.get('overall', '')}")
        for s in feedback["suggestions"]:
            print(f"  • {s.get('reason', '')[:100]}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Rubric-grade a skill session. Uses your agent subscription by default."
    )
    parser.add_argument("--skill", required=True, help="Skill name (e.g. 'pptx')")
    parser.add_argument("--expectations", nargs="+",
                        help="Expectation strings to grade")
    parser.add_argument("--evals-json",
                        help="Path to evals.json (use with --eval-id)")
    parser.add_argument("--eval-id", type=int,
                        help="Eval ID to pull expectations from evals.json")
    parser.add_argument("--session-id",
                        help="Specific session ID to grade")
    parser.add_argument("--transcript",
                        help="Direct path to a transcript JSONL file")
    parser.add_argument("--telemetry-log", default=str(TELEMETRY_LOG))
    parser.add_argument("--output", default="grading.json")

    # Mode selection
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument("--use-agent", action="store_true",
                            help="Grade via installed agent CLI (no API key needed)")
    mode_group.add_argument("--use-api", action="store_true",
                            help="Grade via direct Anthropic API (requires ANTHROPIC_API_KEY)")
    parser.add_argument("--agent",
                        choices=["claude", "codex", "opencode"],
                        help="Which agent to use (default: auto-detect)")
    parser.add_argument("--show-transcript", action="store_true")
    args = parser.parse_args()

    # --- Determine mode ---
    has_api_key = bool(os.environ.get("ANTHROPIC_API_KEY"))

    if args.use_api:
        mode = "api"
    elif args.use_agent:
        mode = "agent"
    else:
        # Default: use agent if available, fall back to API
        available_agent = detect_agent()
        if available_agent:
            mode = "agent"
        elif has_api_key:
            mode = "api"
        else:
            print(
                "[ERROR] No agent CLI (claude/codex/opencode) found in PATH "
                "and ANTHROPIC_API_KEY not set.\n"
                "Install Claude Code, Codex, or OpenCode, or set ANTHROPIC_API_KEY.",
                file=sys.stderr
            )
            sys.exit(1)

    if mode == "agent":
        agent = args.agent or detect_agent()
        if not agent:
            print(
                "[ERROR] --use-agent specified but no agent found in PATH.\n"
                "Install claude, codex, or opencode, or use --use-api instead.",
                file=sys.stderr
            )
            sys.exit(1)
        print(f"[INFO] Grading via agent: {agent}", file=sys.stderr)
    else:
        agent = None
        print("[INFO] Grading via direct Anthropic API", file=sys.stderr)

    # --- Resolve expectations ---
    expectations: list[str] = []
    if args.evals_json and args.eval_id is not None:
        expectations = load_expectations_from_evals_json(args.evals_json, args.eval_id)
    elif args.expectations:
        expectations = args.expectations
    else:
        print("[ERROR] Provide --expectations or --evals-json + --eval-id",
              file=sys.stderr)
        sys.exit(1)

    # --- Resolve session ---
    telemetry: dict = {}
    transcript_path = ""
    session_id = "unknown"

    if args.transcript:
        transcript_path = args.transcript
        tel_records = load_jsonl(Path(args.telemetry_log))
        for r in reversed(tel_records):
            if r.get("transcript_path") == transcript_path:
                telemetry = r
                session_id = r.get("session_id", "unknown")
                break
    elif args.session_id:
        session_id = args.session_id
        tel_records = load_jsonl(Path(args.telemetry_log))
        telemetry = find_session(tel_records, session_id) or {}
        transcript_path = telemetry.get("transcript_path", "")
    else:
        tel_records = load_jsonl(Path(args.telemetry_log))
        telemetry = latest_session_for_skill(tel_records, args.skill) or {}
        if telemetry:
            session_id = telemetry.get("session_id", "unknown")
            transcript_path = telemetry.get("transcript_path", "")
            print(f"[INFO] Grading most recent '{args.skill}' session: {session_id}",
                  file=sys.stderr)
        else:
            print(f"[WARN] No telemetry for skill '{args.skill}'. "
                  "Is session_stop_hook.py installed?", file=sys.stderr)

    transcript_excerpt = (read_transcript_excerpt(transcript_path)
                          if transcript_path else "(no transcript)")

    if args.show_transcript:
        print("=== TRANSCRIPT EXCERPT ===")
        print(transcript_excerpt)
        print("==========================\n")

    # --- Build prompt and grade ---
    prompt = build_grading_prompt(expectations, telemetry, transcript_excerpt, args.skill)

    print(f"Grading {len(expectations)} expectations for skill '{args.skill}'...",
          file=sys.stderr)

    try:
        if mode == "agent":
            grader_output = grade_via_agent(prompt, agent)
        else:
            grader_output = grade_via_api(prompt)
    except (RuntimeError, json.JSONDecodeError) as e:
        print(f"[ERROR] Grading failed: {e}", file=sys.stderr)
        sys.exit(1)

    result = assemble_result(grader_output, telemetry, session_id,
                             args.skill, transcript_path)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print_summary(result)
    print(f"\nWrote {output_path}")


if __name__ == "__main__":
    main()
