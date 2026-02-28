#!/usr/bin/env python3
"""
adapters/codex_rollout_ingest.py

Retroactively ingests Codex's auto-written rollout logs into our shared
skill eval log format.

Codex CLI automatically saves every session to:
    $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<thread_id>.jsonl

(Default CODEX_HOME is ~/.codex)

This script scans those files and populates:
    ~/.claude/all_queries_log.jsonl
    ~/.claude/session_telemetry_log.jsonl
    ~/.claude/skill_usage_log.jsonl

It tracks which files have already been ingested in a marker file so
subsequent runs are incremental (idempotent).

Usage:
    # Ingest all historical Codex sessions:
    python3 codex_rollout_ingest.py

    # Ingest from a specific date onward:
    python3 codex_rollout_ingest.py --since 2026-01-01

    # Ingest from a custom CODEX_HOME:
    python3 codex_rollout_ingest.py --codex-home /custom/path

    # Dry run (show what would be ingested):
    python3 codex_rollout_ingest.py --dry-run

    # Re-ingest everything (ignore the already-ingested marker):
    python3 codex_rollout_ingest.py --force
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone, date
from pathlib import Path

QUERY_LOG = Path.home() / ".claude" / "all_queries_log.jsonl"
SKILL_LOG = Path.home() / ".claude" / "skill_usage_log.jsonl"
TELEMETRY_LOG = Path.home() / ".claude" / "session_telemetry_log.jsonl"
MARKER_FILE = Path.home() / ".claude" / "codex_ingested_rollouts.json"

DEFAULT_CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))

# Codex skills directories to look for SKILL.md files
CODEX_SKILLS_DIRS = [
    Path.cwd() / ".codex" / "skills",
    Path.home() / ".codex" / "skills",
]


def load_marker() -> set[str]:
    """Return set of already-ingested rollout file paths."""
    if MARKER_FILE.exists():
        try:
            return set(json.loads(MARKER_FILE.read_text()))
        except (json.JSONDecodeError, ValueError):
            pass
    return set()


def save_marker(ingested: set[str]):
    MARKER_FILE.parent.mkdir(parents=True, exist_ok=True)
    MARKER_FILE.write_text(json.dumps(sorted(ingested), indent=2))


def find_rollout_files(codex_home: Path, since: date | None = None) -> list[Path]:
    """
    Find all rollout-*.jsonl files under codex_home/sessions/YYYY/MM/DD/.
    If `since` is given, only return files from that date onward.
    """
    sessions_dir = codex_home / "sessions"
    if not sessions_dir.exists():
        return []

    files = []
    for year_dir in sorted(sessions_dir.iterdir()):
        if not year_dir.is_dir():
            continue
        try:
            year = int(year_dir.name)
        except ValueError:
            continue

        for month_dir in sorted(year_dir.iterdir()):
            if not month_dir.is_dir():
                continue
            try:
                month = int(month_dir.name)
            except ValueError:
                continue

            for day_dir in sorted(month_dir.iterdir()):
                if not day_dir.is_dir():
                    continue
                try:
                    day = int(day_dir.name)
                except ValueError:
                    continue

                if since and date(year, month, day) < since:
                    continue

                for f in sorted(day_dir.glob("rollout-*.jsonl")):
                    files.append(f)

    return files


def find_skill_names() -> set[str]:
    """Return skill names from Codex skill directories."""
    names = set()
    for d in CODEX_SKILLS_DIRS:
        if d.exists():
            for skill_dir in d.iterdir():
                if (skill_dir / "SKILL.md").exists():
                    names.add(skill_dir.name)
    return names


def parse_rollout_file(path: Path, skill_names: set[str]) -> dict | None:
    """
    Parse a Codex rollout JSONL file.
    Returns a dict with query, metrics, skills_triggered — or None if the
    file is empty or can't be parsed.
    """
    lines = []
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
        lines = [l.strip() for l in content.splitlines() if l.strip()]
    except OSError:
        return None

    if not lines:
        return None

    thread_id = path.stem.replace("rollout-", "")
    prompt = ""
    tool_calls: dict[str, int] = {}
    bash_commands: list[str] = []
    skills_triggered: list[str] = []
    errors = 0
    turns = 0
    input_tokens = 0
    output_tokens = 0

    for line in lines:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        etype = event.get("type", "")

        if etype == "turn.started":
            turns += 1

        elif etype == "turn.completed":
            usage = event.get("usage", {})
            input_tokens += usage.get("input_tokens", 0)
            output_tokens += usage.get("output_tokens", 0)

            # The user message is often in turn.started or as the first item
            # Some rollout formats include it here
            if not prompt:
                prompt = event.get("user_message", "")

        elif etype == "turn.failed":
            errors += 1

        elif etype in ("item.completed", "item.started", "item.updated"):
            item = event.get("item", {})
            item_type = item.get("item_type", item.get("type", ""))

            # Count only on completion
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
                    tool_calls["mcp_tool_call"] = tool_calls.get("mcp_tool_call", 0) + 1

                elif item_type == "web_search":
                    tool_calls["web_search"] = tool_calls.get("web_search", 0) + 1

                elif item_type == "reasoning":
                    tool_calls["reasoning"] = tool_calls.get("reasoning", 0) + 1

            # Detect skill names in any text content
            text_content = item.get("text", "") + item.get("command", "")
            for skill_name in skill_names:
                if (skill_name in text_content and
                        skill_name not in skills_triggered and
                        etype == "item.completed"):
                    skills_triggered.append(skill_name)

        elif etype == "error":
            errors += 1

        # Some rollout formats embed the original prompt
        if not prompt and event.get("prompt"):
            prompt = event["prompt"]

    # Infer file date from path structure YYYY/MM/DD
    parts = path.parts
    try:
        day_idx = parts.index(parts[-2])  # day dir
        day = int(parts[-2])
        month = int(parts[-3])
        year = int(parts[-4])
        file_date = datetime(year, month, day, tzinfo=timezone.utc).isoformat()
    except (ValueError, IndexError):
        file_date = datetime.now(timezone.utc).isoformat()

    return {
        "timestamp": file_date,
        "session_id": thread_id,
        "source": "codex_rollout",
        "rollout_path": str(path),
        "query": prompt,
        "tool_calls": tool_calls,
        "total_tool_calls": sum(tool_calls.values()),
        "bash_commands": bash_commands,
        "skills_triggered": skills_triggered,
        "assistant_turns": turns,
        "errors_encountered": errors,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "transcript_chars": sum(len(l) for l in lines),
        "cwd": "",
        "transcript_path": str(path),
        "last_user_query": prompt,
    }


def ingest_file(parsed: dict, dry_run: bool = False) -> bool:
    """Write parsed session data to our shared logs. Returns True if ingested."""
    prompt = parsed.get("query", "")
    session_id = parsed.get("session_id", "unknown")
    skills = parsed.get("skills_triggered", [])

    if dry_run:
        print(f"  [DRY RUN] Would ingest: session={session_id[:12]}... "
              f"turns={parsed.get('assistant_turns', 0)} "
              f"commands={len(parsed.get('bash_commands', []))} "
              f"skills={skills}")
        if prompt:
            print(f"           query: {prompt[:80]}")
        return True

    for log_path in [QUERY_LOG, SKILL_LOG, TELEMETRY_LOG]:
        log_path.parent.mkdir(parents=True, exist_ok=True)

    # Write to all_queries_log if we have a prompt
    if prompt and len(prompt) >= 4:
        query_record = {
            "timestamp": parsed["timestamp"],
            "session_id": session_id,
            "query": prompt,
            "source": "codex_rollout",
        }
        with QUERY_LOG.open("a") as f:
            f.write(json.dumps(query_record) + "\n")

    # Write telemetry
    telemetry_record = {k: v for k, v in parsed.items() if k != "query"}
    with TELEMETRY_LOG.open("a") as f:
        f.write(json.dumps(telemetry_record) + "\n")

    # Write skill triggers
    for skill_name in skills:
        skill_record = {
            "timestamp": parsed["timestamp"],
            "session_id": session_id,
            "skill_name": skill_name,
            "skill_path": f"(codex:{skill_name})",
            "query": prompt,
            "triggered": True,
            "source": "codex_rollout",
        }
        with SKILL_LOG.open("a") as f:
            f.write(json.dumps(skill_record) + "\n")

    return True


def main():
    parser = argparse.ArgumentParser(
        description="Ingest Codex rollout logs into skill eval log format"
    )
    parser.add_argument("--codex-home", default=str(DEFAULT_CODEX_HOME),
                        help=f"CODEX_HOME directory (default: {DEFAULT_CODEX_HOME})")
    parser.add_argument("--since", default=None,
                        help="Only ingest sessions from this date onward (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be ingested without writing logs")
    parser.add_argument("--force", action="store_true",
                        help="Re-ingest all files, ignoring the already-ingested marker")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    codex_home = Path(args.codex_home)
    since = datetime.strptime(args.since, "%Y-%m-%d").date() if args.since else None

    rollout_files = find_rollout_files(codex_home, since)
    if not rollout_files:
        print(f"No rollout files found under {codex_home}/sessions/")
        print("Make sure CODEX_HOME is correct and you've run some `codex exec` sessions.")
        sys.exit(0)

    already_ingested = set() if args.force else load_marker()
    skill_names = find_skill_names()
    new_ingested: set[str] = set()

    pending = [f for f in rollout_files if str(f) not in already_ingested]
    print(f"Found {len(rollout_files)} rollout files, "
          f"{len(pending)} not yet ingested.")

    if since:
        print(f"  Filtering to sessions from {since} onward.")

    ingested_count = 0
    skipped_count = 0

    for rollout_file in pending:
        parsed = parse_rollout_file(rollout_file, skill_names)
        if parsed is None:
            if args.verbose:
                print(f"  SKIP (empty/unparseable): {rollout_file.name}")
            skipped_count += 1
            continue

        if args.verbose or args.dry_run:
            print(f"  {'[DRY] ' if args.dry_run else ''}Ingesting: {rollout_file.name}")

        ingest_file(parsed, dry_run=args.dry_run)
        new_ingested.add(str(rollout_file))
        ingested_count += 1

    if not args.dry_run:
        save_marker(already_ingested | new_ingested)

    print(f"\nDone. Ingested {ingested_count} sessions, skipped {skipped_count}.")
    if new_ingested and not args.dry_run:
        print(f"Marker updated: {MARKER_FILE}")
        print("\nNext: run hooks_to_evals.py --list-skills to see what's available.")


if __name__ == "__main__":
    main()
