#!/usr/bin/env python3
"""
adapters/codex_wrapper.py

Drop-in wrapper for `codex exec --json` that tees the JSONL event stream
into our shared skill eval log format.

Usage — replace:
    codex exec --json --full-auto "make me a slide deck"

With:
    python3 codex_wrapper.py --full-auto "make me a slide deck"

Or set as an alias:
    alias codex-eval='python3 /path/to/codex_wrapper.py'
    codex-eval --full-auto "make me a slide deck"

The wrapper:
  1. Runs `codex exec --json <your args>` as a subprocess
  2. Streams stdout (the JSONL events) through to your terminal in real time
  3. Parses events and writes to:
       ~/.claude/all_queries_log.jsonl    (the user prompt)
       ~/.claude/session_telemetry_log.jsonl  (process metrics)

These are the same files Claude Code hooks write to, so hooks_to_evals.py
and grade_session.py work identically across both tools.

Codex JSONL event schema (from codex exec --json docs):
  {"type": "thread.started", "thread_id": "..."}
  {"type": "turn.started"}
  {"type": "turn.completed", "usage": {"input_tokens": N, "output_tokens": N}}
  {"type": "turn.failed", "error": {...}}
  {"type": "item.started",   "item": {"id": "...", "item_type": "command_execution", "command": "...", ...}}
  {"type": "item.updated",   "item": {...}}
  {"type": "item.completed", "item": {"id": "...", "item_type": "agent_message", "text": "..."}}
  {"type": "error", ...}

Item types: agent_message, reasoning, command_execution, file_change,
            mcp_tool_call, web_search, todo_list, error
"""

import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

SKILL_LOG = Path.home() / ".claude" / "skill_usage_log.jsonl"
QUERY_LOG = Path.home() / ".claude" / "all_queries_log.jsonl"
TELEMETRY_LOG = Path.home() / ".claude" / "session_telemetry_log.jsonl"

# Skills directory (Codex looks here for SKILL.md files)
CODEX_SKILLS_DIRS = [
    Path.cwd() / ".codex" / "skills",
    Path.home() / ".codex" / "skills",
]


def find_codex_skill_names() -> set[str]:
    """Return the set of skill names installed in Codex skill directories."""
    names = set()
    for d in CODEX_SKILLS_DIRS:
        if d.exists():
            for skill_dir in d.iterdir():
                if (skill_dir / "SKILL.md").exists():
                    names.add(skill_dir.name)
    return names


def extract_prompt_from_args(args: list[str]) -> str:
    """
    Extract the user prompt from codex exec args.
    The prompt is the last positional argument (not a flag).
    """
    positional = [a for a in args if not a.startswith("-")]
    return positional[-1] if positional else ""


def parse_jsonl_stream(lines: list[str], skill_names: set[str]) -> dict:
    """
    Parse Codex JSONL event lines and extract telemetry.
    Returns a dict matching our session_telemetry_log schema.
    """
    thread_id = "unknown"
    tool_calls: dict[str, int] = {}
    bash_commands: list[str] = []
    skills_triggered: list[str] = []
    errors = 0
    turns = 0
    input_tokens = 0
    output_tokens = 0
    agent_messages: list[str] = []

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        etype = event.get("type", "")

        if etype == "thread.started":
            thread_id = event.get("thread_id", "unknown")

        elif etype == "turn.started":
            turns += 1

        elif etype == "turn.completed":
            usage = event.get("usage", {})
            input_tokens += usage.get("input_tokens", 0)
            output_tokens += usage.get("output_tokens", 0)

        elif etype == "turn.failed":
            errors += 1

        elif etype in ("item.completed", "item.started", "item.updated"):
            item = event.get("item", {})
            item_type = item.get("item_type", item.get("type", ""))

            # Only count tool calls once, on completion
            if etype == "item.completed":
                if item_type == "command_execution":
                    tool_calls["command_execution"] = tool_calls.get("command_execution", 0) + 1
                    cmd = item.get("command", "").strip()
                    if cmd:
                        bash_commands.append(cmd)
                    if item.get("exit_code", 0) != 0:
                        errors += 1

                elif item_type == "file_change":
                    tool_calls["file_change"] = tool_calls.get("file_change", 0) + 1

                elif item_type == "mcp_tool_call":
                    tool_name = item.get("tool", "unknown")
                    tool_calls[f"mcp:{tool_name}"] = tool_calls.get(f"mcp:{tool_name}", 0) + 1

                elif item_type == "web_search":
                    tool_calls["web_search"] = tool_calls.get("web_search", 0) + 1

                elif item_type == "agent_message":
                    text = item.get("text", "")
                    if text:
                        agent_messages.append(text[:500])

                elif item_type == "reasoning":
                    tool_calls["reasoning"] = tool_calls.get("reasoning", 0) + 1

            # Detect skill names in text on any event (reasoning fires on completed)
            text_content = item.get("text", "") + item.get("command", "")
            for skill_name in skill_names:
                if (skill_name in text_content and
                        skill_name not in skills_triggered and
                        etype == "item.completed"):
                    skills_triggered.append(skill_name)

        elif etype == "error":
            errors += 1

    return {
        "thread_id": thread_id,
        "tool_calls": tool_calls,
        "total_tool_calls": sum(tool_calls.values()),
        "bash_commands": bash_commands,
        "skills_triggered": skills_triggered,
        "assistant_turns": turns,
        "errors_encountered": errors,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "agent_summary": " | ".join(agent_messages[:3]),
        "transcript_chars": sum(len(l) for l in lines),
    }


def log_query(prompt: str, session_id: str):
    """Append the user prompt to all_queries_log.jsonl."""
    if not prompt or len(prompt) < 4:
        return
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "query": prompt,
        "source": "codex",
    }
    QUERY_LOG.parent.mkdir(parents=True, exist_ok=True)
    with QUERY_LOG.open("a") as f:
        f.write(json.dumps(record) + "\n")


def log_telemetry(metrics: dict, prompt: str, session_id: str, cwd: str):
    """Append session metrics to session_telemetry_log.jsonl."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "cwd": cwd,
        "transcript_path": "",  # Codex doesn't expose transcript path via wrapper
        "last_user_query": prompt,
        "source": "codex",
        **metrics,
    }
    with TELEMETRY_LOG.open("a") as f:
        f.write(json.dumps(record) + "\n")


def log_skill_trigger(skill_name: str, prompt: str, session_id: str):
    """Append a skill trigger to skill_usage_log.jsonl."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "skill_name": skill_name,
        "skill_path": f"(codex:{skill_name})",
        "query": prompt,
        "triggered": True,
        "source": "codex",
    }
    with SKILL_LOG.open("a") as f:
        f.write(json.dumps(record) + "\n")


def main():
    # Everything after script name goes to codex exec
    extra_args = sys.argv[1:]

    if not extra_args:
        print("Usage: codex_wrapper.py [codex exec flags] <prompt>", file=sys.stderr)
        print("  Wraps `codex exec --json` and logs skill eval telemetry.", file=sys.stderr)
        sys.exit(1)

    prompt = extract_prompt_from_args(extra_args)
    skill_names = find_codex_skill_names()
    cwd = str(Path.cwd())

    # Build the actual codex command — always add --json
    cmd = ["codex", "exec", "--json"] + extra_args

    # Remove duplicate --json if user already passed it
    cmd = [c for i, c in enumerate(cmd) if not (c == "--json" and i > 2)]
    cmd.insert(2, "--json")

    # Deduplicate while preserving order
    seen = set()
    deduped = []
    for c in cmd:
        if c not in seen or c not in ("--json",):
            deduped.append(c)
            seen.add(c)
    cmd = deduped

    collected_lines: list[str] = []
    thread_id = "unknown"
    lock = threading.Lock()

    def read_and_tee(process):
        """Read stdout, tee to our terminal and collect lines."""
        nonlocal thread_id
        for raw_line in process.stdout:
            line = raw_line.decode("utf-8", errors="replace")
            sys.stdout.write(line)
            sys.stdout.flush()
            with lock:
                collected_lines.append(line.strip())
            # Grab thread_id early for session_id
            try:
                ev = json.loads(line)
                if ev.get("type") == "thread.started":
                    thread_id = ev.get("thread_id", "unknown")
            except json.JSONDecodeError:
                pass

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,  # pass stderr through directly
        )

        reader = threading.Thread(target=read_and_tee, args=(process,))
        reader.start()
        reader.join()
        process.wait()

    except FileNotFoundError:
        print("[codex_wrapper] Error: `codex` not found in PATH. "
              "Is Codex CLI installed?", file=sys.stderr)
        sys.exit(1)

    session_id = thread_id  # Use Codex thread_id as our session_id

    # Parse and log
    with lock:
        lines_snapshot = list(collected_lines)

    metrics = parse_jsonl_stream(lines_snapshot, skill_names)
    actual_thread_id = metrics.pop("thread_id", thread_id)
    session_id = actual_thread_id if actual_thread_id != "unknown" else session_id

    QUERY_LOG.parent.mkdir(parents=True, exist_ok=True)
    SKILL_LOG.parent.mkdir(parents=True, exist_ok=True)
    TELEMETRY_LOG.parent.mkdir(parents=True, exist_ok=True)

    log_query(prompt, session_id)
    log_telemetry(metrics, prompt, session_id, cwd)

    for skill_name in metrics.get("skills_triggered", []):
        log_skill_trigger(skill_name, prompt, session_id)

    sys.exit(process.returncode)


if __name__ == "__main__":
    main()
