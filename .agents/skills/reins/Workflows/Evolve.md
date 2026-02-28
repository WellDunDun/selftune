# Reins Evolve Workflow

Upgrade a project to the next Reins maturity level.

## Default Command

Run:
- Local source: `cd cli/reins && bun src/index.ts evolve <path>`
- Package mode: `npx reins-cli@latest evolve <path>`

Optional flag:
- `--apply` (limited auto-apply support)

## Prerequisite

Run audit first (or let evolve run it internally) to determine current level.

## Output Format

```json
{
  "command": "evolve",
  "project": "project-name",
  "current_level": "L1: Assisted",
  "current_score": 8,
  "next_level": "L2: Steered",
  "goal": "Shift from human-writes-code to human-steers-agent",
  "steps": [
    {
      "step": 1,
      "action": "Write golden principles",
      "description": "Mechanical taste rules in docs/golden-principles.md, enforced in CI — not just documented.",
      "automated": true
    }
  ],
  "success_criteria": "Most new code is written by agents, not humans.",
  "weakest_dimensions": [
    {
      "dimension": "architecture_enforcement",
      "score": 1,
      "max": 3,
      "findings": ["..."]
    }
  ],
  "applied": [],
  "recommendations": ["..."]
}
```

## Parsing Evolve Output

```bash
result=$(cd cli/reins && bun src/index.ts evolve <path>)
# Parse: .current_level, .next_level
# Parse: .steps[]
# Parse: .weakest_dimensions[]
```

## About `--apply`

Current behavior is intentionally narrow:
- It can run `reins init` scaffolding when missing core structure is detected.
- It does not automatically execute all non-trivial/manual evolution steps.

Treat `--apply` as scaffold assist, not full autonomous evolution.

## Evolution Paths

- **L0 -> L1**: establish baseline repo map/docs/architecture and first agent loop.
- **L1 -> L2**: enforce golden principles and shift to prompt-first steering.
- **L2 -> L3**: add policy-as-code, stronger enforcement, and autonomous delivery loops.
- **L3 -> L4**: add active drift detection, quality grading, and continuous cleanup.

## Steps

1. Run `reins evolve <path>`.
2. Review `.steps` and split into automated vs manual.
3. Execute the path with agents.
4. Re-run `reins audit <path>`.
5. Confirm maturity/score improvement and record outcomes in `docs/exec-plans/completed/`.
