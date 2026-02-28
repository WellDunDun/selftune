<!-- Verified: 2026-02-28 -->

# Escalation Policy

Clear criteria for when agents proceed autonomously vs. when to involve a human.

## Risk Tiers

| Tier | Agent Authority | Human Required |
|------|----------------|----------------|
| **Low** | Proceed autonomously | Notify after completion |
| **Medium** | Propose change, await approval | Review before merge |
| **High** | Draft only, do not execute | Explicit sign-off required |

## Escalation Triggers

### Always Escalate (High Risk)

- Modifying the shared JSONL log schema (breaks all three platform adapters)
- Changing hook installation paths or hook entry points
- Modifying grading criteria that affect eval pass rates
- Deleting or renaming log files
- Any change to `risk-policy.json`

### Review Before Merge (Medium Risk)

- Adding new fields to JSONL output
- Modifying eval set generation logic in `hooks_to_evals.py`
- Changing grading thresholds in `grade_session.py`
- Adding new platform ingestors
- Updating ARCHITECTURE.md domain map

### Agent-Autonomous (Low Risk)

- Bug fixes within a single module
- Adding tests for existing functionality
- Documentation updates (non-architectural)
- Code style improvements
- Adding new eval queries to existing eval sets

## Schema Change Protocol

Changes to the shared log schema require:

1. Update schema documentation in PRD.md appendix
2. Update all writers (hooks + ingestors)
3. Update all readers (eval + grading)
4. Run full test suite
5. Human review before merge
