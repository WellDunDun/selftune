# Historical Observability Backfill Evidence

**Issue:** #189

**Captured:** 2026-07-23

**Status:** accepted — the full-corpus 10x acceptance run and representative
10x run both passed on schema v9.

## Safety boundary

The live local source database was opened read-only. The verification process
projects only content-free canonical metadata into isolated temporary databases:
identifiers, timestamps, platform, scalar execution facts, and explicit skill
references. It does not copy prompt text, transcript content, tool payloads, or
workspace paths.

DuckDB receives rebuildable analytical facts. SQLite retains the operational
checkpoints. A checkpoint is acknowledged only after the DuckDB receipt exists.

## Verified live 1x result

The full local source corpus contained 127,397 canonical metadata rows:

| Domain | Rows |
| --- | ---: |
| Sessions | 11,228 |
| Prompts | 21,332 |
| Skill invocations | 7,669 |
| Execution facts | 87,168 |

The four supported platforms were present in that source: Claude Code (8,829
sessions), Codex (2,025), OpenCode (355), and Pi (17). OpenClaw is deliberately
withheld from this backfill path.

| Run | Wall time | Facts visited | Process RSS |
| --- | ---: | ---: | ---: |
| Cold import | 64.431 s | 127,397 | 537.4 MB |
| Replay | 42.715 s | 127,397 | 537.4 MB |

The resulting DuckDB corpus held 8,803 spans, 115,885 metadata logs, 359,493
historical metric points, and 7,668 explicit log-to-skill links. The 1x run
verified crash recovery after the DuckDB receipt, idempotent replay,
per-domain checkpoints, four-platform import, source-exact historical metrics,
non-summed cumulative rollups, and retained provenance.

`process_rss_bytes` is process-wide: it includes Bun, Effect, and DuckDB. The
DuckDB Node API does not expose a per-engine RSS measurement, so this evidence
does not claim a separate DuckDB memory number. The 512 MB DuckDB buffer limit
is not a process-RSS cap.

## Verified representative 10x result

A representative four-platform corpus was exercised at 10x with 619 sessions,
1,125 prompts, 945 skill invocations, and 10,000 execution facts. OpenClaw was
again withheld by design.

| Run | Wall time | Facts visited | Process RSS |
| --- | ---: | ---: | ---: |
| Cold import | 7.652 s | 12,689 | 406.6 MB |
| Replay | 5.170 s | 12,689 | 410.5 MB |
| Steady resume | 9 ms | 0 | 411.5 MB |

This corpus produced 396 spans, 12,068 metadata logs, 44,310 historical metric
points, and 944 log-to-skill links. The bounded compatibility-reader parity
check compared 64 rows and matched all 64; the page was fresh and the current
checkpoint was observed. Canonical prompt, invocation, execution-fact, and
session identifiers were retained where those source facts exist.

Compatibility readers remain in place for rollback. Their known limits are
explicit: they do not expose skill-to-point correlation or trace identity. This
slice does not remove those readers.

## Verified full-corpus 10x result

The full local corpus was exercised at 10x on schema v9. It contained 11,229
sessions, 21,333 prompts, 7,671 skill invocations, and 871,720 execution facts.
The run visited 911,953 facts.

| Run | Wall time | Facts visited | Process RSS |
| --- | ---: | ---: | ---: |
| Cold import | 688.655 s | 911,953 | 1.301 GB |
| Forced replay | 401.147 s | 911,953 | 443.1 MB |
| Steady resume | 11 ms | 0 | 674.3 MB |

The resulting DuckDB corpus held 8,803 spans, 897,902 metadata logs, 3,595,130
historical metric points, and 7,670 explicit log-to-skill links. Its file size
plateaued at 1.5 GB. The reader-parity check compared 64 rows and matched all
64; it was fresh, observed the current checkpoint, had no mismatches, and
remains rollback-safe. All 11 acceptance checks passed.

The full drain is an offline acceptance-runner worst case. The Desktop runtime
does not perform that unbounded drain in one sync: it executes at most 32
bounded historical-backfill pages per sync.

## Reproduction and checks

- [Verification runner](../../../scripts/verify-historical-backfill.ts) opens
  the live source read-only and emits aggregate JSON evidence.
- [Historical adapter and importer tests](../../../tests/observability/historical-backfill.test.ts)
  cover metadata-only projection and analytical records.
- [Orchestration backfill tests](../../../tests/orchestration/historical-backfill.test.ts)
  cover receipt-before-checkpoint, replay, and checkpoint behavior.
- [Reader-parity tests](../../../tests/observability/reader-parity.test.ts)
  cover bounded compatibility comparisons and their declared limits.

## Scope boundary

Repository cutover #172 is not part of this slice. It remains gated behind the
completed historical-backfill acceptance work. The preceding OTLP and
asynchronous cloud-export slices are already complete; this evidence unblocks,
but does not itself perform, the repository cutover.
