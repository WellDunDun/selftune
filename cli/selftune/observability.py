#!/usr/bin/env python3
"""Observability and diagnosability surfaces for selftune.

Provides:
- Structured health checks (doctor command)
- Log file integrity verification
- Session telemetry stats
- Deterministic error metadata
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

LOG_DIR = Path.home() / ".claude"
LOG_FILES = {
    "session_telemetry": LOG_DIR / "session_telemetry_log.jsonl",
    "skill_usage": LOG_DIR / "skill_usage_log.jsonl",
    "all_queries": LOG_DIR / "all_queries_log.jsonl",
}

REQUIRED_FIELDS = {
    "session_telemetry": {"timestamp", "session_id", "source"},
    "skill_usage": {"timestamp", "session_id", "skill_name"},
    "all_queries": {"timestamp", "session_id", "query"},
}


def check_log_health() -> list[dict]:
    """Check health of all JSONL log files."""
    checks = []
    for name, path in LOG_FILES.items():
        check = {"name": f"log_{name}", "path": str(path)}
        if not path.exists():
            check["status"] = "warn"
            check["message"] = "Log file does not exist yet (no sessions captured)"
        else:
            line_count = 0
            parse_errors = 0
            schema_errors = 0
            required = REQUIRED_FIELDS[name]
            for line in path.read_text().splitlines():
                line_count += 1
                try:
                    record = json.loads(line)
                    missing = required - set(record.keys())
                    if missing:
                        schema_errors += 1
                except json.JSONDecodeError:
                    parse_errors += 1

            if parse_errors > 0 or schema_errors > 0:
                check["status"] = "fail"
                check["message"] = (
                    f"{line_count} records, {parse_errors} parse errors, "
                    f"{schema_errors} schema errors"
                )
            else:
                check["status"] = "pass"
                check["message"] = f"{line_count} records, all valid"

        checks.append(check)
    return checks


def check_hook_installation() -> list[dict]:
    """Check that selftune hooks are installed."""
    checks = []
    hook_files = ["prompt_log_hook.py", "session_stop_hook.py", "skill_eval_hook.py"]
    for hook in hook_files:
        check = {"name": f"hook_{hook}", "path": hook}
        if Path(hook).exists():
            check["status"] = "pass"
            check["message"] = "Hook file present"
        else:
            check["status"] = "fail"
            check["message"] = "Hook file missing"
        checks.append(check)
    return checks


def doctor() -> dict:
    """Run all health checks and return structured results."""
    all_checks = check_log_health() + check_hook_installation()
    passed = sum(1 for c in all_checks if c["status"] == "pass")
    failed = sum(1 for c in all_checks if c["status"] == "fail")
    warned = sum(1 for c in all_checks if c["status"] == "warn")

    return {
        "command": "doctor",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "checks": all_checks,
        "summary": {"pass": passed, "fail": failed, "warn": warned, "total": len(all_checks)},
        "healthy": failed == 0,
    }


def main() -> int:
    result = doctor()
    print(json.dumps(result, indent=2))
    return 0 if result["healthy"] else 1


if __name__ == "__main__":
    sys.exit(main())
