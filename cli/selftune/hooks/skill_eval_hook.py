#!/usr/bin/env python3
"""
Claude Code PostToolUse hook: skill_eval_hook.py

Fires whenever Claude reads a file. If that file is a SKILL.md, this hook:
  1. Finds the triggering user query from the transcript JSONL
  2. Appends a usage record to ~/.claude/skill_usage_log.jsonl

This builds a real-usage eval dataset over time, seeding the
`should_trigger: true` half of trigger evals for use with run_eval.py.

Installation: see settings_snippet.json
"""

import json
import sys
import os
from datetime import datetime, timezone
from pathlib import Path


LOG_PATH = Path.home() / ".claude" / "skill_usage_log.jsonl"


def get_last_user_message(transcript_path: str) -> str | None:
    """
    Walk the transcript JSONL backwards to find the most recent user message.
    Transcript lines are JSON objects; user turns have role="user".
    """
    try:
        path = Path(transcript_path)
        if not path.exists():
            return None

        lines = path.read_text(encoding="utf-8").strip().splitlines()

        for line in reversed(lines):
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Claude Code transcript format: entries with "type": "user" or
            # entries with a "message" key containing role/content
            # Handle both observed formats.

            # Format 1: top-level role field
            if entry.get("role") == "user":
                content = entry.get("content", "")
                if isinstance(content, str) and content.strip():
                    return content.strip()
                if isinstance(content, list):
                    # Extract text parts
                    texts = [
                        p.get("text", "") for p in content
                        if isinstance(p, dict) and p.get("type") == "text"
                    ]
                    combined = " ".join(t for t in texts if t).strip()
                    if combined:
                        return combined

            # Format 2: nested message object
            msg = entry.get("message", {})
            if isinstance(msg, dict) and msg.get("role") == "user":
                content = msg.get("content", "")
                if isinstance(content, str) and content.strip():
                    return content.strip()
                if isinstance(content, list):
                    texts = [
                        p.get("text", "") for p in content
                        if isinstance(p, dict) and p.get("type") == "text"
                    ]
                    combined = " ".join(t for t in texts if t).strip()
                    if combined:
                        return combined

    except Exception:
        pass

    return None


def extract_skill_name(file_path: str) -> str | None:
    """
    Given a path like /mnt/skills/public/pptx/SKILL.md,
    return the skill folder name ('pptx').
    Returns None if this doesn't look like a skill file.
    """
    p = Path(file_path)

    # Must end in SKILL.md (case-insensitive)
    if p.name.upper() != "SKILL.MD":
        return None

    # Return the immediate parent directory name as the skill name
    return p.parent.name or "unknown"


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    # Only care about Read tool
    if payload.get("tool_name") != "Read":
        sys.exit(0)

    file_path = payload.get("tool_input", {}).get("file_path", "")
    skill_name = extract_skill_name(file_path)

    if skill_name is None:
        sys.exit(0)  # Not a skill read, ignore

    transcript_path = payload.get("transcript_path", "")
    session_id = payload.get("session_id", "unknown")

    query = get_last_user_message(transcript_path) or "(query not found)"

    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "skill_name": skill_name,
        "skill_path": file_path,
        "query": query,
        "triggered": True,
    }

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")

    # Exit 0: allow, don't surface anything to user
    sys.exit(0)


if __name__ == "__main__":
    main()
