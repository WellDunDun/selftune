# Reins Doctor Workflow

Diagnose readiness gaps with pass/fail/warn checks and prescriptive fixes.

## Default Command

Run the CLI first:
- Local source: `cd cli/reins && bun src/index.ts doctor <path>`
- Package mode: `npx reins-cli@latest doctor <path>`

For scoring context, pair with audit:
- `reins audit <path>`

## Audit vs Doctor

| Tool | Purpose | Output |
|------|---------|--------|
| **audit** | Quantitative maturity scoring (0-18) | Scores, findings, maturity level |
| **doctor** | Actionable health checks | check/status/fix entries + summary |

Use **doctor** for remediation details. Use **audit** for maturity scoring.

## Output Format

Doctor output fields are deterministic JSON:

```json
{
  "command": "doctor",
  "project": "project-name",
  "target": "/abs/path/to/project",
  "summary": {
    "passed": 8,
    "failed": 2,
    "warnings": 3,
    "total": 13
  },
  "checks": [
    {
      "check": "AGENTS.md exists and concise",
      "status": "pass",
      "fix": ""
    },
    {
      "check": "ARCHITECTURE.md missing",
      "status": "fail",
      "fix": "Run 'reins init .' to create ARCHITECTURE.md"
    }
  ]
}
```

## Checks Covered

Doctor checks include:
- Repository map and architecture presence (`AGENTS.md`, `ARCHITECTURE.md`)
- Required docs (`docs/design-docs/index.md`, `docs/design-docs/core-beliefs.md`, `docs/product-specs/index.md`, `docs/exec-plans/tech-debt-tracker.md`, `docs/golden-principles.md`)
- Linter and CI signals
- Risk policy (`risk-policy.json`)
- Verification headers in docs
- Optional monorepo/structure checks (hierarchical AGENTS, structural lint scripts)

Notes:
- Check count is dynamic by repository shape.
- Some checks are advisory warnings (not hard failures).

## Parsing Doctor Output

```bash
result=$(cd cli/reins && bun src/index.ts doctor <path>)
# Parse hard failures:
# .summary.failed

# Parse fixes to apply:
# .checks[] | select(.status == "fail" or .status == "warn") | {check, fix}
```

## Steps

1. Run `reins doctor <path>` and capture JSON.
2. Parse `.summary` and failed/warn checks.
3. Execute `.fix` instructions for each failing check.
4. Re-run doctor until failures are resolved.
5. Run `reins audit <path>` to verify score impact.
