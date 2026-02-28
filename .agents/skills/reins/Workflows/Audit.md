# Reins Audit Workflow

Score an existing project against harness engineering principles. Produces a structured assessment with actionable recommendations.

## Default Command

Run the CLI first:
- Local source: `cd cli/reins && bun src/index.ts audit <path>`
- Package mode: `npx reins-cli@latest audit <path>`

For remediation detail, pair with doctor:
- `reins doctor <path>`

## Output Format

```json
{
  "project": "project-name",
  "timestamp": "2026-02-23T12:39:57.977Z",
  "scores": {
    "repository_knowledge": { "score": 3, "max": 3, "findings": ["AGENTS.md exists (56 lines)", "..."] },
    "architecture_enforcement": { "score": 3, "max": 3, "findings": ["..."] },
    "agent_legibility": { "score": 3, "max": 3, "findings": ["..."] },
    "golden_principles": { "score": 3, "max": 3, "findings": ["..."] },
    "agent_workflow": { "score": 3, "max": 3, "findings": ["..."] },
    "garbage_collection": { "score": 3, "max": 3, "findings": ["..."] }
  },
  "total_score": 18,
  "max_score": 18,
  "maturity_level": "L4: Self-Correcting",
  "recommendations": ["Project is well-structured. Consider evolving to next maturity level."]
}
```

## Parsing Audit Output

### Get Total Score and Level

```bash
result=$(cd cli/reins && bun src/index.ts audit <path>)
# Parse: .total_score (integer 0-18)
# Parse: .maturity_level (string like "L4: Self-Correcting")
```

### Identify Weakest Dimensions

```bash
# Find dimensions scoring below max
# Parse: .scores | to_entries[] | select(.value.score < .value.max)
```

### Check Specific Dimension

```bash
# Parse: .scores.repository_knowledge.score === 3
# Parse: .scores.architecture_enforcement.findings (array of evidence strings)
```

## Audit Dimensions

Score each dimension 0-3:
- **0** = Not present
- **1** = Minimal/ad-hoc
- **2** = Structured but incomplete
- **3** = Fully implemented and enforced

### 1. Repository Knowledge (0-3)

| Check | Points |
|-------|--------|
| AGENTS.md exists and under 150 lines (hierarchical: per-package in monorepos) | +1 |
| docs/ directory with indexed design docs (counts decisions in design-docs/index.md) | +1 |
| Verification headers in docs (`<!-- Verified: DATE -->`) and execution plans versioned in-repo | +1 |

**Bonus findings:** Hierarchical AGENTS.md detected, verification header count, design decision count.

### 2. Architecture Enforcement (0-3)

| Check | Points |
|-------|--------|
| ARCHITECTURE.md with dependency direction rules defined | +1 |
| Linter enforcement depth (structural lint scripts, architectural rules in config) | +1 |
| Enforcement evidence: 2+ signals from (risk-policy.json, CI with lint/test, structural lint scripts, golden principles) | +1 |

**Bonus findings:** Linter depth details, enforcement signal count.

### 3. Agent Legibility (0-3)

| Check | Points |
|-------|--------|
| App bootable per worktree (monorepo-aware: detects workspace packages, checks per-workspace bootability) | +1 |
| Observability accessible to agents (services: Sentry/Vercel/Netlify/Docker; CLIs: diagnosability signals like doctor/help commands) | +1 |
| Boring tech stack, minimal opaque dependencies (monorepo-aware: per-workspace average, threshold <20 single or <30 avg) | +1 |

**Bonus findings:** Monorepo workspace count, dependency count/average, diagnosability signals.

### 4. Golden Principles (0-3)

| Check | Points |
|-------|--------|
| Documented mechanical taste rules (counts principles, detects anti-patterns section) | +1 |
| Rules enforced in CI with depth (counts distinct enforcement steps in CI workflows) | +1 |
| Recurring cleanup/refactoring process (tech debt tracker) | +1 |

**Bonus findings:** Principle count, anti-patterns detected, CI gate count.

### 5. Agent Workflow (0-3)

| Check | Points |
|-------|--------|
| Agent config present (CLAUDE.md, conductor.json, .cursor, AGENTS.md) | +1 |
| Workflow signals (risk-policy.json, PR template, issue templates) | +1 |
| CI quality: 2+ distinct enforcement steps in workflows | +1 |

**Note:** `actions/checkout` does NOT count as an enforcement gate.

### 6. Garbage Collection (0-3)

| Check | Points |
|-------|--------|
| Doc-gardener scripts or freshness automation (active GC detection) | +1 |
| 3+ files with verification headers, or doc-gardener script present | +1 |
| Docs-drift enforcement: risk-policy.json with docsDriftRules, or quality grades in architecture | +1 |

## Maturity Levels

| Score | Level | Description |
|-------|-------|-------------|
| 0-4 | **L0: Manual** | Traditional engineering, no agent infrastructure |
| 5-8 | **L1: Assisted** | Agents help, but humans still write code |
| 9-13 | **L2: Steered** | Humans steer, agents execute most code |
| 14-16 | **L3: Autonomous** | Agents handle full lifecycle with human oversight |
| 17-18 | **L4: Self-Correcting** | Agents maintain, clean, and evolve the system |

## Steps

1. Run `reins audit <path>` and capture JSON output
2. Parse `.total_score` and `.maturity_level` for summary
3. Identify weakest dimensions: any `.scores.*.score < 3`
4. Read `.scores.*.findings` arrays for evidence of what was detected
5. Present top 3 actionable recommendations from `.recommendations`
6. If remediation needed, run `reins doctor <path>` for prescriptive fixes
7. After making changes, re-audit to verify score improvement
