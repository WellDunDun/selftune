#!/usr/bin/env python3
"""
hooks_to_evals.py

Converts hook logs into trigger eval sets compatible with run_eval.py / run_loop.py.

Three input logs (all written automatically by hooks):
  ~/.claude/skill_usage_log.jsonl      — queries that DID trigger a skill
  ~/.claude/all_queries_log.jsonl      — ALL queries, triggered or not
  ~/.claude/session_telemetry_log.jsonl — per-session process metrics (Stop hook)

For a given skill:
  Positives (should_trigger=true)  → queries in skill_usage_log for that skill
  Negatives (should_trigger=false) → queries in all_queries_log that never triggered
                                     that skill (cross-skill AND untriggered queries)

Invocation taxonomy (from the eval best-practices article) is applied to positives:
  explicit    — query mentions the skill name or uses $skill syntax
  implicit    — describes the scenario without naming the skill
  contextual  — implicit but with realistic noise/domain context
  (negative   — should_trigger=false entries)

Usage:
    python hooks_to_evals.py --list-skills
    python hooks_to_evals.py --skill pptx --output pptx_trigger_eval.json
    python hooks_to_evals.py --skill pptx --output pptx_trigger_eval.json --max 75
    python hooks_to_evals.py --skill pptx --output pptx_trigger_eval.json --no-negatives
    python hooks_to_evals.py --skill pptx --stats   # show process telemetry summary

Output feeds directly into run_eval.py / run_loop.py:
    python -m scripts.run_eval --eval-set pptx_trigger_eval.json \\
                               --skill-path /mnt/skills/public/pptx
"""

import argparse
import json
import random
import sys
import re
from collections import defaultdict
from pathlib import Path


SKILL_LOG_PATH = Path.home() / ".claude" / "skill_usage_log.jsonl"
QUERY_LOG_PATH = Path.home() / ".claude" / "all_queries_log.jsonl"
TELEMETRY_LOG_PATH = Path.home() / ".claude" / "session_telemetry_log.jsonl"

GENERIC_NEGATIVES = [
    "What time is it?",
    "Tell me a joke",
    "Summarize this paragraph",
    "What is the capital of France?",
    "Help me debug this Python error",
    "Write a haiku about autumn",
    "Explain what recursion means",
    "How do I reverse a string in JavaScript?",
    "What is 42 times 17?",
    "Translate 'hello' to Spanish",
    "Can you review this code?",
    "What does this error mean?",
    "Help me write a commit message",
    "Explain this function to me",
    "How do I center a div in CSS?",
]


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    records = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def classify_invocation(query: str, skill_name: str) -> str:
    """
    Classify a trigger query into the four-category taxonomy.

    explicit    — directly names the skill or uses $skill syntax
    implicit    — describes the exact scenario the skill targets
    contextual  — matches the skill's purpose but with domain noise
    (negatives are classified separately, not through this function)

    Heuristic: 'explicit' if skill name or $-syntax appears in the query.
    Otherwise 'contextual' if the query is long (>60 chars, suggesting added
    context), and 'implicit' if it's a clean, short task description.
    """
    q_lower = query.lower()
    skill_lower = skill_name.lower()

    # Explicit: mentions skill name or $skill syntax
    if (f"${skill_lower}" in q_lower or
            f"${skill_name}" in query or
            skill_lower in q_lower):
        return "explicit"

    # Contextual: longer queries with domain/project context (realistic noise)
    # Heuristic: contains a proper noun, project name, or is notably long
    word_count = len(query.split())
    has_proper_noun = bool(re.search(r'\b[A-Z][a-z]{2,}\b', query))

    if word_count > 15 or has_proper_noun:
        return "contextual"

    return "implicit"


def list_skills(skill_records: list[dict], query_records: list[dict],
                telemetry_records: list[dict]):
    counts: dict[str, int] = defaultdict(int)
    for r in skill_records:
        counts[r.get("skill_name", "unknown")] += 1

    print(f"Skill triggers in skill_usage_log ({len(skill_records)} total records):")
    if counts:
        for name, count in sorted(counts.items(), key=lambda x: -x[1]):
            print(f"  {name:30s}  {count:4d} triggers")
    else:
        print("  (none yet — trigger some skills in Claude Code to populate)")

    print(f"\nAll queries in all_queries_log: {len(query_records)}")
    if not query_records:
        print("  (none yet — make sure prompt_log_hook.py is installed)")

    print(f"\nSessions in session_telemetry_log: {len(telemetry_records)}")
    if not telemetry_records:
        print("  (none yet — make sure session_stop_hook.py is installed)")


def show_telemetry_stats(telemetry_records: list[dict], skill_name: str):
    """Print process-level stats for sessions where the skill triggered."""
    sessions = [r for r in telemetry_records if skill_name in r.get("skills_triggered", [])]

    if not sessions:
        print(f"No telemetry sessions found for skill '{skill_name}'.")
        print("Make sure session_stop_hook.py is installed.")
        return

    print(f"Process telemetry for skill '{skill_name}' ({len(sessions)} sessions):\n")

    # Aggregate tool calls
    all_tools: dict[str, list[int]] = defaultdict(list)
    all_turns = []
    all_errors = []
    all_bash_counts = []

    for s in sessions:
        for tool, count in s.get("tool_calls", {}).items():
            all_tools[tool].append(count)
        all_turns.append(s.get("assistant_turns", 0))
        all_errors.append(s.get("errors_encountered", 0))
        all_bash_counts.append(len(s.get("bash_commands", [])))

    def avg(lst):
        return sum(lst) / len(lst) if lst else 0

    print(f"  Assistant turns:   avg {avg(all_turns):.1f}  "
          f"(min {min(all_turns)}, max {max(all_turns)})")
    print(f"  Errors:            avg {avg(all_errors):.1f}  "
          f"(min {min(all_errors)}, max {max(all_errors)})")
    print(f"  Bash commands:     avg {avg(all_bash_counts):.1f}")
    print()
    print("  Tool call averages:")
    for tool, counts in sorted(all_tools.items(), key=lambda x: -avg(x[1])):
        print(f"    {tool:20s} avg {avg(counts):.1f}")

    # Flag high-error sessions
    high_error = [s for s in sessions if s.get("errors_encountered", 0) > 2]
    if high_error:
        print(f"\n  ⚠ {len(high_error)} session(s) had >2 errors — inspect transcripts:")
        for s in high_error:
            print(f"    session {s['session_id'][:12]}... — "
                  f"{s['errors_encountered']} errors, "
                  f"transcript: {s.get('transcript_path', '?')}")


def build_eval_set(
    skill_records: list[dict],
    query_records: list[dict],
    skill_name: str,
    max_per_side: int = 50,
    include_negatives: bool = True,
    seed: int = 42,
    annotate_taxonomy: bool = True,
) -> list[dict]:
    """
    Build a balanced eval set for `skill_name` with invocation taxonomy annotations.
    """
    rng = random.Random(seed)

    # Build set of positive query texts (for exclusion from negatives)
    positive_queries: set[str] = set()
    for r in skill_records:
        if r.get("skill_name") == skill_name:
            q = r.get("query", "").strip()
            if q and q != "(query not found)":
                positive_queries.add(q)

    # Build deduplicated positives with taxonomy classification
    seen: set[str] = set()
    positives: list[dict] = []
    for r in skill_records:
        if r.get("skill_name") != skill_name:
            continue
        q = r.get("query", "").strip()
        if not q or q == "(query not found)" or q in seen:
            continue
        seen.add(q)
        entry: dict = {"query": q, "should_trigger": True}
        if annotate_taxonomy:
            entry["invocation_type"] = classify_invocation(q, skill_name)
        positives.append(entry)

    rng.shuffle(positives)
    positives = positives[:max_per_side]

    negatives: list[dict] = []
    if include_negatives:
        neg_candidates: list[str] = []
        neg_seen: set[str] = set()
        for r in query_records:
            q = r.get("query", "").strip()
            if not q or q in positive_queries or q in neg_seen:
                continue
            neg_seen.add(q)
            neg_candidates.append(q)

        rng.shuffle(neg_candidates)
        negatives = [{"query": q, "should_trigger": False,
                      **({"invocation_type": "negative"} if annotate_taxonomy else {})}
                     for q in neg_candidates[:max_per_side]]

        # Pad with generic fallbacks if needed
        if len(negatives) < len(positives):
            needed = len(positives) - len(negatives)
            fallbacks = [
                {"query": q, "should_trigger": False,
                 **({"invocation_type": "negative"} if annotate_taxonomy else {})}
                for q in GENERIC_NEGATIVES
                if q not in neg_seen and q not in positive_queries
            ]
            negatives.extend(fallbacks[:needed])

    return positives + negatives


def print_eval_stats(eval_set, skill_name, output_path, skill_records,
                     query_records, annotate_taxonomy):
    pos = [e for e in eval_set if e["should_trigger"]]
    neg = [e for e in eval_set if not e["should_trigger"]]
    total_triggers = sum(1 for r in skill_records if r.get("skill_name") == skill_name)

    print(f"Wrote {len(eval_set)} eval entries to {output_path}")
    print(f"  Positives (should_trigger=true) : {len(pos)}"
          f"  (from {total_triggers} logged triggers)")
    print(f"  Negatives (should_trigger=false): {len(neg)}"
          f"  (from {len(query_records)} total logged queries)")

    if annotate_taxonomy and pos:
        from collections import Counter
        types = Counter(e.get("invocation_type", "?") for e in pos)
        print(f"\n  Positive invocation types:")
        for t, c in sorted(types.items()):
            print(f"    {t:15s}  {c}")
        if "explicit" not in types:
            print("\n  [TIP] No explicit positives (queries naming the skill directly).")
            print("        Consider adding some for a complete taxonomy.")
        if "contextual" not in types:
            print("\n  [TIP] No contextual positives (implicit + domain noise).")
            print("        These are important for realistic triggering tests.")

    print()
    if len(pos) == 0:
        print(f"[WARN] No positives for skill '{skill_name}'.")
        names = sorted({r.get("skill_name") for r in skill_records})
        if names:
            print(f"       Known skills: {', '.join(names)}")
    if len(neg) == 0:
        print("[WARN] No negatives — install prompt_log_hook.py for real negatives.")

    print("Next steps:")
    print(f"  python -m scripts.run_eval \\")
    print(f"    --eval-set {output_path} \\")
    print(f"    --skill-path /path/to/skills/{skill_name} \\")
    print(f"    --runs-per-query 3 --verbose")
    print()
    print(f"  python -m scripts.run_loop \\")
    print(f"    --eval-set {output_path} \\")
    print(f"    --skill-path /path/to/skills/{skill_name} \\")
    print(f"    --max-iterations 5 --verbose")


def main():
    parser = argparse.ArgumentParser(
        description="Convert skill hook logs to trigger eval sets"
    )
    parser.add_argument("--skill", help="Skill name (e.g. 'pptx')")
    parser.add_argument("--output", help="Output JSON path")
    parser.add_argument("--skill-log", default=str(SKILL_LOG_PATH))
    parser.add_argument("--query-log", default=str(QUERY_LOG_PATH))
    parser.add_argument("--telemetry-log", default=str(TELEMETRY_LOG_PATH))
    parser.add_argument("--list-skills", action="store_true",
                        help="List skills in logs and exit")
    parser.add_argument("--stats", action="store_true",
                        help="Show process telemetry stats for --skill")
    parser.add_argument("--no-negatives", action="store_true")
    parser.add_argument("--no-taxonomy", action="store_true",
                        help="Omit invocation_type field from output")
    parser.add_argument("--max", type=int, default=50)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    skill_records = load_jsonl(Path(args.skill_log))
    query_records = load_jsonl(Path(args.query_log))
    telemetry_records = load_jsonl(Path(args.telemetry_log))

    if args.list_skills:
        list_skills(skill_records, query_records, telemetry_records)
        sys.exit(0)

    if not args.skill:
        print("[ERROR] --skill required (or use --list-skills)", file=sys.stderr)
        sys.exit(1)

    if args.stats:
        show_telemetry_stats(telemetry_records, args.skill)
        sys.exit(0)

    annotate = not args.no_taxonomy
    eval_set = build_eval_set(
        skill_records=skill_records,
        query_records=query_records,
        skill_name=args.skill,
        max_per_side=args.max,
        include_negatives=not args.no_negatives,
        seed=args.seed,
        annotate_taxonomy=annotate,
    )

    output_path = Path(args.output or f"{args.skill}_trigger_eval.json")
    output_path.write_text(json.dumps(eval_set, indent=2), encoding="utf-8")
    print_eval_stats(eval_set, args.skill, output_path, skill_records,
                     query_records, annotate)


if __name__ == "__main__":
    main()
