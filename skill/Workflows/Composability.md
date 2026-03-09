# selftune Composability Workflow

Analyze how a target skill behaves alongside other skills in the same session.
The current command surfaces both positive synergy and negative conflicts, and
it highlights co-occurring pairs that look like workflow candidates.

## Default Command

```bash
selftune composability --skill <name> [options]
```

## Options

- `--skill <name>`: Skill to analyze. Required.
- `--window <n>`: Only analyze the last `n` sessions. Default: all sessions.
- `--min-occurrences <n>`: Minimum pair count for workflow-candidate
  suggestions. Default: `3`.
- `--telemetry-log <path>`: Path to the session telemetry log. Default:
  `~/.claude/session_telemetry_log.jsonl`.
- `--json`: Emit JSON instead of human-readable text. Default: text output when
  attached to a TTY.

## Output Format

When `skill_usage_log.jsonl` is available, selftune uses the v2 analyzer and
prints co-occurring pairs, detected sequences, workflow candidates, and
conflicts.

If `skill_usage_log.jsonl` is missing, `selftune composability` falls back to
the v1 analyzer and emits the legacy v1 JSON-only report directly. In that
mode, detected sequences and workflow-candidate sections are unavailable.

```text
Composability Report: Copywriting
Analyzed: 150 sessions | Window: all

Co-occurring Skills:
  Copywriting + SelfTuneBlog     (42 sessions)  synergy: +0.72  ✓ workflow candidate
  Copywriting + MarketingAuto    (38 sessions)  synergy: +0.55  ✓ workflow candidate
  Copywriting + Research         (15 sessions)  synergy: +0.21
  Copywriting + BuggySkill       ( 3 sessions)  synergy: -0.45  ⚠ conflict

Detected Sequences:
  1. Copywriting → MarketingAutomation → SelfTuneBlog  (12x, 92% consistent)
  2. Copywriting → SelfTuneBlog                        ( 8x, 100% consistent)

Workflow Candidates:
  • "Copywriting + SelfTuneBlog" — used together 42 times with 72% fewer errors
    → Run `selftune workflows save "Copywriting→SelfTuneBlog"` to codify

Conflicts:
  • "Copywriting + BuggySkill" — 45% more errors together (3 sessions)
```

## How It Works

1. Filters sessions where `skills_triggered` includes the target skill
2. Computes pair-level metrics against solo baselines:
   - `avg_errors_together`
   - `avg_errors_alone`
   - `synergy_score = clamp((avg_errors_alone - avg_errors_together) /
     (avg_errors_alone + 1), -1, 1)`
3. Marks pairs as workflow candidates when `synergy_score > 0.3` and the pair's
   occurrence count clears `--min-occurrences`
4. Extracts ordered multi-skill sequences from usage timestamps
5. Preserves negative synergy as conflicts instead of clamping it away

## Interpreting Results

- `+0.6` to `+1.0`: Strong synergy; good workflow candidate.
- `+0.3` to `+0.6`: Moderate synergy; investigate codifying the chain.
- `-0.1` to `+0.3`: No strong interaction.
- `-0.3` to `-0.1`: Mild friction; monitor.
- `-1.0` to `-0.3`: Conflict; skills likely interfere.

## Follow-up Actions

- For strong synergy, run `selftune workflows` to inspect full ordered
  sequences
- Use `selftune workflows save <workflow-id|index>` to codify a discovered
  chain
- For conflicts, compare trigger overlap and routing boundaries between the
  skills
- Use the `pattern-analyst` agent (optional repository extension, if
  available) for deeper cross-skill diagnosis when conflicts persist

## Common Patterns

- "Are there conflicts between my skills?"  
  `selftune composability --skill Research`
- "Which skills work unusually well with Copywriting?"  
  `selftune composability --skill Copywriting`
- "Check recent sessions only"  
  `selftune composability --skill pptx --window 7`
- "Use a stricter workflow-candidate threshold"  
  `selftune composability --skill Deploy --min-occurrences 5`
