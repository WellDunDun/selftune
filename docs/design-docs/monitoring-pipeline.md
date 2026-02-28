<!-- Verified: 2026-02-28 -->

# Monitoring Pipeline Design

How selftune monitors evolved skills for post-deploy regressions.

## Overview

After deploying an improved SKILL.md, the monitoring pipeline watches subsequent sessions to confirm the improvement holds. If pass rate drops below the baseline minus a threshold, it raises an alert and optionally auto-rollbacks.

## Architecture

```
Read Logs → Window to Recent Sessions → Compute Snapshot → Detect Regression → Alert/Rollback
```

### Core Function: `computeMonitoringSnapshot`

Pure function that takes raw log records and produces a `MonitoringSnapshot`. No side effects, fully deterministic for a given input.

**Inputs:**
- `skillName` — skill to monitor
- `telemetry` — session telemetry records
- `skillRecords` — skill usage records
- `queryRecords` — query log records
- `windowSessions` — max recent sessions to consider
- `baselinePassRate` — from last deployed audit entry
- `regressionThreshold` — drop below baseline minus this triggers regression

**Algorithm:**
1. Window telemetry to last N sessions (by array order, assumed chronological)
2. Filter skill records by skill name
3. Apply session ID windowing (if telemetry overlaps with skill/query records)
4. Compute pass rate: `triggered_count / total_query_count`
5. Compute false negative rate from skill usage records
6. Break down by invocation type
7. Regression detection: `pass_rate < baseline - threshold` (with floating-point rounding)

### `watch` Function

Reads real log files, computes snapshot, and acts on results:

1. Read telemetry, skill usage, and query logs from `~/.claude/`
2. Determine baseline pass rate from last deployed audit entry
3. Compute monitoring snapshot
4. If regression detected:
   - Build alert message with pass rate, baseline, and threshold
   - If `--auto-rollback`: execute rollback
   - Otherwise: recommend manual rollback command
5. If stable: report pass rate within acceptable range

### Dependency Injection

The `watch()` function accepts injectable paths and rollback function via `WatchOptions`:

- `_telemetryLogPath`, `_skillLogPath`, `_queryLogPath` — override default log paths
- `_auditLogPath` — override audit trail path
- `_rollbackFn` — inject mock rollback for testing

In production, defaults to real file paths and lazy-loads `rollback.ts`.

## Regression Detection

Uses floating-point-safe comparison:

```
adjusted_threshold = round((baseline - regression_threshold) * 1e10) / 1e10
rounded_pass_rate = round(pass_rate * 1e10) / 1e10
regression_detected = rounded_pass_rate < adjusted_threshold
```

This avoids boundary issues like `0.8 - 0.1 = 0.7000000000000001`.

## MonitoringSnapshot Schema

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO 8601 |
| `skill_name` | string | Monitored skill |
| `window_sessions` | number | Sessions in window |
| `pass_rate` | number | Current pass rate |
| `false_negative_rate` | number | Miss rate within skill checks |
| `by_invocation_type` | object | Breakdown by explicit/implicit/contextual/negative |
| `regression_detected` | boolean | Whether pass rate dropped below threshold |
| `baseline_pass_rate` | number | From last deployed audit entry |

## WatchResult Schema

| Field | Type | Description |
|-------|------|-------------|
| `snapshot` | MonitoringSnapshot | Computed snapshot |
| `alert` | string or null | Regression alert message |
| `rolledBack` | boolean | Whether auto-rollback executed |
| `recommendation` | string | Human-readable next step |

## Files

| File | Responsibility |
|------|---------------|
| `monitoring/watch.ts` | Snapshot computation, log reading, regression detection, auto-rollback |
