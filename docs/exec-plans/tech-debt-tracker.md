<!-- Verified: 2026-02-28 -->

# Technical Debt Tracker

Track known technical debt with priority and ownership.

| ID | Description | Domain | Priority | Status | Created | Updated |
|----|-------------|--------|----------|--------|---------|---------|
| TD-001 | Add CI pipeline (pytest + lint_architecture.py) | Infra | High | Open | 2026-02-28 | 2026-02-28 |
| TD-002 | Schema validation for all JSONL writers | Telemetry | High | Open | 2026-02-28 | 2026-02-28 |
| TD-003 | Tests for hooks_to_evals.py | Eval | Medium | Open | 2026-02-28 | 2026-02-28 |
| TD-004 | Tests for grade_session.py | Grading | Medium | Open | 2026-02-28 | 2026-02-28 |
| TD-005 | Implement v0.3 Evolution module | Evolution | Low | Open | 2026-02-28 | 2026-02-28 |

## Priority Definitions

- **Critical**: Actively causing bugs or blocking features
- **High**: Will cause problems soon, should address this sprint
- **Medium**: Noticeable drag on velocity, schedule for cleanup
- **Low**: Minor annoyance, address opportunistically

## Process

1. New debt discovered → add row here
2. Background agents scan weekly for new debt
3. Cleanup PRs opened targeting highest priority items
4. Resolved debt marked as "Closed" with resolution date
