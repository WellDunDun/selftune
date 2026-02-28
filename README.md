# Claude Code Hooks → Skill Evals

Real-usage telemetry for skill trigger evaluation — both positives AND negatives.

Two hooks work together to build a complete eval dataset over time:

| Hook event | Script | Logs to | What it captures |
|---|---|---|---|
| `UserPromptSubmit` | `prompt_log_hook.py` | `all_queries_log.jsonl` | **Every** user query |
| `PostToolUse` on `Read` | `skill_eval_hook.py` | `skill_usage_log.jsonl` | Queries that triggered a skill |

`hooks_to_evals.py` cross-references the two logs:
- **Positives** (`should_trigger: true`) — queries that triggered the skill
- **Negatives** (`should_trigger: false`) — queries that didn't trigger the skill (real prompts Claude handled another way or without any skill)

This captures false negatives — the queries that *should* have triggered a skill
but didn't — which synthetic eval sets can't easily produce.

---

## Files

| File | Purpose |
|---|---|
| `prompt_log_hook.py` | UserPromptSubmit hook — logs every query |
| `skill_eval_hook.py` | PostToolUse hook — logs skill reads with triggering query |
| `hooks_to_evals.py` | Converts both logs → eval set JSON for `run_eval.py` |
| `settings_snippet.json` | Hook config to merge into `~/.claude/settings.json` |

---

## Installation

### 1. Copy scripts somewhere stable

```bash
mkdir -p ~/bin
cp prompt_log_hook.py ~/bin/
cp skill_eval_hook.py ~/bin/
```

### 2. Register both hooks in Claude Code

Edit `~/.claude/settings.json`. If you already have a `hooks` block, merge the
entries in — don't replace the whole block.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 /Users/YOU/bin/prompt_log_hook.py",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /Users/YOU/bin/skill_eval_hook.py",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

You can also use `/hooks` inside Claude Code for an interactive editor.

### 3. Verify both hooks are running

Start a Claude Code session, send a message, and check:

```bash
# Should contain every query you've sent
cat ~/.claude/all_queries_log.jsonl

# Should contain entries for skill reads
cat ~/.claude/skill_usage_log.jsonl
```

---

## Usage

### See what's been logged

```bash
python3 hooks_to_evals.py --list-skills
```

Output:
```
Skill triggers in skill_usage_log (42 total records):
  pptx                            18 triggers
  docx                            14 triggers
  xlsx                             7 triggers
  pdf                              3 triggers

All queries in all_queries_log: 381
```

### Generate an eval set for a skill

```bash
python3 hooks_to_evals.py --skill pptx --output pptx_eval.json
```

Output:
```
Wrote 50 eval entries to pptx_eval.json
  Positives (should_trigger=true) : 18  (from 18 logged triggers)
  Negatives (should_trigger=false): 32  (from 381 total logged queries)
```

### Run the trigger eval

```bash
# From your skill-creator project root:
python -m scripts.run_eval \
  --eval-set pptx_eval.json \
  --skill-path /mnt/skills/public/pptx \
  --runs-per-query 3 --verbose
```

### Optimize the skill description

```bash
python -m scripts.run_loop \
  --eval-set pptx_eval.json \
  --skill-path /mnt/skills/public/pptx \
  --max-iterations 5 --verbose
```

---

## How it works

```
UserPromptSubmit fires
  └── prompt_log_hook.py logs query → all_queries_log.jsonl

Claude processes the query...
  If a SKILL.md is read:
    PostToolUse fires
      └── skill_eval_hook.py logs query + skill name → skill_usage_log.jsonl

hooks_to_evals.py cross-references:
  Positives  = skill_usage_log entries for target skill
  Negatives  = all_queries_log entries NOT in positives
               (real queries that didn't trigger the skill)
```

The negatives pool is particularly valuable because it contains:
- Queries that triggered a *different* skill (cross-skill confusion)
- Queries that triggered *no* skill (genuinely off-topic or under-triggering)

Human review of the negatives that seem like they *should* trigger is the
best way to find under-triggering cases. You can manually flip their
`should_trigger` to `true` before passing to `run_loop.py`.

---

## Tips

- Let the logs accumulate over several days before running evals — more
  diverse real queries = more reliable signal.
- Both hooks are silent (exit 0) and take <50ms, negligible overhead.
- The logs are append-only JSONL in `~/.claude/`. Safe to delete to start
  fresh, or archive old files.
- Use `--max 75` to increase the eval set size once you have enough data.
- Use `--seed 123` to get a different random sample of negatives.
