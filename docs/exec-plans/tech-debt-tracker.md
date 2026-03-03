<!-- Verified: 2026-03-03 -->

# Technical Debt Tracker

Track known technical debt with priority and ownership.

| ID | Description | Domain | Priority | Owner | Status | Created | Updated |
|----|-------------|--------|----------|-------|--------|---------|---------|
| TD-001 | Add CI pipeline (bun test + lint-architecture.ts) | Infra | High | — | Closed | 2026-02-28 | 2026-02-28 |
| TD-002 | Schema validation for all JSONL writers | Telemetry | High | — | Closed | 2026-02-28 | 2026-02-28 |
| TD-003 | Tests for hooks-to-evals.ts | Eval | Medium | — | Closed | 2026-02-28 | 2026-02-28 |
| TD-004 | Tests for grade-session.ts | Grading | Medium | — | Closed | 2026-02-28 | 2026-02-28 |
| TD-005 | Implement v0.3 Evolution module | Evolution | Low | — | Closed | 2026-02-28 | 2026-02-28 |
| TD-006 | Migrate Python to Bun/TypeScript | Infra | High | — | Closed | 2026-02-28 | 2026-02-28 |
| TD-007 | Wire deployProposal into evolve orchestrator. Note: module implementation (`deploy-proposal.ts`) is complete with tests, but is not yet imported/wired into `evolve.ts`. | Evolution | Medium | — | Open | 2026-02-28 | 2026-03-02 |
| TD-008 | End-to-end integration test with real LLM call | Evolution | Low | — | Open | 2026-02-28 | 2026-02-28 |
| TD-009 | Add evolution/monitoring to lint-architecture.ts import rules | Infra | Medium | — | Closed | 2026-02-28 | 2026-02-28 |
| TD-010 | `cli/selftune/utils/logging.ts` has no test file — violates golden-principles testing rule | Testing | Medium | — | Open | 2026-03-01 | 2026-03-01 |
| TD-011 | `cli/selftune/utils/seeded-random.ts` has no test file — violates golden-principles testing rule | Testing | Medium | — | Open | 2026-03-01 | 2026-03-01 |
| TD-012 | Dashboard server test (`tests/dashboard/dashboard-server.test.ts`) is flaky — `GET /api/events` sends initial data event fails intermittently with `null` response | Testing | Medium | — | Open | 2026-03-03 | 2026-03-03 |

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
