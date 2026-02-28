#!/usr/bin/env python3
"""
adapters/opencode_ingest.py

Ingests OpenCode session history from its SQLite database into our shared
skill eval log format.

OpenCode stores sessions in:
    ~/.local/share/opencode/opencode.db    (current, SQLite, from ~Feb 2026)

Older installations may still have JSON files at:
    ~/.local/share/opencode/storage/session/*.json

This script reads both, preferring the SQLite database if available.

Usage:
    # Ingest all sessions:
    python3 opencode_ingest.py

    # Ingest from a specific date onward:
    python3 opencode_ingest.py --since 2026-01-01

    # Ingest from a custom data directory:
    python3 opencode_ingest.py --data-dir /custom/path

    # Dry run:
    python3 opencode_ingest.py --dry-run

    # Re-ingest everything:
    python3 opencode_ingest.py --force

    # Inspect the database schema first:
    python3 opencode_ingest.py --show-schema

Output (same files as Claude Code and Codex adapters):
    ~/.claude/all_queries_log.jsonl
    ~/.claude/session_telemetry_log.jsonl
    ~/.claude/skill_usage_log.jsonl
"""

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

QUERY_LOG = Path.home() / ".claude" / "all_queries_log.jsonl"
SKILL_LOG = Path.home() / ".claude" / "skill_usage_log.jsonl"
TELEMETRY_LOG = Path.home() / ".claude" / "session_telemetry_log.jsonl"
MARKER_FILE = Path.home() / ".claude" / "opencode_ingested_sessions.json"

# OpenCode data directory (XDG_DATA_HOME / opencode)
XDG_DATA_HOME = Path(
    __import__("os").environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
)
DEFAULT_DATA_DIR = XDG_DATA_HOME / "opencode"

# OpenCode skill directories
OPENCODE_SKILLS_DIRS = [
    Path.cwd() / ".opencode" / "skills",
    Path.home() / ".config" / "opencode" / "skills",
]


def find_skill_names() -> set[str]:
    """Return skill names from OpenCode skill directories."""
    names = set()
    for d in OPENCODE_SKILLS_DIRS:
        if d.exists():
            for skill_dir in d.iterdir():
                if (skill_dir / "SKILL.md").exists():
                    names.add(skill_dir.name)
    return names


def load_marker() -> set[str]:
    if MARKER_FILE.exists():
        try:
            return set(json.loads(MARKER_FILE.read_text()))
        except (json.JSONDecodeError, ValueError):
            pass
    return set()


def save_marker(ingested: set[str]):
    MARKER_FILE.parent.mkdir(parents=True, exist_ok=True)
    MARKER_FILE.write_text(json.dumps(sorted(ingested), indent=2))


# ---------------------------------------------------------------------------
# SQLite reader
# ---------------------------------------------------------------------------

def get_db_schema(db_path: Path) -> str:
    """Return a human-readable schema summary for --show-schema."""
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = [row[0] for row in cursor.fetchall()]

    lines = []
    for table in tables:
        cursor.execute(f"PRAGMA table_info({table})")
        cols = cursor.fetchall()
        lines.append(f"\nTable: {table}")
        for col in cols:
            lines.append(f"  {col[1]:30s} {col[2]}")
    conn.close()
    return "\n".join(lines)


def read_sessions_from_sqlite(db_path: Path, since_ts: float | None,
                               skill_names: set[str]) -> list[dict]:
    """
    Read OpenCode sessions from SQLite.

    OpenCode's schema (as of Feb 2026, using Drizzle ORM):
      session table:  id, title, created, updated, ...
      message table:  id, session_id, role, content (JSON), created, ...

    Message content is JSON. Tool calls appear as content blocks with
    type "tool_use" (Anthropic format) or "tool_calls" (OpenAI format).
    """
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # Detect available tables
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = {row[0] for row in cursor.fetchall()}

    # Flexible column detection — OpenCode's schema has evolved
    sessions_table = next((t for t in tables if "session" in t.lower()), None)
    messages_table = next((t for t in tables if "message" in t.lower()), None)

    if not sessions_table or not messages_table:
        conn.close()
        print(f"[WARN] Could not find session/message tables in {db_path}")
        print(f"       Available tables: {sorted(tables)}")
        print("       Try --show-schema to inspect the database.")
        return []

    # Get sessions
    where_clause = ""
    if since_ts:
        where_clause = f"WHERE created > {int(since_ts * 1000)}"  # milliseconds

    try:
        cursor.execute(f"SELECT * FROM {sessions_table} {where_clause} ORDER BY created ASC")
        session_rows = cursor.fetchall()
    except sqlite3.OperationalError as e:
        print(f"[WARN] Could not query sessions: {e}")
        conn.close()
        return []

    parsed_sessions = []

    for session_row in session_rows:
        session_id = str(session_row["id"])
        created_ms = session_row["created"]
        timestamp = datetime.fromtimestamp(created_ms / 1000, tz=timezone.utc).isoformat()

        # Get messages for this session
        try:
            cursor.execute(
                f"SELECT * FROM {messages_table} WHERE session_id = ? ORDER BY created ASC",
                (session_row["id"],)
            )
            msg_rows = cursor.fetchall()
        except sqlite3.OperationalError:
            continue

        # Parse messages
        first_user_query = ""
        tool_calls: dict[str, int] = {}
        bash_commands: list[str] = []
        skills_triggered: list[str] = []
        errors = 0
        assistant_turns = 0

        for msg in msg_rows:
            role = msg["role"] if "role" in msg.keys() else ""
            raw_content = msg["content"] if "content" in msg.keys() else "[]"

            # Parse content (may be JSON string or plain text)
            try:
                content = json.loads(raw_content) if isinstance(raw_content, str) else raw_content
            except (json.JSONDecodeError, TypeError):
                content = [{"type": "text", "text": str(raw_content)}]

            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            if not isinstance(content, list):
                content = [content] if isinstance(content, dict) else []

            if role == "user":
                # Capture first non-tool-result user message as the query
                if not first_user_query:
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text = block.get("text", "").strip()
                            if text and len(text) >= 4:
                                first_user_query = text
                                break
                    if not first_user_query and isinstance(content, list):
                        # Fallback: join all text blocks
                        texts = [
                            b.get("text", "") for b in content
                            if isinstance(b, dict) and b.get("type") == "text"
                        ]
                        first_user_query = " ".join(t for t in texts if t).strip()

            elif role == "assistant":
                assistant_turns += 1
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    block_type = block.get("type", "")

                    # Anthropic tool use format
                    if block_type == "tool_use":
                        tool_name = block.get("name", "unknown")
                        tool_calls[tool_name] = tool_calls.get(tool_name, 0) + 1
                        inp = block.get("input", {})

                        if tool_name in ("Bash", "bash", "execute_bash"):
                            cmd = inp.get("command", inp.get("cmd", "")).strip()
                            if cmd:
                                bash_commands.append(cmd)

                        # Skill detection: file reads of SKILL.md
                        if tool_name in ("Read", "read_file"):
                            file_path = inp.get("file_path", inp.get("path", ""))
                            if Path(file_path).name.upper() == "SKILL.MD":
                                skill_name = Path(file_path).parent.name
                                if skill_name not in skills_triggered:
                                    skills_triggered.append(skill_name)

                    # OpenAI tool calls format
                    elif block_type == "tool_calls":
                        for tc in block.get("tool_calls", []):
                            fn = tc.get("function", {})
                            tool_name = fn.get("name", "unknown")
                            tool_calls[tool_name] = tool_calls.get(tool_name, 0) + 1

                    # Check text content for skill name mentions
                    text_content = block.get("text", "")
                    for skill_name in skill_names:
                        if skill_name in text_content and skill_name not in skills_triggered:
                            skills_triggered.append(skill_name)

            # Count errors from tool_result blocks
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    if block.get("is_error") or block.get("error"):
                        errors += 1

        parsed_sessions.append({
            "timestamp": timestamp,
            "session_id": session_id,
            "source": "opencode",
            "transcript_path": str(db_path),
            "cwd": "",
            "last_user_query": first_user_query,
            "query": first_user_query,
            "tool_calls": tool_calls,
            "total_tool_calls": sum(tool_calls.values()),
            "bash_commands": bash_commands,
            "skills_triggered": skills_triggered,
            "assistant_turns": assistant_turns,
            "errors_encountered": errors,
            "transcript_chars": 0,
        })

    conn.close()
    return parsed_sessions


# ---------------------------------------------------------------------------
# JSON file reader (legacy OpenCode format)
# ---------------------------------------------------------------------------

def read_sessions_from_json_files(storage_dir: Path, since_ts: float | None,
                                   skill_names: set[str]) -> list[dict]:
    """
    Read OpenCode sessions from legacy JSON files at:
        ~/.local/share/opencode/storage/session/*.json
    """
    session_dir = storage_dir / "session"
    if not session_dir.exists():
        return []

    sessions = []
    for json_file in sorted(session_dir.glob("*.json")):
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        # JSON sessions have varying formats; try to normalize
        session_id = data.get("id", json_file.stem)
        created = data.get("created", data.get("createdAt", 0))

        # Convert timestamp (may be seconds or milliseconds)
        if isinstance(created, (int, float)) and created > 1e10:
            created = created / 1000  # milliseconds to seconds
        if since_ts and created < since_ts:
            continue

        timestamp = datetime.fromtimestamp(created, tz=timezone.utc).isoformat()
        messages = data.get("messages", [])

        first_user_query = ""
        tool_calls: dict[str, int] = {}
        bash_commands: list[str] = []
        skills_triggered: list[str] = []
        errors = 0
        turns = 0

        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", [])
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]

            if role == "user" and not first_user_query:
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text = block.get("text", "").strip()
                        if text and len(text) >= 4 and "tool_result" not in text[:20]:
                            first_user_query = text
                            break

            elif role == "assistant":
                turns += 1
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_use":
                        tool_name = block.get("name", "unknown")
                        tool_calls[tool_name] = tool_calls.get(tool_name, 0) + 1
                        inp = block.get("input", {})
                        if tool_name in ("Bash", "bash"):
                            cmd = inp.get("command", "").strip()
                            if cmd:
                                bash_commands.append(cmd)
                        if tool_name in ("Read", "read_file"):
                            fp = inp.get("file_path", "")
                            if Path(fp).name.upper() == "SKILL.MD":
                                sn = Path(fp).parent.name
                                if sn not in skills_triggered:
                                    skills_triggered.append(sn)

                    text = block.get("text", "")
                    for skill_name in skill_names:
                        if skill_name in text and skill_name not in skills_triggered:
                            skills_triggered.append(skill_name)

        sessions.append({
            "timestamp": timestamp,
            "session_id": session_id,
            "source": "opencode_json",
            "transcript_path": str(json_file),
            "cwd": "",
            "last_user_query": first_user_query,
            "query": first_user_query,
            "tool_calls": tool_calls,
            "total_tool_calls": sum(tool_calls.values()),
            "bash_commands": bash_commands,
            "skills_triggered": skills_triggered,
            "assistant_turns": turns,
            "errors_encountered": errors,
            "transcript_chars": json_file.stat().st_size,
        })

    return sessions


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------

def write_session(session: dict, dry_run: bool = False):
    prompt = session.get("query", "")
    session_id = session.get("session_id", "unknown")
    skills = session.get("skills_triggered", [])

    if dry_run:
        print(f"  [DRY] session={session_id[:12]}... "
              f"turns={session.get('assistant_turns', 0)} "
              f"skills={skills}")
        if prompt:
            print(f"        query: {prompt[:80]}")
        return

    for p in [QUERY_LOG, SKILL_LOG, TELEMETRY_LOG]:
        p.parent.mkdir(parents=True, exist_ok=True)

    if prompt and len(prompt) >= 4:
        with QUERY_LOG.open("a") as f:
            f.write(json.dumps({
                "timestamp": session["timestamp"],
                "session_id": session_id,
                "query": prompt,
                "source": session.get("source", "opencode"),
            }) + "\n")

    telemetry = {k: v for k, v in session.items() if k != "query"}
    with TELEMETRY_LOG.open("a") as f:
        f.write(json.dumps(telemetry) + "\n")

    for skill_name in skills:
        with SKILL_LOG.open("a") as f:
            f.write(json.dumps({
                "timestamp": session["timestamp"],
                "session_id": session_id,
                "skill_name": skill_name,
                "skill_path": f"(opencode:{skill_name})",
                "query": prompt,
                "triggered": True,
                "source": session.get("source", "opencode"),
            }) + "\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Ingest OpenCode sessions into skill eval log format"
    )
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR),
                        help=f"OpenCode data directory (default: {DEFAULT_DATA_DIR})")
    parser.add_argument("--since", default=None,
                        help="Only ingest sessions from this date onward (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true",
                        help="Re-ingest all sessions, ignoring marker")
    parser.add_argument("--show-schema", action="store_true",
                        help="Print OpenCode SQLite schema and exit")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    db_path = data_dir / "opencode.db"
    storage_dir = data_dir / "storage"

    if args.show_schema:
        if db_path.exists():
            print(get_db_schema(db_path))
        else:
            print(f"No database found at {db_path}")
        sys.exit(0)

    if not data_dir.exists():
        print(f"OpenCode data directory not found: {data_dir}")
        print("Is OpenCode installed? Try --data-dir to specify a custom location.")
        sys.exit(1)

    since_ts = None
    if args.since:
        since_ts = datetime.strptime(args.since, "%Y-%m-%d").replace(
            tzinfo=timezone.utc
        ).timestamp()

    skill_names = find_skill_names()
    already_ingested = set() if args.force else load_marker()
    all_sessions: list[dict] = []

    # Prefer SQLite
    if db_path.exists():
        print(f"Reading SQLite database: {db_path}")
        all_sessions = read_sessions_from_sqlite(db_path, since_ts, skill_names)
    elif storage_dir.exists():
        print(f"Reading legacy JSON files: {storage_dir}/session/")
        all_sessions = read_sessions_from_json_files(storage_dir, since_ts, skill_names)
    else:
        print(f"No OpenCode data found in {data_dir}")
        print("Expected either opencode.db or storage/session/*.json")
        sys.exit(1)

    pending = [s for s in all_sessions if s["session_id"] not in already_ingested]
    print(f"Found {len(all_sessions)} total sessions, {len(pending)} not yet ingested.")

    new_ingested: set[str] = set()
    ingested_count = 0

    for session in pending:
        if args.verbose or args.dry_run:
            print(f"  {'[DRY] ' if args.dry_run else ''}Ingesting: "
                  f"{session['session_id'][:12]}...")
        write_session(session, dry_run=args.dry_run)
        new_ingested.add(session["session_id"])
        ingested_count += 1

    if not args.dry_run:
        save_marker(already_ingested | new_ingested)

    print(f"\nDone. Ingested {ingested_count} sessions.")
    if ingested_count > 0 and not args.dry_run:
        print("\nNext: run hooks_to_evals.py --list-skills to see what's available.")


if __name__ == "__main__":
    main()
