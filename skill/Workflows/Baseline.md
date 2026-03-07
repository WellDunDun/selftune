# selftune Baseline Workflow

Measure whether a skill adds value over a no-skill baseline. Runs trigger
checks with and without the skill description to compute lift — the
improvement in pass rate that the skill provides.

## Default Command

```bash
selftune baseline --skill <name> --skill-path <path> [options]
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

Before running baseline measurement, present configuration options to the user.
If the user says "use defaults" or similar, skip to step 1 with recommended defaults.

Present these options:

```
selftune baseline — Pre-Flight Configuration

1. Eval Set Source
   a) Auto-generate from logs (recommended if logs exist)
   b) Use existing eval set file — provide path
   c) Generate synthetic evals first (for new skills with no data)

2. Agent CLI
   a) Auto-detect (recommended)
   b) Specify: claude / codex / opencode

→ Reply with your choices or "use defaults" for recommended settings.
```

After the user responds, show a confirmation summary:

```
Configuration Summary:
  Eval source:   auto-generate from logs
  Agent:         auto-detect

Proceeding...
```

### 1. Run Baseline Measurement

```bash
selftune baseline --skill Research --skill-path ~/.claude/skills/Research/SKILL.md
```

### 2. Interpret Results

| Lift | Interpretation | Action |
|------|---------------|--------|
| >= 0.20 | Strong value | Skill is working well |
| 0.05–0.20 | Moderate value | Consider evolving to improve |
| < 0.05 | Minimal value | Skill may need rework, not just evolution |
| < 0 | Negative value | Skill is hurting — investigate or disable |

### 3. Use as Evolution Gate

Add `--with-baseline` to evolve commands to prevent wasting evolution
cycles on skills that don't add value.

## Common Patterns

**"Does the Research skill add value?"**
> `selftune baseline --skill Research --skill-path ~/.claude/skills/Research/SKILL.md`

**"Only evolve if the skill is actually useful"**
> `selftune evolve --skill Research --skill-path /path/SKILL.md --with-baseline`

**"Check baseline with a custom eval set"**
> `selftune baseline --skill pptx --skill-path /path/SKILL.md --eval-set evals-pptx.json`
