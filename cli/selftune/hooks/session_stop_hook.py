#!/usr/bin/env python3
"""
Claude Code Stop hook: session_stop_hook.py

Fires when a Claude Code session ends. Reads the session's transcript JSONL
and extracts process-level telemetry:

  - Which skills were triggered (SKILL.md files read)
  - Tool call counts by type (Read, Write, Bash, Edit, ...)
  - Bash commands executed
  - Error count
  - Number of assistant turns
  - Token proxy (character count)

Appends one record per session to ~/.claude/session_telemetry_log.jsonl.

This is the "tier 2" data the trigger hooks don't capture: not just WHETHER
the skill fired, but WHAT HAPPENED during the session — inputs to the process
grader (grade_session.py) and efficiency tracking over time.

Installation: see settings_snippet.json
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


TELEMETRY_LOG = Path.home() / ".claude" / "session_telemetry_log.jsonl"

# Tool names Claude Code uses
KNOWN_TOOLS = {"Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep",
               "WebFetch", "WebSearch", "Task", "TodoRead", "TodoWrite"}


def parse_transcript(transcript_path: str) -> dict:
    """
    Parse a Claude Code transcript JSONL and extract process metrics.

    Claude Code transcripts contain one JSON object per line. The format
    has evolved across versions; this parser handles the observed variants:

      Variant A (newer):
        {"type": "user",      "message": {"role": "user",      "content": [...]}}
        {"type": "assistant", "message": {"role": "assistant", "content": [...]}}

      Variant B (older / direct):
        {"role": "user",      "content": "..."}
        {"role": "assistant", "content": [...]}

    Tool use appears in assistant content blocks:
        {"type": "tool_use", "name": "Read", "input": {"file_path": "..."}}

    Tool results appear either as separate entries or inside user messages:
        {"type": "tool_result", "is_error": true, ...}
    """
    path = Path(transcript_path)
    if not path.exists():
        return _empty_metrics()

    tool_calls: dict[str, int] = {}
    bash_commands: list[str] = []
    skills_triggered: list[str] = []
    errors: int = 0
    assistant_turns: int = 0
    total_chars: int = 0
    last_user_query: str = ""

    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    total_chars = sum(len(l) for l in lines)

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Normalise: unwrap nested message if present
        msg = entry.get("message", entry)
        role = msg.get("role", entry.get("role", ""))
        content = msg.get("content", entry.get("content", ""))

        # Track last user query
        if role == "user":
            if isinstance(content, str) and content.strip():
                last_user_query = content.strip()
            elif isinstance(content, list):
                texts = [
                    p.get("text", "") for p in content
                    if isinstance(p, dict) and p.get("type") == "text"
                ]
                text = " ".join(t for t in texts if t).strip()
                if text:
                    last_user_query = text

        # Count assistant turns and parse tool use
        if role == "assistant":
            assistant_turns += 1
            content_blocks = content if isinstance(content, list) else []
            for block in content_blocks:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    tool_name = block.get("name", "Unknown")
                    tool_calls[tool_name] = tool_calls.get(tool_name, 0) + 1
                    inp = block.get("input", {})

                    # Track SKILL.md reads
                    file_path = inp.get("file_path", "")
                    if Path(file_path).name.upper() == "SKILL.MD":
                        skill_name = Path(file_path).parent.name
                        if skill_name not in skills_triggered:
                            skills_triggered.append(skill_name)

                    # Track bash commands
                    if tool_name == "Bash":
                        cmd = inp.get("command", "").strip()
                        if cmd:
                            bash_commands.append(cmd)

        # Count tool errors from result entries
        entry_type = entry.get("type", "")
        if entry_type == "tool_result" and entry.get("is_error"):
            errors += 1
        # Also check inside user content (tool_result blocks)
        if role == "user" and isinstance(content, list):
            for block in content:
                if (isinstance(block, dict) and
                        block.get("type") == "tool_result" and
                        block.get("is_error")):
                    errors += 1

    return {
        "tool_calls": tool_calls,
        "total_tool_calls": sum(tool_calls.values()),
        "bash_commands": bash_commands,
        "skills_triggered": skills_triggered,
        "assistant_turns": assistant_turns,
        "errors_encountered": errors,
        "transcript_chars": total_chars,
        "last_user_query": last_user_query,
    }


def _empty_metrics() -> dict:
    return {
        "tool_calls": {},
        "total_tool_calls": 0,
        "bash_commands": [],
        "skills_triggered": [],
        "assistant_turns": 0,
        "errors_encountered": 0,
        "transcript_chars": 0,
        "last_user_query": "",
    }


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    session_id = payload.get("session_id", "unknown")
    transcript_path = payload.get("transcript_path", "")
    cwd = payload.get("cwd", "")

    metrics = parse_transcript(transcript_path)

    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "cwd": cwd,
        "transcript_path": transcript_path,
        **metrics,
    }

    TELEMETRY_LOG.parent.mkdir(parents=True, exist_ok=True)
    with TELEMETRY_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")

    sys.exit(0)


if __name__ == "__main__":
    main()
