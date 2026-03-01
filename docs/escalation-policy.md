<!-- Verified: 2026-03-01 -->

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
- Modifying the evolution audit log schema (`evolution_audit_log.jsonl`)
- Changing rollback logic in `rollback.ts` (data loss risk)
- Modifying auto-rollback behavior in `watch.ts` (unintended reverts)
- Changing the config schema in `~/.selftune/config.json` (breaks all skill workflows)
- Modifying agent detection logic in `init.ts` (wrong detection = wrong commands)
- Changes to auto-activation hook logic or trigger thresholds
- Changes to evolution-guard blocking conditions
- Changes to memory writer schema or file format

### Review Before Merge (Medium Risk)

- Adding new fields to JSONL output
- Modifying eval set generation logic in `hooks-to-evals.ts`
- Changing grading thresholds in `grade-session.ts`
- Adding new platform ingestors
- Updating ARCHITECTURE.md domain map
- Changing proposal generation prompts in `propose-description.ts`
- Modifying validation thresholds or regression tolerance in `validate-proposal.ts`
- Changing confidence thresholds or stopping criteria in `stopping-criteria.ts`
- Modifying deploy logic in `deploy-proposal.ts` (SKILL.md writes, PR creation)
- Changing regression detection thresholds in `watch.ts`
- Adding new workflow files to `skill/Workflows/`
- Modifying the SKILL.md routing table (affects which workflow agents load)
- Changing `computeStatus` logic in `status.ts` (affects skill health reporting)
- Changing `computeLastInsight` logic in `last.ts` (affects session insight accuracy)
- Modifying dashboard data schema in `dashboard.ts` (breaks `dashboard/index.html` rendering)
- Changing the `dashboard/index.html` embedded data contract (must match `dashboard.ts` output)
- Modifying activation rules configuration
- Changing agent assignment logic
- Updating dashboard server endpoints or action handlers

### Agent-Autonomous (Low Risk)

- Bug fixes within a single module
- Adding tests for existing functionality
- Documentation updates (non-architectural)
- Code style improvements
- Adding new eval queries to existing eval sets
- Updating evolution audit entry details text
- Adjusting monitoring window size defaults
- Updating agent markdown content
- Adjusting activation rule thresholds within existing schema
- Adding new entries to decisions.md

## Schema Change Protocol

Changes to the shared log schema require:

1. Update schema documentation in PRD.md appendix
2. Update all writers (hooks + ingestors)
3. Update all readers (eval + grading + evolution + monitoring + status + last + dashboard)
4. Run full test suite
5. Human review before merge

## Evolution Deploy Protocol

Deploying an evolution proposal requires:

1. Confidence above threshold (default 0.6)
2. Validation pass rate improvement with <5% regression
3. Audit entry written for every state change (created, validated, rejected, deployed)
4. Backup of original SKILL.md (`.bak` file)
5. PR created with diff, eval results, and rationale (when `--create-pr` enabled)
