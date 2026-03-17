# selftune Baseline Workflow

Measure whether a skill adds value over a no-skill baseline. Runs trigger
checks with and without the skill description to compute lift — the
improvement in pass rate that the skill provides.

## When to Invoke

Invoke this workflow when the user requests any of the following:
- Measuring whether a skill adds value or is worth keeping
- Comparing skill performance against a no-skill baseline
- Deciding whether to evolve or rework a skill
- Any request containing "baseline", "does this skill help", or "skill value"

## Default Command

```bash
selftune grade baseline --skill <name> --skill-path <path> [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--skill <name>` | Skill name | Required |
| `--skill-path <path>` | Path to the skill's SKILL.md | Required |
| `--eval-set <path>` | Pre-built eval set JSON | Auto-generated from logs |
| `--agent <name>` | Agent CLI to use | Auto-detected |

## Output Format

```json
{
  "skill_name": "Research",
  "eval_set_size": 25,
  "baseline_pass_rate": 0.32,
  "with_skill_pass_rate": 0.88,
  "lift": 0.56,
  "adds_value": true,
  "measured_at": "2026-03-04T12:00:00.000Z"
}
```

## How It Works

1. Loads the eval set (from `--eval-set` or auto-generated from logs)
2. Reads the skill's current description from SKILL.md
3. Runs trigger checks against an **empty description** (no-skill baseline)
4. Runs trigger checks against the **actual description** (with-skill)
5. Computes pass rates for both conditions
6. Calculates `lift = with_skill_pass_rate - baseline_pass_rate`
7. Sets `adds_value = lift >= 0.05`

## Integration with Evolve

The `selftune evolve` command supports a `--with-baseline` flag:

```bash
selftune evolve --skill Research --skill-path /path/SKILL.md --with-baseline
```

When enabled, the evolve command measures baseline lift before deploying.
If the skill doesn't add at least 5% lift over no-skill, the evolution is
skipped — the skill needs fundamental rework, not description tweaks.

## Steps

### 0. Pre-Flight Configuration

Before running baseline measurement, use the `AskUserQuestion` tool to present structured configuration options.

If the user responds with "use defaults", cancels, or similar shorthand, skip to step 1 using the recommended defaults.

Use `AskUserQuestion` with these questions:

```json
{
  "questions": [
    {
      "question": "Eval Set Source",
      "options": ["Auto-generate from logs (recommended if logs exist)", "Use existing eval set file", "Generate synthetic evals first (for new skills)"]
    },
    {
      "question": "Agent CLI",
      "options": ["Auto-detect (recommended)", "claude", "codex", "opencode"]
    }
  ]
}
```

If `AskUserQuestion` is not available, fall back to presenting these as inline numbered options.

After the user responds, parse their selections and map each choice to the corresponding CLI flags:

| Selection | CLI Flag |
|-----------|----------|
| 1a (auto-generate) | _(no flag, default)_ |
| 1b (existing eval set) | `--eval-set <path>` |
| 1c (synthetic first) | Run Evals workflow with `--synthetic` first, then use output |
| 2a (auto-detect) | _(no flag, default)_ |
| 2b (specify agent) | `--agent <name>` |

Show a confirmation summary to the user:

```
Configuration Summary:
  Eval source:   auto-generate from logs
  Agent:         auto-detect

Proceeding...
```

Build the CLI command string with all selected flags and continue to step 1.

### 1. Run Baseline Measurement

```bash
selftune grade baseline --skill Research --skill-path ~/.claude/skills/Research/SKILL.md
```

Parse the JSON output and extract `lift` and `adds_value` fields.

### 2. Interpret Results

| Lift | Interpretation | Action |
|------|---------------|--------|
| >= 0.20 | Strong value | Skill is working well |
| 0.05–0.20 | Moderate value | Consider evolving to improve |
| < 0.05 | Minimal value | Skill may need rework, not just evolution |
| < 0 | Negative value | Skill is hurting — investigate or disable |

Report the interpretation to the user based on the lift value.

### 3. Use as Evolution Gate

Add `--with-baseline` to evolve commands to prevent wasting evolution
cycles on skills that don't add value.

## Common Patterns

**User asks whether a skill adds value (e.g., "does the Research skill help?"):**
Run `selftune grade baseline --skill Research --skill-path ~/.claude/skills/Research/SKILL.md`.
Parse the JSON output and report the lift value with interpretation.

**User wants to gate evolution on baseline value:**
Run `selftune evolve --skill Research --skill-path /path/SKILL.md --with-baseline`.
This measures baseline lift before deploying and skips evolution if lift is below 5%.

**User wants to test with a custom eval set:**
Run `selftune grade baseline --skill pptx --skill-path /path/SKILL.md --eval-set evals-pptx.json`.
