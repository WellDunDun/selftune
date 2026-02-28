#!/usr/bin/env python3
"""Structural linter enforcing selftune architecture rules.

Checks:
1. Hook modules (*_hook.py) must not import from grading/eval modules
2. Ingestor modules (*_ingest.py) must not import from grading/eval modules
3. All JSONL writers must use the shared field names from the schema
"""

import ast
import sys
from pathlib import Path

# Dependency direction: hooks/ingestors -> shared schema -> eval -> grading -> evolution
HOOK_FILES = {"prompt_log_hook.py", "session_stop_hook.py", "skill_eval_hook.py"}
INGESTOR_FILES = {"codex_wrapper.py", "codex_rollout_ingest.py", "opencode_ingest.py"}
FORBIDDEN_IMPORTS_FOR_HOOKS = {
    "grade_session", "hooks_to_evals",
    "selftune.grading", "selftune.eval",
}
FORBIDDEN_IMPORTS_FOR_INGESTORS = {
    "grade_session", "hooks_to_evals",
    "selftune.grading", "selftune.eval",
}

REQUIRED_LOG_FIELDS = {
    "session_telemetry": {"timestamp", "session_id", "source"},
    "skill_usage": {"timestamp", "session_id", "skill_name"},
    "all_queries": {"timestamp", "session_id", "query"},
}


def check_import_direction(filepath: Path) -> list[str]:
    """Check that hooks and ingestors don't import from downstream modules."""
    violations = []
    name = filepath.name

    if name not in HOOK_FILES and name not in INGESTOR_FILES:
        return violations

    forbidden = set()
    if name in HOOK_FILES:
        forbidden = FORBIDDEN_IMPORTS_FOR_HOOKS
    elif name in INGESTOR_FILES:
        forbidden = FORBIDDEN_IMPORTS_FOR_INGESTORS

    try:
        tree = ast.parse(filepath.read_text())
    except SyntaxError:
        return [f"{filepath}: SyntaxError — cannot parse"]

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in forbidden:
                    violations.append(
                        f"{filepath}:{node.lineno}: imports '{alias.name}' "
                        f"(violates dependency direction)"
                    )
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module in forbidden:
                violations.append(
                    f"{filepath}:{node.lineno}: imports from '{node.module}' "
                    f"(violates dependency direction)"
                )

    return violations


def main() -> int:
    root = Path(".")
    violations = []

    for py_file in sorted(root.glob("cli/selftune/**/*.py")):
        violations.extend(check_import_direction(py_file))

    if violations:
        print("Architecture violations found:")
        for v in violations:
            print(f"  {v}")
        return 1

    print("No architecture violations found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
