#!/usr/bin/env python3
"""
Claude Code UserPromptSubmit hook: prompt_log_hook.py

Fires on every user message before Claude processes it.
Logs the query to ~/.claude/all_queries_log.jsonl so that
hooks_to_evals.py can identify prompts that did NOT trigger
a skill — the raw material for false-negative eval entries.

Cross-reference with skill_usage_log.jsonl (written by
skill_eval_hook.py) to classify each query as triggered / not-triggered
per skill.

Installation: see settings_snippet.json
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


LOG_PATH = Path.home() / ".claude" / "all_queries_log.jsonl"

# Ignore internal / tool-result messages that aren't real user prompts.
# UserPromptSubmit fires for human-typed messages; these prefixes
# indicate automated or tool-injected content we don't want in evals.
SKIP_PREFIXES = (
    "<tool_result",
    "<function_result",
    "[Automated",
    "[System",
)


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    query = payload.get("user_prompt", "").strip()

    if not query:
        sys.exit(0)

    # Skip automated/tool messages
    if any(query.startswith(p) for p in SKIP_PREFIXES):
        sys.exit(0)

    # Skip very short noise (single chars, punctuation)
    if len(query) < 4:
        sys.exit(0)

    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session_id": payload.get("session_id", "unknown"),
        "query": query,
    }

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")

    sys.exit(0)


if __name__ == "__main__":
    main()
