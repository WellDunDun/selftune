<!-- Verified: 2026-03-27 -->

# Technical Debt Tracker

Track known technical debt with priority and ownership.

| ID     | Description                                                                                                                                                                                                              | Domain    | Priority | Owner | Status | Created    | Updated    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------- | ----- | ------ | ---------- | ---------- |
| TD-001 | Add CI pipeline (bun test + lint-architecture.ts)                                                                                                                                                                        | Infra     | High     | —     | Closed | 2026-02-28 | 2026-02-28 |
| TD-002 | Schema validation for all JSONL writers                                                                                                                                                                                  | Telemetry | High     | —     | Closed | 2026-02-28 | 2026-02-28 |
| TD-003 | Tests for hooks-to-evals.ts                                                                                                                                                                                              | Eval      | Medium   | —     | Closed | 2026-02-28 | 2026-02-28 |
| TD-004 | Tests for grade-session.ts                                                                                                                                                                                               | Grading   | Medium   | —     | Closed | 2026-02-28 | 2026-02-28 |
| TD-005 | Implement v0.3 Evolution module                                                                                                                                                                                          | Evolution | Low      | —     | Closed | 2026-02-28 | 2026-02-28 |
| TD-006 | Migrate Python to Bun/TypeScript                                                                                                                                                                                         | Infra     | High     | —     | Closed | 2026-02-28 | 2026-02-28 |
| TD-007 | Wire deployProposal into evolve orchestrator. Resolved: git/gh PR path removed — evolution is local personalization, not upstream contribution. `evolve.ts` writes SKILL.md directly.                                    | Evolution | Medium   | —     | Closed | 2026-02-28 | 2026-03-27 |
| TD-008 | End-to-end integration test with real LLM call                                                                                                                                                                           | Evolution | Low      | —     | Open   | 2026-02-28 | 2026-02-28 |
| TD-009 | Add evolution/monitoring to lint-architecture.ts import rules                                                                                                                                                            | Infra     | Medium   | —     | Closed | 2026-02-28 | 2026-02-28 |
| TD-010 | `cli/selftune/utils/logging.ts` has no test file — violates golden-principles testing rule                                                                                                                               | Testing   | Medium   | —     | Open   | 2026-03-01 | 2026-03-01 |
| TD-011 | `cli/selftune/utils/seeded-random.ts` has no test file — violates golden-principles testing rule                                                                                                                         | Testing   | Medium   | —     | Open   | 2026-03-01 | 2026-03-01 |
| TD-012 | Dashboard server test (`tests/dashboard/dashboard-server.test.ts`) was flaky around legacy SSE `/api/events` behavior                                                                                                    | Testing   | Medium   | —     | Closed | 2026-03-03 | 2026-03-14 |
| TD-013 | Migrate badge/report endpoints (`/badge/:name`, `/report/:name`) from JSONL status path to SQLite-backed queries                                                                                                         | Dashboard | Low      | —     | Open   | 2026-03-17 | 2026-03-17 |
| TD-014 | Add `regression_detected` column to SQLite skill summaries — `deriveStatus()` currently uses only pass rate + check count                                                                                                | Dashboard | Medium   | —     | Open   | 2026-03-17 | 2026-03-17 |
| TD-015 | Move `computeMonitoringSnapshot()` logic into SQLite materializer or query helper                                                                                                                                        | Dashboard | Medium   | —     | Open   | 2026-03-17 | 2026-03-17 |
| TD-016 | Wire SPA action buttons (watch/evolve/rollback) to `/api/actions/*` endpoints                                                                                                                                            | Dashboard | Medium   | —     | Open   | 2026-03-17 | 2026-03-17 |
| TD-017 | `readJsonl` fallback still exists in some modules for test paths — should migrate tests to use `_setTestDb()` injection pattern. Resolved: Phase 3 JSONL writes removed; remaining reads are materializer/recovery only. | Testing   | Medium   | —     | Closed | 2026-03-17 | 2026-03-27 |
| TD-018 | `contribute/bundle.ts` still has JSONL fallback for custom paths — should use SQLite exclusively. Resolved: Phase 3 JSONL writes removed; contribute reads from SQLite.                                                  | Data      | Medium   | —     | Closed | 2026-03-17 | 2026-03-27 |
| TD-019 | Upstream feedback channel: let skill end-users send anonymized evolution signal (e.g. failure patterns, trigger gaps) back to skill creators without leaking personalized descriptions                                   | Evolution | Low      | —     | Open   | 2026-03-27 | 2026-03-27 |
| TD-020 | LaunchAgent plists use bare `selftune` command — launchd's minimal PATH causes all scheduled jobs to fail silently                                                                                                       | Infra     | Critical | —     | Closed | 2026-03-27 | 2026-03-27 |
| TD-021 | `orchestrate` skips eligible skills after fresh ingest — no auto-grade step existed for UNGRADED skills with non-zero checks                                                                                             | Evolution | High     | —     | Closed | 2026-03-27 | 2026-03-27 |

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
